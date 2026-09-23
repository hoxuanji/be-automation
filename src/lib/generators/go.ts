import type { Endpoint, Entity, FieldType, GeneratedFile, StackConfig } from "./types";
import { safeName, toPascal, toKebab, toSnake } from "./types";
import { goGrpcFiles } from "./grpc/go";
import { goGraphqlFiles } from "./graphql/go";
import { isGraphqlSupported } from "./types";
import { authProviderSpec } from "./auth/providers";
import { goApiHandlersFile, goHandlerMethodName } from "./patterns/go";

export function goFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  // gRPC mode swaps the HTTP framework bootstrap for a pure gRPC server.
  // Keep the Dockerfile + shared helpers; replace the cmd / internal/server
  // output with the gRPC tree.
  if (config.api === "grpc") {
    const files: GeneratedFile[] = [];
    files.push({ path: "Dockerfile", content: goDockerfile() });
    files.push({ path: "internal/config/config.go", content: goConfig() });
    files.push(...goGrpcFiles(config, entities));
    return files;
  }

  // GraphQL replaces the HTTP server with a gqlgen-driven /graphql route.
  // Same structure as gRPC: keep the language-shared files, swap the entry.
  if (config.api === "graphql" && isGraphqlSupported(config.language)) {
    const files: GeneratedFile[] = [];
    files.push({ path: "Dockerfile", content: goDockerfile() });
    files.push({ path: "internal/config/config.go", content: goConfig() });
    files.push(...goGraphqlFiles(config, entities));
    return files;
  }

  const module = `github.com/your-username/${safeName(config.name)}`;
  const fw = (["gin", "fiber", "echo", "chi"].includes(config.framework) ? config.framework : "gin") as GoFw;
  const files: GeneratedFile[] = [];
  const authMode = goAuthMode(config, endpoints);
  const withAuth = authMode !== "off";
  const hasPatterns = endpoints.some((e) => e.pattern);
  const api = hasPatterns ? goApiHandlersFile(fw, config, endpoints, entities) : null;

  const kind = goDbKind(config.database);
  const isSQL = kind === "postgres" || kind === "mysql" || kind === "sqlite";
  const needsGorm = isSQL && (entities.length > 0 || !!api?.usesDb);
  const docStore = !isSQL && entities.length > 0;
  const withRedis = /redis|upstash|dragonfly/.test(config.cache);
  const withTracing = config.tracing || config.monitoring === "otel";
  const monitoring: GoMonitoring =
    /prometheus|grafana/.test(config.monitoring) ? "prometheus"
    : /sentry/.test(config.monitoring) ? "sentry"
    : /datadog/.test(config.monitoring) ? "datadog"
    : "none";

  const deps: GoDeps = { fw, kind, isSQL, needsGorm, docStore, withRedis, withTracing, monitoring, api };

  files.push({ path: "Dockerfile", content: goDockerfile() });
  files.push({ path: "cmd/api/main.go", content: goMain(module) });
  files.push({ path: "internal/config/config.go", content: goConfig(kind === "mongo") });
  files.push({ path: "internal/server/server.go", content: goServer(module, config, endpoints, entities, deps) });
  files.push({ path: "internal/server/middleware.go", content: goMiddleware(config, module, withAuth) });
  files.push({ path: "internal/server/health.go", content: goHealth(fw) });

  if (config.rateLimit) {
    files.push({ path: "internal/server/ratelimit.go", content: goRateLimit(fw) });
    files.push({ path: "internal/server/ratelimit_test.go", content: goRateLimitTest() });
  }
  if (withTracing) {
    files.push({ path: "internal/tracing/tracing.go", content: goTracing(fw) });
  }

  if (withAuth) {
    files.push({ path: "internal/auth/jwt.go", content: authMode === "hs256" ? goAuthHS256() : goAuthJwt() });
  }

  if (kind === "postgres" || kind === "mysql") {
    files.push({ path: "internal/db/sql.go", content: goSQLDB(config.database, kind) });
  }
  if (needsGorm) {
    files.push({ path: "internal/db/gorm.go", content: goGormDB(kind) });
  }
  if (kind === "mongo") {
    files.push({ path: "internal/db/mongo.go", content: goMongoStore() });
  }
  if (kind === "mongo" || docStore) {
    files.push({ path: "internal/db/docstore.go", content: goDocStore(config.database, kind) });
  }

  if (entities.length > 0) {
    if (docStore) {
      files.push({ path: "internal/handlers/docstore.go", content: goDocHandlerHelpers(module, fw) });
    } else {
      files.push({ path: "internal/models/models.go", content: goModels(module, entities) });
    }
    for (const entity of entities) {
      files.push({
        path: `internal/handlers/${toSnake(entity.name)}.go`,
        content: docStore ? goDocEntityHandler(module, fw, entity) : goEntityHandler(module, fw, entity),
      });
      files.push({
        path: `internal/handlers/${toSnake(entity.name)}_test.go`,
        content: docStore ? goDocEntityTest(module, fw, entity) : goEntityTest(module, fw, entity),
      });
    }
  }

  // Pattern-based API handlers (custom endpoints from API builder)
  if (api) files.push(api.file);

  if (withRedis) {
    files.push({ path: "internal/cache/redis.go", content: goRedis() });
  }

  if (monitoring === "prometheus") {
    files.push({ path: "internal/monitoring/metrics.go", content: goPrometheusMetrics(fw) });
  } else if (monitoring === "sentry") {
    files.push({ path: "internal/monitoring/sentry.go", content: goSentryInit(fw) });
  } else if (monitoring === "datadog") {
    files.push({ path: "internal/monitoring/datadog.go", content: goDatadogInit(fw) });
  }

  // go.mod is derived from what the emitted code actually imports, so it can
  // never drift from the source (missing or unused requirements).
  // cmd/migrate is emitted later by db/migrations.ts (SQL stacks with entities)
  // and imports golang-migrate, so require it here too.
  const migrations = entities.length > 0 && !/mongo|dynamo|redis/i.test(config.database);
  files.push({ path: "go.mod", content: goMod(module, files, migrations ? ["github.com/golang-migrate/migrate/v4"] : []) });

  return files;
}

type GoFw = "gin" | "fiber" | "echo" | "chi";

// How authRequired verifies bearer tokens (see patterns/go.ts patternBody):
//   jwks  — external provider configured: verify provider tokens via JWKS.
//   hs256 — auth "none" but auth_* patterns are used: the service issues its
//           own HS256 tokens (JWT_SECRET) and verifies exactly those.
//   off   — nothing to verify; authRequired is a pass-through.
export function goAuthMode(config: StackConfig, endpoints: Endpoint[]): "jwks" | "hs256" | "off" {
  const authPatterns = endpoints.some((e) => e.pattern?.startsWith("auth_"));
  if (authProviderSpec(config)) return endpoints.some((e) => e.auth) || authPatterns ? "jwks" : "off";
  return authPatterns ? "hs256" : "off";
}
type GoDbKind = "postgres" | "mysql" | "sqlite" | "mongo" | "memory" | "none";
type GoMonitoring = "prometheus" | "sentry" | "datadog" | "none";
type GoDeps = {
  fw: GoFw;
  kind: GoDbKind;
  isSQL: boolean;
  needsGorm: boolean;
  docStore: boolean;
  withRedis: boolean;
  withTracing: boolean;
  monitoring: GoMonitoring;
  api: { usesDb: boolean; usesRdb: boolean } | null;
};

export function goDbKind(database: string): GoDbKind {
  if (/postgres|neon|supabase|cockroach/.test(database)) return "postgres";
  if (/mysql|planetscale/.test(database)) return "mysql";
  if (database === "sqlite") return "sqlite";
  if (database === "mongodb") return "mongo";
  if (database && database !== "none") return "memory"; // dynamodb etc. — no generated repository
  return "none";
}

const fwImport: Record<GoFw, string> = {
  gin: "github.com/gin-gonic/gin",
  fiber: "github.com/gofiber/fiber/v2",
  echo: "github.com/labstack/echo/v4",
  chi: "github.com/go-chi/chi/v5",
};

// Builds a Go import block from the packages the code actually references
// (`name.` selector). `pkgs` maps the local package name to its import path;
// an alias is emitted when the name differs from the path's last element.
function goImports(code: string, std: [string, string][], ext: [string, string][]): string {
  const pick = (list: [string, string][]) =>
    list
      .filter(([name]) => new RegExp(`\\b${name}\\.`).test(code))
      .map(([name, path]) => {
        const last = path.split("/").pop()!.replace(/^v\d+$/, "");
        const natural = last === "" ? path.split("/").slice(-2)[0] : last;
        return natural === name ? `\t"${path}"` : `\t${name} "${path}"`;
      })
      .sort((a, b) => a.replace(/^\t\w+ /, "\t").localeCompare(b.replace(/^\t\w+ /, "\t")));
  const groups = [pick(std), pick(ext)].filter((g) => g.length > 0).map((g) => g.join("\n"));
  return `import (\n${groups.join("\n\n")}\n)`;
}

function goPrometheusMetrics(fw: GoFw): string {
  const mount: Record<GoFw, string> = {
    gin: `func MountMetrics(r *gin.Engine) {\n\tr.GET("/metrics", gin.WrapH(promhttp.Handler()))\n}`,
    fiber: `func MountMetrics(r *fiber.App) {\n\tr.Get("/metrics", adaptor.HTTPHandler(promhttp.Handler()))\n}`,
    echo: `func MountMetrics(r *echo.Echo) {\n\tr.GET("/metrics", echo.WrapHandler(promhttp.Handler()))\n}`,
    chi: `func MountMetrics(r chi.Router) {\n\tr.Handle("/metrics", promhttp.Handler())\n}`,
  };
  const code = `// MountMetrics exposes the Prometheus /metrics endpoint (Go runtime and
// process collectors from the default registry). Called from server.New.
${mount[fw]}
`;
  return `package monitoring

${goImports(code, [], [
    [fw, fwImport[fw]],
    ["adaptor", "github.com/gofiber/fiber/v2/middleware/adaptor"],
    ["promhttp", "github.com/prometheus/client_golang/prometheus/promhttp"],
  ])}

${code}`;
}

function goSentryInit(fw: GoFw): string {
  const mw: Record<GoFw, string> = {
    gin: `func SentryMiddleware() gin.HandlerFunc {\n\treturn sentrygin.New(sentrygin.Options{Repanic: true})\n}`,
    fiber: `func SentryMiddleware() fiber.Handler {\n\treturn sentryfiber.New(sentryfiber.Options{Repanic: true})\n}`,
    echo: `func SentryMiddleware() echo.MiddlewareFunc {\n\treturn sentryecho.New(sentryecho.Options{Repanic: true})\n}`,
    chi: `func SentryMiddleware() func(http.Handler) http.Handler {\n\treturn sentryhttp.New(sentryhttp.Options{Repanic: true}).Handle\n}`,
  };
  const integration: Record<GoFw, [string, string]> = {
    gin: ["sentrygin", "github.com/getsentry/sentry-go/gin"],
    fiber: ["sentryfiber", "github.com/getsentry/sentry-go/fiber"],
    echo: ["sentryecho", "github.com/getsentry/sentry-go/echo"],
    chi: ["sentryhttp", "github.com/getsentry/sentry-go/http"],
  };
  const code = `// InitSentry initialises the Sentry SDK from SENTRY_DSN (an empty DSN turns
// the SDK into a no-op). The returned func flushes buffered events on shutdown.
func InitSentry(log *slog.Logger) func(context.Context) error {
\tif err := sentry.Init(sentry.ClientOptions{
\t\tDsn:              os.Getenv("SENTRY_DSN"),
\t\tTracesSampleRate: 0.1,
\t}); err != nil {
\t\tlog.Warn("sentry init failed", "err", err)
\t}
\treturn func(context.Context) error {
\t\tsentry.Flush(2 * time.Second)
\t\treturn nil
\t}
}

// SentryMiddleware captures panics and attaches a per-request hub. Repanic
// hands the panic on to the server's recoverer after it is reported.
${mw[fw]}
`;
  return `package monitoring

${goImports(code, [["context", "context"], ["slog", "log/slog"], ["http", "net/http"], ["os", "os"], ["time", "time"]], [
    [fw, fwImport[fw]],
    ["sentry", "github.com/getsentry/sentry-go"],
    integration[fw],
  ])}

${code}`;
}

function goDatadogInit(fw: GoFw): string {
  const mw: Record<GoFw, [string, string, string]> = {
    gin: ["gintrace", "gopkg.in/DataDog/dd-trace-go.v1/contrib/gin-gonic/gin", `func DatadogMiddleware(service string) gin.HandlerFunc {\n\treturn gintrace.Middleware(service)\n}`],
    fiber: ["fibertrace", "gopkg.in/DataDog/dd-trace-go.v1/contrib/gofiber/fiber.v2", `func DatadogMiddleware(service string) fiber.Handler {\n\treturn fibertrace.Middleware(fibertrace.WithServiceName(service))\n}`],
    echo: ["echotrace", "gopkg.in/DataDog/dd-trace-go.v1/contrib/labstack/echo.v4", `func DatadogMiddleware(service string) echo.MiddlewareFunc {\n\treturn echotrace.Middleware(echotrace.WithServiceName(service))\n}`],
    chi: ["chitrace", "gopkg.in/DataDog/dd-trace-go.v1/contrib/go-chi/chi.v5", `func DatadogMiddleware(service string) func(http.Handler) http.Handler {\n\treturn chitrace.Middleware(chitrace.WithServiceName(service))\n}`],
  };
  const code = `// InitDatadog starts the Datadog APM tracer (agent address from DD_AGENT_HOST /
// DD_TRACE_AGENT_URL, environment from DD_ENV). The returned func stops it,
// flushing pending spans.
func InitDatadog(service string, log *slog.Logger) func(context.Context) error {
\ttracer.Start(tracer.WithService(service))
\tlog.Info("datadog tracer started", "service", service)
\treturn func(context.Context) error {
\t\ttracer.Stop()
\t\treturn nil
\t}
}

// DatadogMiddleware creates one APM span per request.
${mw[fw][2]}
`;
  return `package monitoring

${goImports(code, [["context", "context"], ["slog", "log/slog"], ["http", "net/http"]], [
    [fw, fwImport[fw]],
    ["tracer", "gopkg.in/DataDog/dd-trace-go.v1/ddtrace/tracer"],
    [mw[fw][0], mw[fw][1]],
  ])}

${code}`;
}

function goTracing(fw: GoFw): string {
  const mw: Record<GoFw, string> = {
    gin: `// Middleware starts a server span per request (otelgin).
func Middleware(service string) gin.HandlerFunc {\n\treturn otelgin.Middleware(service)\n}`,
    echo: `// Middleware starts a server span per request (otelecho).
func Middleware(service string) echo.MiddlewareFunc {\n\treturn otelecho.Middleware(service)\n}`,
    chi: `// Middleware starts a server span per request (otelhttp).
func Middleware(service string) func(http.Handler) http.Handler {\n\treturn otelhttp.NewMiddleware(service)\n}`,
    // ponytail: hand-rolled instead of github.com/gofiber/contrib/otelfiber to avoid pinning a
    // second fiber/otel version matrix; swap it in if you need its extra attributes.
    fiber: `// Middleware starts a server span per request, continuing any incoming W3C
// trace context, and stores the span context in c.UserContext() so handlers
// and DB calls made with that context become child spans.
func Middleware(service string) fiber.Handler {
\ttr := otel.Tracer(service)
\treturn func(c *fiber.Ctx) error {
\t\tcarrier := propagation.HeaderCarrier{}
\t\tc.Request().Header.VisitAll(func(k, v []byte) { carrier.Set(string(k), string(v)) })
\t\tctx := otel.GetTextMapPropagator().Extract(c.UserContext(), carrier)
\t\tctx, span := tr.Start(ctx, c.Method(), trace.WithSpanKind(trace.SpanKindServer))
\t\tdefer span.End()
\t\tc.SetUserContext(ctx)

\t\terr := c.Next()
\t\tstatus := c.Response().StatusCode()
\t\tspan.SetName(c.Method() + " " + c.Route().Path)
\t\tspan.SetAttributes(
\t\t\tattribute.String("http.request.method", c.Method()),
\t\t\tattribute.String("http.route", c.Route().Path),
\t\t\tattribute.Int("http.response.status_code", status),
\t\t)
\t\tif err != nil || status >= 500 {
\t\t\tspan.SetStatus(codes.Error, http.StatusText(status))
\t\t}
\t\treturn err
\t}
}`,
  };
  const code = `// Init installs a global OpenTelemetry tracer provider that exports spans over
// OTLP/HTTP. The exporter reads the standard env vars
// (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, ...); when no
// endpoint is set tracing stays a no-op. The returned func flushes and stops
// the provider on shutdown.
func Init(ctx context.Context, service string) (func(context.Context) error, error) {
\tif os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") == "" {
\t\treturn func(context.Context) error { return nil }, errors.New("OTEL_EXPORTER_OTLP_ENDPOINT not set")
\t}
\texp, err := otlptracehttp.New(ctx)
\tif err != nil {
\t\treturn nil, err
\t}
\t// OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES (WithFromEnv) override the default name.
\tres, err := resource.New(ctx,
\t\tresource.WithAttributes(attribute.String("service.name", service)),
\t\tresource.WithFromEnv(),
\t\tresource.WithTelemetrySDK(),
\t)
\tif err != nil {
\t\treturn nil, err
\t}
\ttp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
\totel.SetTracerProvider(tp)
\totel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
\treturn tp.Shutdown, nil
}

${mw[fw]}
`;
  return `// Package tracing wires OpenTelemetry: provider setup plus the HTTP middleware.
package tracing

${goImports(code, [["context", "context"], ["errors", "errors"], ["http", "net/http"], ["os", "os"]], [
    [fw, fwImport[fw]],
    ["otel", "go.opentelemetry.io/otel"],
    ["attribute", "go.opentelemetry.io/otel/attribute"],
    ["codes", "go.opentelemetry.io/otel/codes"],
    ["otlptracehttp", "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"],
    ["propagation", "go.opentelemetry.io/otel/propagation"],
    ["resource", "go.opentelemetry.io/otel/sdk/resource"],
    ["sdktrace", "go.opentelemetry.io/otel/sdk/trace"],
    ["trace", "go.opentelemetry.io/otel/trace"],
    ["otelgin", "go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"],
    ["otelecho", "go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho"],
    ["otelhttp", "go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"],
  ])}

${code}`;
}

function goRateLimit(fw: GoFw): string {
  const mw: Record<GoFw, string> = {
    gin: `func rateLimit() gin.HandlerFunc {
\tl := newIPLimiter()
\treturn func(c *gin.Context) {
\t\tif !l.allow(c.ClientIP()) {
\t\t\tc.Header("Retry-After", "1")
\t\t\tc.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate_limited"})
\t\t\treturn
\t\t}
\t\tc.Next()
\t}
}`,
    fiber: `func rateLimit() fiber.Handler {
\tl := newIPLimiter()
\treturn func(c *fiber.Ctx) error {
\t\tif !l.allow(c.IP()) {
\t\t\tc.Set("Retry-After", "1")
\t\t\treturn c.Status(http.StatusTooManyRequests).JSON(fiber.Map{"error": "rate_limited"})
\t\t}
\t\treturn c.Next()
\t}
}`,
    echo: `func rateLimit() echo.MiddlewareFunc {
\tl := newIPLimiter()
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) error {
\t\t\tif !l.allow(c.RealIP()) {
\t\t\t\tc.Response().Header().Set("Retry-After", "1")
\t\t\t\treturn c.JSON(http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
\t\t\t}
\t\t\treturn next(c)
\t\t}
\t}
}`,
    chi: `func rateLimit() func(http.Handler) http.Handler {
\tl := newIPLimiter()
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tip, _, err := net.SplitHostPort(r.RemoteAddr)
\t\t\tif err != nil {
\t\t\t\tip = r.RemoteAddr
\t\t\t}
\t\t\tif !l.allow(ip) {
\t\t\t\tw.Header().Set("Retry-After", "1")
\t\t\t\twriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"})
\t\t\t\treturn
\t\t\t}
\t\t\tnext.ServeHTTP(w, r)
\t\t})
\t}
}`,
  };
  const code = `// ponytail: per-instance, in-memory token bucket keyed by client IP. With N
// replicas a client effectively gets N x the budget and state resets on
// restart — move the buckets to Redis (e.g. github.com/go-redis/redis_rate)
// when you need one global limit.
const (
\trateLimitRPS   = 10 // sustained requests per second per client IP
\trateLimitBurst = 20 // short bursts allowed above the sustained rate
\t// ponytail: the table is dropped wholesale when full; an LRU would keep hot clients.
\tmaxTrackedIPs = 100_000
)

type ipLimiter struct {
\tmu      sync.Mutex
\tclients map[string]*rate.Limiter
}

func newIPLimiter() *ipLimiter { return &ipLimiter{clients: map[string]*rate.Limiter{}} }

func (l *ipLimiter) allow(ip string) bool {
\tl.mu.Lock()
\tdefer l.mu.Unlock()
\tlim, ok := l.clients[ip]
\tif !ok {
\t\tif len(l.clients) >= maxTrackedIPs {
\t\t\tclear(l.clients)
\t\t}
\t\tlim = rate.NewLimiter(rateLimitRPS, rateLimitBurst)
\t\tl.clients[ip] = lim
\t}
\treturn lim.Allow()
}

${mw[fw]}
`;
  return `package server

${goImports(code, [["net", "net"], ["http", "net/http"], ["sync", "sync"]], [
    [fw, fwImport[fw]],
    ["rate", "golang.org/x/time/rate"],
  ])}

${code}`;
}

function goRateLimitTest(): string {
  return `package server

import "testing"

// A client may burst up to rateLimitBurst requests, is then throttled, and
// never consumes another client's budget.
func TestIPLimiter(t *testing.T) {
\tl := newIPLimiter()
\tfor i := 0; i < rateLimitBurst; i++ {
\t\tif !l.allow("10.0.0.1") {
\t\t\tt.Fatalf("request %d within the burst was rejected", i+1)
\t\t}
\t}
\tif l.allow("10.0.0.1") {
\t\tt.Fatal("request beyond the burst was allowed")
\t}
\tif !l.allow("10.0.0.2") {
\t\tt.Fatal("a different client must have its own bucket")
\t}
}
`;
}

// Document store used by entity handlers when the database is not SQL.
// MongoDB gets a real repository (mongo.go); anything else falls back to the
// in-memory store, which is also what the handler tests run against.
function goDocStore(database: string, kind: GoDbKind): string {
  const memoryNote = kind === "memory"
    ? `
//
// ponytail: this is also the runtime store for "${database}" — no ${database}
// repository is generated, so data lives in process memory, is lost on
// restart and is not shared across replicas. Implement DocStore against the
// real ${database} SDK before production.`
    : "";
  return `package db

import (
\t"context"
\t"errors"
\t"maps"
\t"sync"

\t"github.com/google/uuid"
)

// ErrNotFound is returned when no document has the requested id.
var ErrNotFound = errors.New("not found")

// DocStore is the persistence seam the entity handlers use. Documents are
// JSON-shaped maps keyed by a string "id" (a UUID when the client omits it).
type DocStore interface {
\tList(ctx context.Context, coll string) ([]map[string]any, error)
\tGet(ctx context.Context, coll, id string) (map[string]any, error)
\tCreate(ctx context.Context, coll string, doc map[string]any) (map[string]any, error)
\tUpdate(ctx context.Context, coll, id string, patch map[string]any) (map[string]any, error)
\tDelete(ctx context.Context, coll, id string) error
\tPing(ctx context.Context) error
\tClose(ctx context.Context) error
}

// MemoryStore is a goroutine-safe in-process DocStore used by handler tests.${memoryNote}
type MemoryStore struct {
\tmu    sync.RWMutex
\tcolls map[string]map[string]map[string]any
}

func NewMemoryStore() *MemoryStore {
\treturn &MemoryStore{colls: map[string]map[string]map[string]any{}}
}

func (m *MemoryStore) List(_ context.Context, coll string) ([]map[string]any, error) {
\tm.mu.RLock()
\tdefer m.mu.RUnlock()
\tout := make([]map[string]any, 0, len(m.colls[coll]))
\tfor _, d := range m.colls[coll] {
\t\tout = append(out, maps.Clone(d))
\t}
\treturn out, nil
}

func (m *MemoryStore) Get(_ context.Context, coll, id string) (map[string]any, error) {
\tm.mu.RLock()
\tdefer m.mu.RUnlock()
\td, ok := m.colls[coll][id]
\tif !ok {
\t\treturn nil, ErrNotFound
\t}
\treturn maps.Clone(d), nil
}

func (m *MemoryStore) Create(_ context.Context, coll string, doc map[string]any) (map[string]any, error) {
\td := maps.Clone(doc)
\tif d == nil {
\t\td = map[string]any{}
\t}
\tid, _ := d["id"].(string)
\tif id == "" {
\t\tid = uuid.NewString()
\t\td["id"] = id
\t}
\tm.mu.Lock()
\tdefer m.mu.Unlock()
\tif m.colls[coll] == nil {
\t\tm.colls[coll] = map[string]map[string]any{}
\t}
\tm.colls[coll][id] = d
\treturn maps.Clone(d), nil
}

func (m *MemoryStore) Update(_ context.Context, coll, id string, patch map[string]any) (map[string]any, error) {
\tm.mu.Lock()
\tdefer m.mu.Unlock()
\td, ok := m.colls[coll][id]
\tif !ok {
\t\treturn nil, ErrNotFound
\t}
\tfor k, v := range patch {
\t\tif k != "id" {
\t\t\td[k] = v
\t\t}
\t}
\treturn maps.Clone(d), nil
}

func (m *MemoryStore) Delete(_ context.Context, coll, id string) error {
\tm.mu.Lock()
\tdefer m.mu.Unlock()
\tif _, ok := m.colls[coll][id]; !ok {
\t\treturn ErrNotFound
\t}
\tdelete(m.colls[coll], id)
\treturn nil
}

func (m *MemoryStore) Ping(context.Context) error  { return nil }
func (m *MemoryStore) Close(context.Context) error { return nil }
`;
}

function goMongoStore(): string {
  return `package db

import (
\t"context"
\t"errors"
\t"maps"
\t"net/url"
\t"strings"
\t"time"

\t"github.com/google/uuid"
\t"go.mongodb.org/mongo-driver/bson"
\t"go.mongodb.org/mongo-driver/mongo"
\t"go.mongodb.org/mongo-driver/mongo/options"
)

// MongoStore implements DocStore on MongoDB. Each entity is a collection; the
// document's "id" is mirrored into Mongo's _id so lookups use the primary index.
type MongoStore struct {
\tclient *mongo.Client
\tdb     *mongo.Database
}

// OpenMongo connects with MONGODB_URI. The database name is taken from the URI
// path (mongodb://host:27017/<db>) and defaults to "app".
func OpenMongo(ctx context.Context, uri string) (*MongoStore, error) {
\tif uri == "" {
\t\treturn nil, errors.New("MONGODB_URI is not set")
\t}
\tname := "app"
\tif u, err := url.Parse(uri); err == nil {
\t\tif p := strings.Trim(u.Path, "/"); p != "" {
\t\t\tname = p
\t\t}
\t}
\tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
\tdefer cancel()
\t// DefaultDocumentM decodes nested documents as maps so they JSON-encode naturally.
\tclient, err := mongo.Connect(ctx, options.Client().ApplyURI(uri).SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true}))
\tif err != nil {
\t\treturn nil, err
\t}
\tif err := client.Ping(ctx, nil); err != nil {
\t\t_ = client.Disconnect(context.Background())
\t\treturn nil, err
\t}
\treturn &MongoStore{client: client, db: client.Database(name)}, nil
}

func (s *MongoStore) List(ctx context.Context, coll string) ([]map[string]any, error) {
\tcur, err := s.db.Collection(coll).Find(ctx, bson.M{})
\tif err != nil {
\t\treturn nil, err
\t}
\tout := []map[string]any{}
\tif err := cur.All(ctx, &out); err != nil {
\t\treturn nil, err
\t}
\tfor _, d := range out {
\t\tdelete(d, "_id")
\t}
\treturn out, nil
}

func (s *MongoStore) Get(ctx context.Context, coll, id string) (map[string]any, error) {
\tvar d map[string]any
\terr := s.db.Collection(coll).FindOne(ctx, bson.M{"_id": id}).Decode(&d)
\tif errors.Is(err, mongo.ErrNoDocuments) {
\t\treturn nil, ErrNotFound
\t}
\tif err != nil {
\t\treturn nil, err
\t}
\tdelete(d, "_id")
\treturn d, nil
}

func (s *MongoStore) Create(ctx context.Context, coll string, doc map[string]any) (map[string]any, error) {
\td := maps.Clone(doc)
\tif d == nil {
\t\td = map[string]any{}
\t}
\tid, _ := d["id"].(string)
\tif id == "" {
\t\tid = uuid.NewString()
\t\td["id"] = id
\t}
\td["_id"] = id
\tif _, err := s.db.Collection(coll).InsertOne(ctx, d); err != nil {
\t\treturn nil, err
\t}
\tdelete(d, "_id")
\treturn d, nil
}

func (s *MongoStore) Update(ctx context.Context, coll, id string, patch map[string]any) (map[string]any, error) {
\tset := maps.Clone(patch)
\tdelete(set, "id")
\tdelete(set, "_id")
\tif len(set) > 0 {
\t\tres, err := s.db.Collection(coll).UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": set})
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\tif res.MatchedCount == 0 {
\t\t\treturn nil, ErrNotFound
\t\t}
\t}
\treturn s.Get(ctx, coll, id)
}

func (s *MongoStore) Delete(ctx context.Context, coll, id string) error {
\tres, err := s.db.Collection(coll).DeleteOne(ctx, bson.M{"_id": id})
\tif err != nil {
\t\treturn err
\t}
\tif res.DeletedCount == 0 {
\t\treturn ErrNotFound
\t}
\treturn nil
}

func (s *MongoStore) Ping(ctx context.Context) error  { return s.client.Ping(ctx, nil) }
func (s *MongoStore) Close(ctx context.Context) error { return s.client.Disconnect(ctx) }
`;
}

type DocFw = {
  sig: string;
  ctx: string;
  id: string;
  send: (status: string, v: string) => string;
  noContent: string;
  bind: string;
};

const docFw: Record<GoFw, DocFw> = {
  gin: {
    sig: "c *gin.Context", ctx: "c.Request.Context()", id: `c.Param("id")`,
    send: (s, v) => `c.JSON(${s}, ${v})\n\t\treturn`, noContent: "c.Status(http.StatusNoContent)",
    bind: "c.ShouldBindJSON(&payload)",
  },
  fiber: {
    sig: "c *fiber.Ctx", ctx: "c.UserContext()", id: `c.Params("id")`,
    send: (s, v) => `return c.Status(${s}).JSON(${v})`, noContent: "return c.SendStatus(http.StatusNoContent)",
    bind: "c.BodyParser(&payload)",
  },
  echo: {
    sig: "c echo.Context", ctx: "c.Request().Context()", id: `c.Param("id")`,
    send: (s, v) => `return c.JSON(${s}, ${v})`, noContent: "return c.NoContent(http.StatusNoContent)",
    bind: "c.Bind(&payload)",
  },
  chi: {
    sig: "w http.ResponseWriter, r *http.Request", ctx: "r.Context()", id: `chi.URLParam(r, "id")`,
    send: (s, v) => `respondJSON(w, ${s}, ${v})\n\t\treturn`, noContent: "w.WriteHeader(http.StatusNoContent)",
    bind: "json.NewDecoder(r.Body).Decode(&payload)",
  },
};

function goDocHandlerHelpers(module: string, fw: GoFw): string {
  const chiHelper = fw === "chi" ? `

func respondJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}` : "";
  const code = `// statusFor maps a DocStore error to an HTTP status.
func statusFor(err error) int {
\tif errors.Is(err, db.ErrNotFound) {
\t\treturn http.StatusNotFound
\t}
\treturn http.StatusInternalServerError
}${chiHelper}
`;
  return `package handlers

${goImports(code, [["json", "encoding/json"], ["errors", "errors"], ["http", "net/http"]], [["db", `${module}/internal/db`]])}

${code}`;
}

function goDocEntityHandler(module: string, fw: GoFw, entity: Entity): string {
  const x = docFw[fw];
  const pascal = entity.name;
  const coll = `${toSnake(entity.name)}s`;
  const errBody = (e: string) => `map[string]any{"error": ${e}}`;
  const code = `type ${pascal}Handler struct{ store db.DocStore }

func New${pascal}Handler(store db.DocStore) *${pascal}Handler { return &${pascal}Handler{store: store} }

const ${toCamelLocal(pascal)}Collection = "${coll}"

func (h *${pascal}Handler) List(${x.sig})${fw === "gin" || fw === "chi" ? "" : " error"} {
\titems, err := h.store.List(${x.ctx}, ${toCamelLocal(pascal)}Collection)
\tif err != nil {
\t\t${x.send("http.StatusInternalServerError", errBody("err.Error()"))}
\t}
\t${x.send("http.StatusOK", "items").replace("\n\t\treturn", "")}
}

func (h *${pascal}Handler) GetByID(${x.sig})${fw === "gin" || fw === "chi" ? "" : " error"} {
\titem, err := h.store.Get(${x.ctx}, ${toCamelLocal(pascal)}Collection, ${x.id})
\tif err != nil {
\t\t${x.send("statusFor(err)", errBody("err.Error()"))}
\t}
\t${x.send("http.StatusOK", "item").replace("\n\t\treturn", "")}
}

func (h *${pascal}Handler) Create(${x.sig})${fw === "gin" || fw === "chi" ? "" : " error"} {
\tvar payload map[string]any
\tif err := ${x.bind}; err != nil || payload == nil {
\t\t${x.send("http.StatusBadRequest", errBody(`"invalid JSON body"`))}
\t}
\titem, err := h.store.Create(${x.ctx}, ${toCamelLocal(pascal)}Collection, payload)
\tif err != nil {
\t\t${x.send("http.StatusInternalServerError", errBody("err.Error()"))}
\t}
\t${x.send("http.StatusCreated", "item").replace("\n\t\treturn", "")}
}

func (h *${pascal}Handler) Update(${x.sig})${fw === "gin" || fw === "chi" ? "" : " error"} {
\tvar payload map[string]any
\tif err := ${x.bind}; err != nil {
\t\t${x.send("http.StatusBadRequest", errBody(`"invalid JSON body"`))}
\t}
\titem, err := h.store.Update(${x.ctx}, ${toCamelLocal(pascal)}Collection, ${x.id}, payload)
\tif err != nil {
\t\t${x.send("statusFor(err)", errBody("err.Error()"))}
\t}
\t${x.send("http.StatusOK", "item").replace("\n\t\treturn", "")}
}

func (h *${pascal}Handler) Delete(${x.sig})${fw === "gin" || fw === "chi" ? "" : " error"} {
\tif err := h.store.Delete(${x.ctx}, ${toCamelLocal(pascal)}Collection, ${x.id}); err != nil {
\t\t${x.send("statusFor(err)", errBody("err.Error()"))}
\t}
\t${x.noContent}
}
`;
  return `package handlers

${goImports(code, [["json", "encoding/json"], ["http", "net/http"]], [[fw, fwImport[fw]], ["db", `${module}/internal/db`]])}

${code}`;
}

// Same CRUD test as the SQL variant, run against the in-memory DocStore.
function goDocEntityTest(module: string, fw: GoFw, entity: Entity): string {
  const pascal = entity.name;
  return goEntityTest(module, fw, entity)
    .replace(`\t"github.com/glebarez/sqlite"\n`, "")
    .replace(`\t"gorm.io/gorm"\n`, "")
    .replace(`\t"${module}/internal/handlers"\n\t"${module}/internal/models"`, `\t"${module}/internal/db"\n\t"${module}/internal/handlers"`)
    .replace(new RegExp(`func setup${pascal}DB\\(t \\*testing\\.T\\) \\*gorm\\.DB \\{[\\s\\S]*?\\n\\}\\n\\n`), "")
    .replace(`\tdb := setup${pascal}DB(t)\n\th := handlers.New${pascal}Handler(db)`, `\th := handlers.New${pascal}Handler(db.NewMemoryStore())`);
}

function goEntityHandler(module: string, framework: string, entity: Entity): string {
  const pascal = entity.name;
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);

  if (framework === "gin") {
    return `package handlers

import (
\t"net/http"

\t"github.com/gin-gonic/gin"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c *gin.Context) {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusOK, items)
}

func (h *${pascal}Handler) GetByID(c *gin.Context) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusNotFound, gin.H{"error": "not found"})
\t\treturn
\t}
\tc.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Create(c *gin.Context) {
\tvar payload models.${pascal}
\tif err := c.ShouldBindJSON(&payload); err != nil {
\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusCreated, payload)
}

func (h *${pascal}Handler) Update(c *gin.Context) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusNotFound, gin.H{"error": "not found"})
\t\treturn
\t}
\tvar payload map[string]any
\tif err := c.ShouldBindJSON(&payload); err != nil {
\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Delete(c *gin.Context) {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.Status(http.StatusNoContent)
}
`;
  }

  if (framework === "fiber") {
    return `package handlers

import (
\t"github.com/gofiber/fiber/v2"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c *fiber.Ctx) error {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.JSON(items)
}

func (h *${pascal}Handler) GetByID(c *fiber.Ctx) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(404).JSON(fiber.Map{"error": "not found"})
\t}
\treturn c.JSON(item)
}

func (h *${pascal}Handler) Create(c *fiber.Ctx) error {
\tvar payload models.${pascal}
\tif err := c.BodyParser(&payload); err != nil {
\t\treturn c.Status(400).JSON(fiber.Map{"error": err.Error()})
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.Status(201).JSON(payload)
}

func (h *${pascal}Handler) Update(c *fiber.Ctx) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(404).JSON(fiber.Map{"error": "not found"})
\t}
\tvar payload map[string]any
\tif err := c.BodyParser(&payload); err != nil {
\t\treturn c.Status(400).JSON(fiber.Map{"error": err.Error()})
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.JSON(item)
}

func (h *${pascal}Handler) Delete(c *fiber.Ctx) error {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.SendStatus(204)
}
`;
  }

  if (framework === "echo") {
    return `package handlers

import (
\t"net/http"

\t"github.com/labstack/echo/v4"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c echo.Context) error {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusOK, items)
}

func (h *${pascal}Handler) GetByID(c echo.Context) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
\t}
\treturn c.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Create(c echo.Context) error {
\tvar payload models.${pascal}
\tif err := c.Bind(&payload); err != nil {
\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusCreated, payload)
}

func (h *${pascal}Handler) Update(c echo.Context) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
\t}
\tvar payload map[string]any
\tif err := c.Bind(&payload); err != nil {
\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Delete(c echo.Context) error {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.NoContent(http.StatusNoContent)
}
`;
  }

  // chi
  return `package handlers

import (
\t"encoding/json"
\t"net/http"

\t"github.com/go-chi/chi/v5"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}

func (h *${pascal}Handler) List(w http.ResponseWriter, r *http.Request) {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 200, items)
}

func (h *${pascal}Handler) GetByID(w http.ResponseWriter, r *http.Request) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 404, map[string]any{"error": "not found"})
\t\treturn
\t}
\th.writeJSON(w, 200, item)
}

func (h *${pascal}Handler) Create(w http.ResponseWriter, r *http.Request) {
\tvar payload models.${pascal}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\th.writeJSON(w, 400, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 201, payload)
}

func (h *${pascal}Handler) Update(w http.ResponseWriter, r *http.Request) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 404, map[string]any{"error": "not found"})
\t\treturn
\t}
\tvar payload map[string]any
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\th.writeJSON(w, 400, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 200, item)
}

func (h *${pascal}Handler) Delete(w http.ResponseWriter, r *http.Request) {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tw.WriteHeader(http.StatusNoContent)
}
`;
  // suppress unused var warning
  void snake; void kebab;
}

function goTestBody(entity: Entity, valueString = "test", valueNum = 1): string {
  const fields = entity.fields.filter(f => !f.primaryKey && f.required);
  if (fields.length === 0) return `map[string]any{"name": "test"}`;
  const pairs = fields.slice(0, 3).map(f => {
    if (f.type === "string" || f.type === "text") return `"${f.name}": "${valueString}"`;
    if (f.type === "number") return `"${f.name}": ${valueNum}`;
    if (f.type === "boolean") return `"${f.name}": true`;
    if (f.type === "uuid") return `"${f.name}": "00000000-0000-0000-0000-000000000001"`;
    return `"${f.name}": "${valueString}"`;
  });
  return `map[string]any{${pairs.join(", ")}}`;
}

function goEntityTest(module: string, framework: string, entity: Entity): string {
  const pascal = entity.name;
  const kebab = toKebab(entity.name);
  const createBody = goTestBody(entity, "test", 1);
  const updateBody = goTestBody(entity, "updated", 2);

  if (framework === "gin") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/gin-gonic/gin"
\t"github.com/glebarez/sqlite"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil {
\t\tt.Fatal(err)
\t}
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tgin.SetMode(gin.TestMode)
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tr := gin.New()
\tr.GET("/${kebab}s", h.List)
\tr.GET("/${kebab}s/:id", h.GetByID)
\tr.POST("/${kebab}s", h.Create)
\tr.PATCH("/${kebab}s/:id", h.Update)
\tr.DELETE("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated {
\t\t\tt.Errorf("want 201 got %d: %s", w.Code, w.Body)
\t\t}
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok {
\t\t\tcreatedID = id
\t\t}
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", w.Code)
\t\t}
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound {
\t\t\tt.Errorf("want 404 got %d", w.Code)
\t\t}
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent {
\t\t\tt.Errorf("want 204 got %d", w.Code)
\t\t}
\t})
}
`;
  }

  if (framework === "fiber") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"io"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/glebarez/sqlite"
\t"github.com/gofiber/fiber/v2"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil {
\t\tt.Fatal(err)
\t}
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tapp := fiber.New()
\tapp.Get("/${kebab}s", h.List)
\tapp.Get("/${kebab}s/:id", h.GetByID)
\tapp.Post("/${kebab}s", h.Create)
\tapp.Patch("/${kebab}s/:id", h.Update)
\tapp.Delete("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s", nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", resp.StatusCode)
\t\t}
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusCreated {
\t\t\tt.Errorf("want 201 got %d", resp.StatusCode)
\t\t}
\t\trawBody, _ := io.ReadAll(resp.Body)
\t\tvar result map[string]any
\t\t_ = json.Unmarshal(rawBody, &result)
\t\tif id, ok := result["id"].(string); ok {
\t\t\tcreatedID = id
\t\t}
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", resp.StatusCode)
\t\t}
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusNotFound {
\t\t\tt.Errorf("want 404 got %d", resp.StatusCode)
\t\t}
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", resp.StatusCode)
\t\t}
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\treq := httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil {
\t\t\tt.Fatal(err)
\t\t}
\t\tif resp.StatusCode != http.StatusNoContent {
\t\t\tt.Errorf("want 204 got %d", resp.StatusCode)
\t\t}
\t})
}
`;
  }

  if (framework === "echo") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/glebarez/sqlite"
\t"github.com/labstack/echo/v4"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil {
\t\tt.Fatal(err)
\t}
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\te := echo.New()
\te.GET("/${kebab}s", h.List)
\te.GET("/${kebab}s/:id", h.GetByID)
\te.POST("/${kebab}s", h.Create)
\te.PATCH("/${kebab}s/:id", h.Update)
\te.DELETE("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated {
\t\t\tt.Errorf("want 201 got %d: %s", w.Code, w.Body)
\t\t}
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok {
\t\t\tcreatedID = id
\t\t}
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", w.Code)
\t\t}
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound {
\t\t\tt.Errorf("want 404 got %d", w.Code)
\t\t}
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent {
\t\t\tt.Errorf("want 204 got %d", w.Code)
\t\t}
\t})
}
`;
  }

  // chi
  return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/glebarez/sqlite"
\t"github.com/go-chi/chi/v5"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil {
\t\tt.Fatal(err)
\t}
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil {
\t\tt.Fatal(err)
\t}
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tr := chi.NewRouter()
\tr.Get("/${kebab}s", h.List)
\tr.Get("/${kebab}s/{id}", h.GetByID)
\tr.Post("/${kebab}s", h.Create)
\tr.Patch("/${kebab}s/{id}", h.Update)
\tr.Delete("/${kebab}s/{id}", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated {
\t\t\tt.Errorf("want 201 got %d: %s", w.Code, w.Body)
\t\t}
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok {
\t\t\tcreatedID = id
\t\t}
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d", w.Code)
\t\t}
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound {
\t\t\tt.Errorf("want 404 got %d", w.Code)
\t\t}
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK {
\t\t\tt.Errorf("want 200 got %d: %s", w.Code, w.Body)
\t\t}
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" {
\t\t\tt.Skip("depends on create")
\t\t}
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent {
\t\t\tt.Errorf("want 204 got %d", w.Code)
\t\t}
\t})
}
`;
}

function goGormDB(kind: GoDbKind): string {
  if (kind === "sqlite") {
    return `package db

import (
\t"github.com/glebarez/sqlite"
\t"gorm.io/gorm"
)

func OpenGorm(dsn string) (*gorm.DB, error) {
\tif dsn == "" {
\t\tdsn = "app.db"
\t}
\treturn gorm.Open(sqlite.Open(dsn), &gorm.Config{})
}
`;
  }
  const mysql = kind === "mysql";
  return `package db

import (
\t"time"

\t${mysql ? `gormMysql "gorm.io/driver/mysql"` : `gormPg "gorm.io/driver/postgres"`}
\t"gorm.io/gorm"
)

func OpenGorm(dsn string) (*gorm.DB, error) {
${mysql ? `\tdsn, err := MySQLDSN(dsn)
\tif err != nil {
\t\treturn nil, err
\t}
` : ""}\t// GORM wraps the underlying *sql.DB; configure the pool explicitly rather
\t// than relying on GORM's defaults (no pool configuration at all).
\tdb, err := gorm.Open(${mysql ? "gormMysql" : "gormPg"}.Open(dsn), &gorm.Config{})
\tif err != nil {
\t\treturn nil, err
\t}
\tsqlDB, err := db.DB()
\tif err != nil {
\t\treturn nil, err
\t}
\tsqlDB.SetMaxOpenConns(25)
\tsqlDB.SetMaxIdleConns(10)
\tsqlDB.SetConnMaxLifetime(30 * time.Minute)
\treturn db, nil
}
`;
}

// Module → version for everything the Go generator can import. go.mod lists
// exactly the modules the emitted code imports (see goMod).
const GO_MODULE_VERSIONS: [string, string][] = [
  ["github.com/caarlos0/env/v11", "v11.2.2"],
  ["github.com/gin-gonic/gin", "v1.10.0"],
  ["github.com/go-chi/chi/v5", "v5.1.0"],
  ["github.com/go-sql-driver/mysql", "v1.8.1"],
  ["github.com/gofiber/fiber/v2", "v2.52.0"],
  ["github.com/golang-jwt/jwt/v5", "v5.2.1"],
  ["github.com/golang-migrate/migrate/v4", "v4.18.1"],
  ["github.com/google/uuid", "v1.6.0"],
  ["github.com/getsentry/sentry-go", "v0.29.1"],
  ["github.com/jackc/pgx/v5", "v5.7.1"],
  ["github.com/labstack/echo/v4", "v4.12.0"],
  ["github.com/lestrrat-go/jwx/v2", "v2.1.1"],
  ["github.com/prometheus/client_golang", "v1.20.4"],
  ["github.com/redis/go-redis/v9", "v9.7.0"],
  ["go.mongodb.org/mongo-driver", "v1.17.1"],
  ["go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin", "v0.56.0"],
  ["go.opentelemetry.io/contrib/instrumentation/github.com/labstack/echo/otelecho", "v0.56.0"],
  ["go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", "v0.56.0"],
  ["go.opentelemetry.io/otel", "v1.31.0"],
  ["go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp", "v1.31.0"],
  ["go.opentelemetry.io/otel/sdk", "v1.31.0"],
  ["go.opentelemetry.io/otel/trace", "v1.31.0"],
  ["golang.org/x/crypto", "v0.27.0"],
  ["golang.org/x/time", "v0.7.0"],
  ["gopkg.in/DataDog/dd-trace-go.v1", "v1.69.0"],
  ["gorm.io/driver/mysql", "v1.5.7"],
  ["gorm.io/driver/postgres", "v1.5.11"],
  ["github.com/glebarez/sqlite", "v1.11.0"],
  ["gorm.io/gorm", "v1.25.12"],
];
const GO_MODULES_BY_LENGTH = [...GO_MODULE_VERSIONS].sort((a, b) => b[0].length - a[0].length);

function goMod(module: string, files: GeneratedFile[], extraImports: string[] = []): string {
  const imports = [...extraImports];
  const importLine = /^\s*(?:import\s+)?(?:[\w.]+\s+)?"([a-z0-9.-]+\.[a-z]{2,}\/[^"\s]+)"\s*$/gm;
  for (const f of files) {
    if (!f.path.endsWith(".go")) continue;
    for (const [, path] of f.content.matchAll(importLine)) imports.push(path);
  }
  const required = new Map<string, string>();
  for (const path of imports) {
    const mod = GO_MODULES_BY_LENGTH.find(([p]) => path === p || path.startsWith(p + "/"));
    if (mod) required.set(mod[0], mod[1]);
  }
  const lines = [...required].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => `\t${p} ${v}`);
  return `module ${module}

go 1.23

require (
${lines.join("\n")}
)
`;
}
function goModels(module: string, entities: Entity[]): string {
  const needsTime = entities.some((e) =>
    e.fields.some((f) => f.type === "date" || f.name === "createdAt" || f.name === "updatedAt")
  );
  const needsJSON = entities.some((e) => e.fields.some((f) => f.type === "json"));

  const needsUUID = entities.some((e) => e.fields.some((f) => f.primaryKey && f.type === "uuid"));
  const imports = [
    needsTime ? `\t"time"\n` : "",
    needsUUID ? `\t"github.com/google/uuid"` : "",
    needsJSON ? `\t"gorm.io/datatypes"` : "",
    `\t"gorm.io/gorm"`,
  ]
    .filter(Boolean)
    .join("\n");

  const structs = entities
    .map((e) => {
      const rows: [string, string, string?][] = e.fields.map((f) =>
        [toPascal(f.name), goFieldType(f.type), `\`${buildGORMTags(f)} json:"${f.name}"\``]);
      if (!e.fields.some((f) => f.name === "createdAt")) rows.push(["CreatedAt", "time.Time"]);
      if (!e.fields.some((f) => f.name === "updatedAt")) rows.push(["UpdatedAt", "time.Time"]);
      if (!e.fields.some((f) => f.name === "deletedAt")) rows.push(["DeletedAt", "gorm.DeletedAt", '`gorm:"index"`']);
      const fields = goAlignFields(rows);
      const uuidPk = e.fields.find((f) => f.primaryKey && f.type === "uuid");
      // UUIDs are assigned in Go so inserts behave the same on Postgres,
      // MySQL and the SQLite used by the handler tests (no DB-side default).
      const hook = uuidPk ? `

func (m *${e.name}) BeforeCreate(*gorm.DB) error {
\tif m.${toPascal(uuidPk.name)} == "" {
\t\tm.${toPascal(uuidPk.name)} = uuid.NewString()
\t}
\treturn nil
}` : "";
      return `type ${e.name} struct {\n${fields.join("\n")}\n}${hook}`;
    })
    .join("\n\n");

  return `// Auto-generated by Helios — edit freely
package models

import (
${imports}
)

${structs}
`;
}

// gofmt column alignment: names pad across the whole struct, types pad across
// each contiguous run of tagged fields.
function goAlignFields(rows: [string, string, string?][]): string[] {
  const nameW = Math.max(...rows.map((r) => r[0].length));
  const typeW = rows.map(() => 0);
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && rows[j][2]) j++;
    const w = Math.max(0, ...rows.slice(i, j).map((r) => r[1].length));
    for (let k = i; k < j; k++) typeW[k] = w;
    i = j === i ? i + 1 : j;
  }
  return rows.map(([n, t, tag], i) =>
    `\t${n.padEnd(nameW)} ${tag ? `${t.padEnd(typeW[i])} ${tag}` : t}`);
}

function goFieldType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "string";
    case "string":  return "string";
    case "text":    return "string";
    case "number":  return "int64";
    case "boolean": return "bool";
    case "date":    return "time.Time";
    case "json":    return "datatypes.JSON";
  }
}

function buildGORMTags(f: { type: FieldType; primaryKey?: boolean; unique: boolean; required: boolean }): string {
  const tags: string[] = [];
  if (f.primaryKey) {
    tags.push(
      f.type === "uuid"
        ? 'gorm:"primaryKey;size:36"'
        : 'gorm:"primaryKey"'
    );
  } else {
    const parts: string[] = [];
    if (f.type === "text") parts.push("type:text");
    // json: datatypes.JSON picks jsonb / json per dialect itself.
    if (f.unique) parts.push("uniqueIndex");
    if (f.required) parts.push("not null");
    if (parts.length) tags.push(`gorm:"${parts.join(";")}"`)
    else tags.push(`gorm:""`);
  }
  return tags.join(" ");
}

function goDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
`;
}

function goMain(module: string) {
  return `package main

import (
\t"context"
\t"log/slog"
\t"os"
\t"os/signal"
\t"syscall"
\t"time"

\t"${module}/internal/config"
\t"${module}/internal/server"
)

func main() {
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
\tslog.SetDefault(logger)

\tcfg, err := config.Load()
\tif err != nil {
\t\tlogger.Error("config", "err", err)
\t\tos.Exit(1)
\t}

\tsrv := server.New(cfg, logger)

\tctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
\tdefer cancel()

\tgo func() {
\t\tif err := srv.Run(); err != nil {
\t\t\tlogger.Error("serve", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\t<-ctx.Done()
\tlogger.Info("shutting down")
\tshutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
\t_ = srv.Shutdown(shutdown)
}
`;
}

function goConfig(withMongo = false) {
  return `package config

import env "github.com/caarlos0/env/v11"

type Config struct {
\tAppName  string \`env:"APP_NAME" envDefault:"app"\`
\tPort     string \`env:"PORT" envDefault:"8080"\`
\tLogLevel string \`env:"LOG_LEVEL" envDefault:"info"\`

\tDatabaseURL string \`env:"DATABASE_URL"\`
${withMongo ? "\tMongoURI    string `env:\"MONGODB_URI\"`\n" : ""}\tRedisURL    string \`env:"REDIS_URL"\`
\tJWTSecret   string \`env:"JWT_SECRET"\`
}

func Load() (*Config, error) {
\tc := &Config{}
\tif err := env.Parse(c); err != nil {
\t\treturn nil, err
\t}
\treturn c, nil
}
`;
}

type ServerFw = {
  field: string;
  init: string;
  get: string; // method name for GET routes
  route: (method: string, path: string, handler: string, auth: boolean) => string;
  assign: string;
  run: string;
  stop: string;
  accessor: string;
  inline: (name: string, op: string) => string;
};

const serverFw: Record<GoFw, ServerFw> = {
  gin: {
    field: "\tcfg    *config.Config\n\tlog    *slog.Logger\n\tsrv    *http.Server\n\tengine *gin.Engine",
    init: "\tgin.SetMode(gin.ReleaseMode)\n\tr := gin.New()",
    get: "GET",
    route: (m, p, h, auth) => `\tr.${m}("${p}", ${auth ? "authRequired, " : ""}${h})`,
    assign: `\ts.engine = r\n\ts.srv = &http.Server{Addr: ":" + cfg.Port, Handler: r}`,
    run: `\ts.log.Info("listening", "addr", s.srv.Addr)
\tif err := s.srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
\t\treturn err
\t}
\treturn nil`,
    stop: "s.srv.Shutdown(ctx)",
    accessor: "func (s *Server) Handler() http.Handler { return s.engine }",
    inline: (n, op) => `func handle${n}(c *gin.Context) {\n\tc.JSON(200, gin.H{"ok": true, "op": "${op}"})\n}`,
  },
  fiber: {
    field: "\tcfg *config.Config\n\tlog *slog.Logger\n\tapp *fiber.App",
    init: "\tr := fiber.New(fiber.Config{DisableStartupMessage: true})",
    get: "Get",
    route: (m, p, h, auth) => `\tr.${fiberMethod(m)}("${p}", ${auth ? "authRequired, " : ""}${h})`,
    assign: "\ts.app = r",
    run: `\treturn s.app.Listen(":" + s.cfg.Port)`,
    stop: "s.app.ShutdownWithContext(ctx)",
    accessor: "func (s *Server) App() *fiber.App { return s.app }",
    inline: (n, op) => `func handle${n}(c *fiber.Ctx) error {\n\treturn c.JSON(fiber.Map{"ok": true, "op": "${op}"})\n}`,
  },
  echo: {
    field: "\tcfg *config.Config\n\tlog *slog.Logger\n\te   *echo.Echo",
    init: "\tr := echo.New()\n\tr.HideBanner = true",
    get: "GET",
    route: (m, p, h, auth) => `\tr.${m}("${p}", ${h}${auth ? ", authRequired" : ""})`,
    assign: "\ts.e = r",
    run: `\tif err := s.e.Start(":" + s.cfg.Port); !errors.Is(err, http.ErrServerClosed) {
\t\treturn err
\t}
\treturn nil`,
    stop: "s.e.Shutdown(ctx)",
    accessor: "func (s *Server) Handler() http.Handler { return s.e }",
    inline: (n, op) => `func handle${n}(c echo.Context) error {\n\treturn c.JSON(200, map[string]any{"ok": true, "op": "${op}"})\n}`,
  },
  chi: {
    field: "\tcfg *config.Config\n\tlog *slog.Logger\n\tsrv *http.Server",
    init: "\tr := chi.NewRouter()",
    get: "Get",
    route: (m, p, h, auth) => `\tr${auth ? ".With(authRequired)" : ""}.Method("${m}", "${p}", http.HandlerFunc(${h}))`,
    assign: `\ts.srv = &http.Server{Addr: ":" + cfg.Port, Handler: r}`,
    run: `\ts.log.Info("listening", "addr", s.srv.Addr)
\tif err := s.srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
\t\treturn err
\t}
\treturn nil`,
    stop: "s.srv.Shutdown(ctx)",
    accessor: "func (s *Server) Handler() http.Handler { return s.srv.Handler }",
    inline: (n, op) => `func handle${n}(w http.ResponseWriter, r *http.Request) {\n\twriteJSON(w, 200, map[string]any{"ok": true, "op": "${op}"})\n}`,
  },
};

// chi uses {param} placeholders; gin / fiber / echo use :param.
function goRoutePath(fw: GoFw, p: string) {
  return fw === "chi" ? p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}") : p;
}

// Everything the server depends on is opened here, registered as a readiness
// check, and closed (in reverse order) on shutdown.
function goServerDeps(config: StackConfig, entities: Entity[], d: GoDeps): string {
  const out: string[] = [];
  if (d.withTracing) out.push(`\tif shutdown, err := tracing.Init(context.Background(), cfg.AppName); err != nil {
\t\tlog.Warn("tracing disabled", "err", err)
\t} else {
\t\ts.closers = append(s.closers, shutdown)
\t}`);
  if (d.monitoring === "sentry") out.push(`\ts.closers = append(s.closers, monitoring.InitSentry(log))`);
  if (d.monitoring === "datadog") out.push(`\ts.closers = append(s.closers, monitoring.InitDatadog(cfg.AppName, log))`);

  if (d.needsGorm) {
    out.push(`\tgormDB, err := db.OpenGorm(cfg.DatabaseURL)
\tif err != nil {
\t\tlog.Error("database", "err", err)
\t\tos.Exit(1)
\t}
\tif sqlDB, err := gormDB.DB(); err == nil {
\t\ts.checks["db"] = sqlDB.PingContext
\t\ts.closers = append(s.closers, func(context.Context) error { return sqlDB.Close() })
\t}`);
  } else if (d.kind === "postgres" || d.kind === "mysql") {
    out.push(`\tsqlDB, err := db.Open(cfg.DatabaseURL)
\tif err != nil {
\t\tlog.Error("database", "err", err)
\t\tos.Exit(1)
\t}
\ts.checks["db"] = sqlDB.PingContext
\ts.closers = append(s.closers, func(context.Context) error { return sqlDB.Close() })`);
  } else if (d.kind === "mongo") {
    out.push(`\tstore, err := db.OpenMongo(context.Background(), cfg.MongoURI)
\tif err != nil {
\t\tlog.Error("database", "err", err)
\t\tos.Exit(1)
\t}
\ts.checks["db"] = store.Ping
\ts.closers = append(s.closers, store.Close)`);
  } else if (d.docStore) {
    out.push(`\t// ponytail: in-memory store — no ${config.database || "database"} repository is generated (see internal/db/docstore.go).
\tstore := db.NewMemoryStore()`);
  }

  if (d.withRedis) out.push(`\trdb, err := cache.Open(cfg.RedisURL)
\tif err != nil {
\t\t// Not fatal: liveness stays green, /health?ready=1 reports the cache as down.
\t\tlog.Warn("cache unavailable at startup", "err", err)
\t}
\tif rdb != nil {
\t\ts.checks["cache"] = func(ctx context.Context) error { return rdb.Ping(ctx).Err() }
\t\ts.closers = append(s.closers, func(context.Context) error { return rdb.Close() })
\t} else {
\t\tcacheErr := err
\t\ts.checks["cache"] = func(context.Context) error { return cacheErr }
\t}`);
  void entities;
  return out.join("\n");
}

function goServer(module: string, config: StackConfig, endpoints: Endpoint[], entities: Entity[], d: GoDeps) {
  const fw = d.fw;
  const F = serverFw[fw];
  const hasPatterns = !!d.api;
  // Every method+path is registered exactly once — gin panics at startup on
  // duplicates. /health belongs to the server (liveness + readiness). Where an
  // endpoint and an entity CRUD route collide, an endpoint with a pattern
  // (explicit logic) wins; a plain stub endpoint yields to the real CRUD
  // handler, which inherits the endpoint's auth flag.
  const key = (m: string, p: string) => `${m} ${p.replace(/:[A-Za-z0-9_]+/g, ":p")}`;
  const entityDefs = entities.flatMap((e) => {
    const kb = toKebab(e.name);
    const h = `${toCamelLocal(e.name)}H`;
    return [
      ["GET", `/${kb}s`, `${h}.List`],
      ["GET", `/${kb}s/:id`, `${h}.GetByID`],
      ["POST", `/${kb}s`, `${h}.Create`],
      ["PATCH", `/${kb}s/:id`, `${h}.Update`],
      ["DELETE", `/${kb}s/:id`, `${h}.Delete`],
    ];
  });
  const entityKeys = new Set(entityDefs.map(([m, p]) => key(m, p)));
  const patterned = new Set(endpoints.filter((e) => e.pattern).map((e) => key(e.method, e.path)));
  const authed = new Set(endpoints.filter((e) => e.auth).map((e) => key(e.method, e.path)));
  const routed = endpoints.filter((e) =>
    !(e.method === "GET" && e.path === "/health") &&
    (!!e.pattern || !entityKeys.has(key(e.method, e.path)))
  );
  const handlerRef = (e: Endpoint) => (hasPatterns ? `apiH.${goHandlerMethodName(e)}` : `handle${handlerName(e)}`);
  const routes = routed.map((e) => F.route(e.method, goRoutePath(fw, e.path), handlerRef(e), e.auth)).join("\n");
  const inlineHandlers = hasPatterns ? "" : routed.map((e) => F.inline(handlerName(e), `${e.method} ${e.path}`)).join("\n\n");

  const store = d.needsGorm ? "gormDB" : "store";
  const entitySetup = entities.map((e) => `\t${toCamelLocal(e.name)}H := handlers.New${e.name}Handler(${store})`).join("\n");
  const entityRouteLines = entityDefs
    .filter(([m, p]) => !patterned.has(key(m, p)))
    .map(([m, p, h]) => F.route(m, goRoutePath(fw, p), h, authed.has(key(m, p))))
    .join("\n");

  const apiArgs = ["log"];
  if (d.api?.usesDb) apiArgs.push(d.needsGorm ? "gormDB" : "nil");
  if (d.api?.usesRdb) apiArgs.push(d.withRedis ? "rdb" : "nil");
  const apiHSetup = hasPatterns ? `\tapiH := handlers.NewAPIHandlers(${apiArgs.join(", ")})\n` : "";

  const mws = ["recoverer(log)"];
  if (d.monitoring === "sentry") mws.push("monitoring.SentryMiddleware()");
  if (d.withTracing) mws.push("tracing.Middleware(cfg.AppName)");
  if (d.monitoring === "datadog") mws.push("monitoring.DatadogMiddleware(cfg.AppName)");
  mws.push("requestLog(log)");
  if (config.rateLimit) mws.push("rateLimit()");
  if (config.audit) mws.push("auditLog(log)");

  const body = [
    goServerDeps(config, entities, d),
    "",
    F.init,
    `\tr.Use(${mws.join(", ")})`,
    d.monitoring === "prometheus" ? "\tmonitoring.MountMetrics(r)" : "",
    "",
    `${apiHSetup}\tr.${F.get}("/health", s.health)`,
    routes,
    entitySetup,
    entityRouteLines,
    "",
    F.assign,
    "\treturn s",
  ].filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== "")).join("\n");

  const code = `type Server struct {
${F.field}

\t// checks are pinged by /health?ready=1; closers run in reverse on Shutdown.
\tchecks  map[string]func(context.Context) error
\tclosers []func(context.Context) error
}

func New(cfg *config.Config, log *slog.Logger) *Server {
\ts := &Server{cfg: cfg, log: log, checks: map[string]func(context.Context) error{}}
${body}
}

func (s *Server) Run() error {
${F.run}
}

// Shutdown drains in-flight requests, then closes dependencies (tracing flush,
// cache, database) in reverse order of opening.
func (s *Server) Shutdown(ctx context.Context) error {
\terr := ${F.stop}
\tfor i := len(s.closers) - 1; i >= 0; i-- {
\t\tif cerr := s.closers[i](ctx); cerr != nil {
\t\t\ts.log.Warn("shutdown", "err", cerr)
\t\t}
\t}
\treturn err
}

${F.accessor}
${fw === "chi" ? `
func writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}
` : ""}${inlineHandlers ? `\n${inlineHandlers}\n` : ""}`;

  return `package server

${goImports(code, [["context", "context"], ["json", "encoding/json"], ["errors", "errors"], ["slog", "log/slog"], ["http", "net/http"], ["os", "os"]], [
    [fw, fwImport[fw]],
    ["cache", `${module}/internal/cache`],
    ["config", `${module}/internal/config`],
    ["db", `${module}/internal/db`],
    ["handlers", `${module}/internal/handlers`],
    ["monitoring", `${module}/internal/monitoring`],
    ["tracing", `${module}/internal/tracing`],
  ])}

${code}`;
}

function toCamelLocal(name: string): string {
  const s = name;
  return s ? s[0].toLowerCase() + s.slice(1) : "";
}
function goAuthJwt(): string {
  return `// Package auth verifies inbound JWTs against the configured issuer and JWKS
// endpoint. The JWKS is fetched once on first use and refreshed automatically
// by jwx's cache; no hand-rolled key management required.
//
// The package is provider-agnostic: point AUTH_ISSUER and AUTH_JWKS_URL at
// Clerk, Auth0, Cognito, Firebase, Keycloak, or Supabase Auth and the same
// verifier handles all of them. Set AUTH_AUDIENCE if the provider issues
// tokens with an \`aud\` claim (most do).
package auth

import (
\t"context"
\t"errors"
\t"fmt"
\t"net/http"
\t"os"
\t"strings"
\t"sync"
\t"time"

\t"github.com/lestrrat-go/jwx/v2/jwk"
\t"github.com/lestrrat-go/jwx/v2/jwt"
)

// Claims is a thin wrapper around jwt.Token so handlers can reach for the
// common fields (subject, audience, email) without poking at the jwx API.
type Claims struct {
\tSubject  string
\tIssuer   string
\tAudience []string
\tEmail    string
\tRaw      jwt.Token
}

type contextKey struct{}

// NewContext / FromContext thread claims through request context.
func NewContext(ctx context.Context, c *Claims) context.Context {
\treturn context.WithValue(ctx, contextKey{}, c)
}
func FromContext(ctx context.Context) (*Claims, bool) {
\tc, ok := ctx.Value(contextKey{}).(*Claims)
\treturn c, ok
}

// Verifier holds JWKS and config read from the environment. Safe to share
// across goroutines — jwk.Cache does its own locking.
type Verifier struct {
\tissuer   string
\taudience string
\tjwksURL  string
\tcache    *jwk.Cache
\tset      jwk.Set
\tonce     sync.Once
}

var (
\tdefaultVerifier *Verifier
\tdefaultErr      error
\tdefaultOnce     sync.Once
)

// Default returns a process-wide Verifier built from the AUTH_* env vars.
// Call \`auth.Default()\` once at startup to fail fast if the env is wrong.
func Default() (*Verifier, error) {
\tdefaultOnce.Do(func() {
\t\tdefaultVerifier, defaultErr = NewVerifier(context.Background())
\t})
\treturn defaultVerifier, defaultErr
}

func NewVerifier(ctx context.Context) (*Verifier, error) {
\tissuer := os.Getenv("AUTH_ISSUER")
\tjwksURL := os.Getenv("AUTH_JWKS_URL")
\tif issuer == "" || jwksURL == "" {
\t\treturn nil, errors.New("auth: AUTH_ISSUER and AUTH_JWKS_URL must be set")
\t}

\tcache := jwk.NewCache(ctx)
\tif err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(15*time.Minute)); err != nil {
\t\treturn nil, fmt.Errorf("auth: register JWKS: %w", err)
\t}
\t// Warm the cache so the first incoming request doesn't pay the fetch latency.
\tif _, err := cache.Refresh(ctx, jwksURL); err != nil {
\t\treturn nil, fmt.Errorf("auth: fetch JWKS: %w", err)
\t}
\treturn &Verifier{
\t\tissuer:   issuer,
\t\taudience: os.Getenv("AUTH_AUDIENCE"),
\t\tjwksURL:  jwksURL,
\t\tcache:    cache,
\t\tset:      jwk.NewCachedSet(cache, jwksURL),
\t}, nil
}

// Verify parses, validates, and returns claims for the given raw token.
// Returns a wrapped error on any validation failure — the caller should
// respond 401 without leaking detail to the client.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Claims, error) {
\topts := []jwt.ParseOption{
\t\tjwt.WithKeySet(v.set),
\t\tjwt.WithIssuer(v.issuer),
\t\tjwt.WithValidate(true),
\t\tjwt.WithAcceptableSkew(30 * time.Second),
\t}
\tif v.audience != "" {
\t\topts = append(opts, jwt.WithAudience(v.audience))
\t}
\ttok, err := jwt.ParseString(raw, opts...)
\tif err != nil {
\t\treturn nil, fmt.Errorf("auth: verify: %w", err)
\t}
\temail, _ := tok.Get("email")
\temailStr, _ := email.(string)
\treturn &Claims{
\t\tSubject:  tok.Subject(),
\t\tIssuer:   tok.Issuer(),
\t\tAudience: tok.Audience(),
\t\tEmail:    emailStr,
\t\tRaw:      tok,
\t}, nil
}

// ExtractBearer pulls the token out of an \`Authorization: Bearer <token>\`
// header and returns an error when the header is missing or malformed.
// Framework middleware wraps this.
func ExtractBearer(h http.Header) (string, error) {
\tauth := h.Get("Authorization")
\tif auth == "" {
\t\treturn "", errors.New("missing Authorization header")
\t}
\tconst prefix = "Bearer "
\tif !strings.HasPrefix(auth, prefix) {
\t\treturn "", errors.New("Authorization header must be a Bearer token")
\t}
\treturn strings.TrimSpace(auth[len(prefix):]), nil
}
`;
}

// Self-managed variant of internal/auth: same API as goAuthJwt (Default,
// Verify, ExtractBearer, NewContext/FromContext) so middleware is shared.
function goAuthHS256(): string {
  return `// Package auth verifies the HS256 JWTs this service issues itself (auth "none"
// = self-managed): the login/register/refresh handlers sign with JWT_SECRET
// and Verify checks the same secret. Pick an external provider in the builder
// to verify provider-issued tokens via JWKS instead.
package auth

import (
\t"context"
\t"errors"
\t"fmt"
\t"net/http"
\t"os"
\t"strings"

\t"github.com/golang-jwt/jwt/v5"
)

// Claims holds the verified token fields handlers need.
type Claims struct {
\tSubject string
\tEmail   string
}

type contextKey struct{}

// NewContext / FromContext thread claims through request context.
func NewContext(ctx context.Context, c *Claims) context.Context {
\treturn context.WithValue(ctx, contextKey{}, c)
}
func FromContext(ctx context.Context) (*Claims, bool) {
\tc, ok := ctx.Value(contextKey{}).(*Claims)
\treturn c, ok
}

type Verifier struct {
\tsecret []byte
}

// Default builds a Verifier from JWT_SECRET.
func Default() (*Verifier, error) {
\tsecret := os.Getenv("JWT_SECRET")
\tif secret == "" {
\t\treturn nil, errors.New("auth: JWT_SECRET must be set")
\t}
\treturn &Verifier{secret: []byte(secret)}, nil
}

// Verify checks signature (HS256 only), expiry, and returns the claims.
func (v *Verifier) Verify(_ context.Context, raw string) (*Claims, error) {
\ttok, err := jwt.Parse(raw, func(*jwt.Token) (any, error) { return v.secret, nil },
\t\tjwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
\tif err != nil {
\t\treturn nil, fmt.Errorf("auth: verify: %w", err)
\t}
\tsub, _ := tok.Claims.GetSubject()
\tmc, _ := tok.Claims.(jwt.MapClaims)
\temail, _ := mc["email"].(string)
\treturn &Claims{Subject: sub, Email: email}, nil
}

// ExtractBearer pulls the token out of an \`Authorization: Bearer <token>\`
// header and returns an error when the header is missing or malformed.
func ExtractBearer(h http.Header) (string, error) {
\tauth := h.Get("Authorization")
\tif auth == "" {
\t\treturn "", errors.New("missing Authorization header")
\t}
\tconst prefix = "Bearer "
\tif !strings.HasPrefix(auth, prefix) {
\t\treturn "", errors.New("Authorization header must be a Bearer token")
\t}
\treturn strings.TrimSpace(auth[len(prefix):]), nil
}
`;
}

function goMiddleware(config: StackConfig, module: string, withAuth: boolean) {
  const fw = config.framework;
  // Per-framework import of the shared auth package. We import it only when
  // at least one endpoint needs protection (withAuth) — otherwise the
  // auth middleware is a no-op and we skip the dependency entirely.
  const authImport = withAuth ? `\n\t"${module}/internal/auth"` : "";
  if (fw === "gin") {
    return `package server

import (
\t"log/slog"
${withAuth ? '\t"net/http"\n' : ""}\t"time"

\t"github.com/gin-gonic/gin"${authImport}
)

func recoverer(log *slog.Logger) gin.HandlerFunc {
\treturn gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, err any) {
\t\tlog.Error("panic", "err", err)
\t\tc.AbortWithStatus(500)
\t})
}

func requestLog(log *slog.Logger) gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tstart := time.Now()
\t\tc.Next()
\t\tlog.Info("req", "m", c.Request.Method, "p", c.Request.URL.Path, "s", c.Writer.Status(), "d", time.Since(start))
\t}
}

${config.audit ? `func auditLog(log *slog.Logger) gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tc.Next()
\t\tlog.Info("audit", "method", c.Request.Method, "path", c.Request.URL.Path, "status", c.Writer.Status(), "ip", c.ClientIP())
\t}
}
` : ""}${
  withAuth
    ? `func authRequired(c *gin.Context) {
\traw, err := auth.ExtractBearer(c.Request.Header)
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing_or_malformed_token"})
\t\treturn
\t}
\tv, err := auth.Default()
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "auth_unconfigured"})
\t\treturn
\t}
\tclaims, err := v.Verify(c.Request.Context(), raw)
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
\t\treturn
\t}
\tc.Request = c.Request.WithContext(auth.NewContext(c.Request.Context(), claims))
\tc.Next()
}
`
    : `func authRequired(c *gin.Context) {
\t// Auth disabled — no provider configured for this stack.
\tc.Next()
}
`}`;
  }
  if (fw === "fiber") {
    return `package server

import (
\t"log/slog"
${withAuth ? '\t"net/http"\n' : ""}\t"time"

\t"github.com/gofiber/fiber/v2"${authImport}
)

func recoverer(log *slog.Logger) fiber.Handler {
\treturn func(c *fiber.Ctx) error {
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\tlog.Error("panic", "err", r)
\t\t\t\t_ = c.SendStatus(500)
\t\t\t}
\t\t}()
\t\treturn c.Next()
\t}
}

func requestLog(log *slog.Logger) fiber.Handler {
\treturn func(c *fiber.Ctx) error {
\t\tstart := time.Now()
\t\terr := c.Next()
\t\tlog.Info("req", "m", c.Method(), "p", c.Path(), "s", c.Response().StatusCode(), "d", time.Since(start))
\t\treturn err
\t}
}

${config.audit ? `func auditLog(log *slog.Logger) fiber.Handler {
\treturn func(c *fiber.Ctx) error {
\t\terr := c.Next()
\t\tlog.Info("audit", "method", c.Method(), "path", c.Path(), "status", c.Response().StatusCode(), "ip", c.IP())
\t\treturn err
\t}
}
` : ""}${
  withAuth
    ? `func authRequired(c *fiber.Ctx) error {
\traw, err := auth.ExtractBearer(http.Header(c.GetReqHeaders()))
\tif err != nil {
\t\treturn c.Status(401).JSON(fiber.Map{"error": "missing_or_malformed_token"})
\t}
\tv, err := auth.Default()
\tif err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": "auth_unconfigured"})
\t}
\tclaims, err := v.Verify(c.UserContext(), raw)
\tif err != nil {
\t\treturn c.Status(401).JSON(fiber.Map{"error": "invalid_token"})
\t}
\tc.SetUserContext(auth.NewContext(c.UserContext(), claims))
\treturn c.Next()
}
`
    : `func authRequired(c *fiber.Ctx) error { return c.Next() }
`}`;
  }
  if (fw === "echo") {
    return `package server

import (
\t"log/slog"
${withAuth ? '\t"net/http"\n' : ""}\t"time"

\t"github.com/labstack/echo/v4"${authImport}
)

func recoverer(log *slog.Logger) echo.MiddlewareFunc {
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) (err error) {
\t\t\tdefer func() {
\t\t\t\tif r := recover(); r != nil {
\t\t\t\t\tlog.Error("panic", "err", r)
\t\t\t\t\terr = c.NoContent(500)
\t\t\t\t}
\t\t\t}()
\t\t\treturn next(c)
\t\t}
\t}
}

func requestLog(log *slog.Logger) echo.MiddlewareFunc {
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) error {
\t\t\tstart := time.Now()
\t\t\terr := next(c)
\t\t\tlog.Info("req", "m", c.Request().Method, "p", c.Path(), "s", c.Response().Status, "d", time.Since(start))
\t\t\treturn err
\t\t}
\t}
}

${config.audit ? `func auditLog(log *slog.Logger) echo.MiddlewareFunc {
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) error {
\t\t\terr := next(c)
\t\t\tlog.Info("audit", "method", c.Request().Method, "path", c.Path(), "status", c.Response().Status, "ip", c.RealIP())
\t\t\treturn err
\t\t}
\t}
}
` : ""}${
  withAuth
    ? `func authRequired(next echo.HandlerFunc) echo.HandlerFunc {
\treturn func(c echo.Context) error {
\t\traw, err := auth.ExtractBearer(c.Request().Header)
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusUnauthorized, map[string]string{"error": "missing_or_malformed_token"})
\t\t}
\t\tv, err := auth.Default()
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusInternalServerError, map[string]string{"error": "auth_unconfigured"})
\t\t}
\t\tclaims, err := v.Verify(c.Request().Context(), raw)
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
\t\t}
\t\tc.SetRequest(c.Request().WithContext(auth.NewContext(c.Request().Context(), claims)))
\t\treturn next(c)
\t}
}
`
    : `func authRequired(next echo.HandlerFunc) echo.HandlerFunc { return next }
`}`;
  }
  // chi
  return `package server

import (
${withAuth ? '\t"encoding/json"\n' : ""}\t"log/slog"
\t"net/http"
\t"time"${withAuth ? "\n" + authImport : ""}
)

func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tdefer func() {
\t\t\t\tif rec := recover(); rec != nil {
\t\t\t\t\tlog.Error("panic", "err", rec)
\t\t\t\t\tw.WriteHeader(500)
\t\t\t\t}
\t\t\t}()
\t\t\tnext.ServeHTTP(w, r)
\t\t})
\t}
}

func requestLog(log *slog.Logger) func(http.Handler) http.Handler {
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tstart := time.Now()
\t\t\tnext.ServeHTTP(w, r)
\t\t\tlog.Info("req", "m", r.Method, "p", r.URL.Path, "d", time.Since(start))
\t\t})
\t}
}

${config.audit ? `func auditLog(log *slog.Logger) func(http.Handler) http.Handler {
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tnext.ServeHTTP(w, r)
\t\t\tlog.Info("audit", "method", r.Method, "path", r.URL.Path, "ip", r.RemoteAddr)
\t\t})
\t}
}
` : ""}${
  withAuth
    ? `func authRequired(next http.Handler) http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\traw, err := auth.ExtractBearer(r.Header)
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusUnauthorized, "missing_or_malformed_token")
\t\t\treturn
\t\t}
\t\tv, err := auth.Default()
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusInternalServerError, "auth_unconfigured")
\t\t\treturn
\t\t}
\t\tclaims, err := v.Verify(r.Context(), raw)
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusUnauthorized, "invalid_token")
\t\t\treturn
\t\t}
\t\tnext.ServeHTTP(w, r.WithContext(auth.NewContext(r.Context(), claims)))
\t})
}

func writeJSONErr(w http.ResponseWriter, status int, code string) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
`
    : `func authRequired(next http.Handler) http.Handler { return next }
`}`;
}

function goHealth(fw: GoFw) {
  const handler: Record<GoFw, string> = {
    gin: `func (s *Server) health(c *gin.Context) {
\tif c.Query("ready") == "" {
\t\tc.JSON(http.StatusOK, gin.H{"ok": true})
\t\treturn
\t}
\tcode, body := s.readiness(c.Request.Context())
\tc.JSON(code, body)
}`,
    fiber: `func (s *Server) health(c *fiber.Ctx) error {
\tif c.Query("ready") == "" {
\t\treturn c.JSON(fiber.Map{"ok": true})
\t}
\tcode, body := s.readiness(c.UserContext())
\treturn c.Status(code).JSON(body)
}`,
    echo: `func (s *Server) health(c echo.Context) error {
\tif c.QueryParam("ready") == "" {
\t\treturn c.JSON(http.StatusOK, map[string]any{"ok": true})
\t}
\tcode, body := s.readiness(c.Request().Context())
\treturn c.JSON(code, body)
}`,
    chi: `func (s *Server) health(w http.ResponseWriter, r *http.Request) {
\tif r.URL.Query().Get("ready") == "" {
\t\twriteJSON(w, http.StatusOK, map[string]any{"ok": true})
\t\treturn
\t}
\tcode, body := s.readiness(r.Context())
\twriteJSON(w, code, body)
}`,
  };
  const code = `// health is the liveness probe (/health). With ?ready=1 it is the readiness
// probe: every dependency registered in s.checks (database, cache) is pinged
// and any failure turns the response into a 503.
${handler[fw]}

func (s *Server) readiness(ctx context.Context) (int, map[string]any) {
\tctx, cancel := context.WithTimeout(ctx, 2*time.Second)
\tdefer cancel()
\tcode, body := http.StatusOK, map[string]any{"ok": true}
\tfor name, check := range s.checks {
\t\tif err := check(ctx); err != nil {
\t\t\tcode, body["ok"], body[name] = http.StatusServiceUnavailable, false, err.Error()
\t\t} else {
\t\t\tbody[name] = "ok"
\t\t}
\t}
\treturn code, body
}
`;
  return `package server

${goImports(code, [["context", "context"], ["http", "net/http"], ["time", "time"]], [[fw, fwImport[fw]]])}

${code}`;
}

function goSQLDB(database: string, kind: GoDbKind) {
  const mysql = kind === "mysql";
  const mysqlDSN = mysql ? `

// MySQLDSN converts the mysql://user:pass@host:3306/db?param=value URL used in
// .env.example into the DSN go-sql-driver/mysql expects
// (user:pass@tcp(host:3306)/db?parseTime=true). Values that are not mysql://
// URLs are assumed to already be driver DSNs and pass through unchanged.
func MySQLDSN(raw string) (string, error) {
\tif !strings.HasPrefix(raw, "mysql://") {
\t\treturn raw, nil
\t}
\tu, err := url.Parse(raw)
\tif err != nil {
\t\treturn "", fmt.Errorf("DATABASE_URL: %w", err)
\t}
\tc := mysql.NewConfig()
\tc.User = u.User.Username()
\tc.Passwd, _ = u.User.Password()
\tc.Net = "tcp"
\tc.Addr = u.Host
\tc.DBName = strings.TrimPrefix(u.Path, "/")
\tc.ParseTime = true${database === "planetscale" ? `
\tc.TLSConfig = "true" // PlanetScale only accepts TLS connections` : ""}
\tq := u.Query()
\tif tls := q.Get("tls"); tls != "" {
\t\tc.TLSConfig = tls
\t\tq.Del("tls")
\t}
\tif len(q) > 0 {
\t\tc.Params = map[string]string{}
\t\tfor k := range q {
\t\t\tc.Params[k] = q.Get(k)
\t\t}
\t}
\treturn c.FormatDSN(), nil
}` : "";
  return `package db

import (
\t"context"
\t"database/sql"
\t"errors"
\t"fmt"
\t"log"
${mysql ? `\t"net/url"\n\t"strings"\n` : ""}\t"time"

${mysql ? `\t"github.com/go-sql-driver/mysql"` : `\t_ "github.com/jackc/pgx/v5/stdlib"`}
)

// Open connects to the database and retries transient errors with exponential
// backoff (up to ~30s total). Kubernetes pods frequently come up before their
// database StatefulSet / managed instance accepts connections — without retry
// the API pod restarts and delays rollout.
//
// Pool sizing (25 open / 10 idle / 30m lifetime) is a sane default for a
// single-instance API. Tune it to your database's connection limit.
func Open(dsn string) (*sql.DB, error) {
\t// db: ${database}
${mysql ? `\tdsn, err := MySQLDSN(dsn)
\tif err != nil {
\t\treturn nil, err
\t}
\tconn, err := sql.Open("mysql", dsn)` : `\tconn, err := sql.Open("pgx", dsn)`}
\tif err != nil {
\t\treturn nil, fmt.Errorf("sql.Open: %w", err)
\t}
\tconn.SetMaxOpenConns(25)
\tconn.SetMaxIdleConns(10)
\tconn.SetConnMaxLifetime(30 * time.Minute)

\tctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
\tdefer cancel()

\tvar lastErr error
\tbackoff := 200 * time.Millisecond
\tfor attempt := 1; attempt <= 6; attempt++ {
\t\tif err := conn.PingContext(ctx); err == nil {
\t\t\treturn conn, nil
\t\t} else {
\t\t\tlastErr = err
\t\t\tif errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
\t\t\t\tbreak
\t\t\t}
\t\t\tlog.Printf("db: ping failed (attempt %d/6): %v — retrying in %s", attempt, err, backoff)
\t\t\tselect {
\t\t\tcase <-ctx.Done():
\t\t\t\treturn nil, fmt.Errorf("db: context cancelled while retrying: %w", ctx.Err())
\t\t\tcase <-time.After(backoff):
\t\t\t}
\t\t\tbackoff *= 2
\t\t\tif backoff > 5*time.Second {
\t\t\t\tbackoff = 5 * time.Second
\t\t\t}
\t\t}
\t}
\treturn nil, fmt.Errorf("db: could not connect after retries: %w", lastErr)
}${mysqlDSN}
`;
}

function goRedis() {
  return `package cache

import (
\t"context"
\t"errors"
\t"time"

\t"github.com/redis/go-redis/v9"
)

// Open builds a client from REDIS_URL and pings it. A failed ping is returned
// alongside a usable client: go-redis reconnects on its own, so a cache that
// comes up after the API heals without a restart. A nil client means the URL
// is missing or invalid.
func Open(url string) (*redis.Client, error) {
\tif url == "" {
\t\treturn nil, errors.New("REDIS_URL is not set")
\t}
\topt, err := redis.ParseURL(url)
\tif err != nil {
\t\treturn nil, err
\t}
\tc := redis.NewClient(opt)
\tctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
\tdefer cancel()
\treturn c, c.Ping(ctx).Err()
}
`;
}
function fiberMethod(m: string) {
  return m[0] + m.slice(1).toLowerCase();
}

function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p)));
  return cap(e.method.toLowerCase()) + parts.join("");
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

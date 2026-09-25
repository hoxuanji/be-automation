import type { Endpoint, Entity, EntityField, GeneratedFile, StackConfig } from "../types";
import { safeName, toPascal, toSnake } from "../types";
import { GO_IP_LIMITER, goAuthMode, goDbKind, goDatadogInit, goImports, goRateLimitTest, goSentryInit, goTracing } from "../go";
import { creatableFields, pkOf, protectedRpcs, protoField, protoJsonName, serverTimestamps } from "./proto";

/**
 * Emits a Go gRPC server. Assumes the user runs `make proto` once after
 * cloning to produce the generated stubs under `gen/go/`. We deliberately do
 * NOT commit generated code from Helios — users regenerate from their own
 * proto edits, and committing stale generated Go into every Helios zip would
 * be noise.
 *
 * Entity RPCs run on the same data layer as the REST handlers: `rest` is the
 * REST tree for this config, and its config, internal/db, internal/models and
 * internal/auth packages are reused as-is.
 */
export function goGrpcFiles(
  config: StackConfig,
  entities: Entity[],
  endpoints: Endpoint[] = [],
  rest: GeneratedFile[] = []
): GeneratedFile[] {
  const name = safeName(config.name);
  const module = `github.com/your-username/${name}`;
  const protoPkg = `${name.replace(/-/g, "_")}.v1`;
  const pkgPath = `${module}/gen/go/${name.replace(/-/g, "_")}/v1`;
  const o = goGrpcObservability(config);
  const kind = goDbKind(config.database);
  const store: GoStore = entities.length === 0 ? "none"
    : kind === "postgres" || kind === "mysql" || kind === "sqlite" ? "gorm"
    : kind === "mongo" ? "mongo"
    : "memory";
  // Full method names ("/pkg.v1.UserService/GetUser") the auth interceptor guards.
  const guarded = goAuthMode(config, endpoints) === "off" ? []
    : entities.flatMap((e) => protectedRpcs(e, endpoints).map((rpc) => `/${protoPkg}.${e.name}Service/${rpc}`));

  const files: GeneratedFile[] = [];
  const reuse = (re: RegExp) => files.push(...rest.filter((f) => re.test(f.path)));
  reuse(/^internal\/config\/config\.go$/);
  if (store !== "none") reuse(/^internal\/(db|models)\//);
  if (guarded.length > 0) reuse(/^internal\/auth\//);

  files.push({
    path: "cmd/api/main.go",
    content: goGrpcMain(module, pkgPath, config, entities, o, store, guarded.length > 0),
  });

  if (store !== "none") {
    files.push({ path: "internal/grpcserver/server.go", content: goGrpcServer(module, store) });
  }

  for (const entity of entities) {
    files.push({
      path: `internal/grpcserver/${toSnake(entity.name)}_service.go`,
      content: store === "gorm" ? goGrpcGormService(module, pkgPath, entity) : goGrpcDocService(module, pkgPath, entity),
    });
  }

  files.push({
    path: "internal/grpcserver/health.go",
    content: goGrpcHealth(),
  });

  const interceptors = goGrpcInterceptors(config, o, module, guarded);
  if (interceptors) files.push({ path: "internal/grpcserver/interceptors.go", content: interceptors });
  if (config.rateLimit) files.push({ path: "internal/grpcserver/ratelimit_test.go", content: goRateLimitTest("grpcserver") });
  // Same provider setup as the REST tree; the per-RPC spans come from otelgrpc.
  if (o.tracing) files.push({ path: "internal/tracing/tracing.go", content: goTracing("chi") });
  if (o.monitoring === "sentry") files.push({ path: "internal/monitoring/sentry.go", content: goSentryInit("chi") });
  if (o.monitoring === "datadog") files.push({ path: "internal/monitoring/datadog.go", content: goDatadogInit("chi") });

  return files;
}

// Which REST data layer backs the entity services.
type GoStore = "gorm" | "mongo" | "memory" | "none";

type GoGrpcObs = { tracing: boolean; monitoring: "prometheus" | "sentry" | "datadog" | "none" };

// Mirrors go.ts goFiles: OTel monitoring implies tracing.
function goGrpcObservability(config: StackConfig): GoGrpcObs {
  return {
    tracing: config.tracing || config.monitoring === "otel",
    monitoring: /prometheus|grafana/.test(config.monitoring) ? "prometheus"
      : /sentry/.test(config.monitoring) ? "sentry"
      : /datadog/.test(config.monitoring) ? "datadog"
      : "none",
  };
}

// Unary + stream interceptors for the cross-cutting flags. The generated proto
// is all unary; the stream variants cover RPCs users add later. Tracing needs
// no interceptor: the otelgrpc stats handler already spans every RPC kind.
function goGrpcInterceptors(config: StackConfig, o: GoGrpcObs, module: string, guarded: string[]): string {
  const parts: string[] = [];
  if (config.rateLimit || config.audit) {
    parts.push(`// peerIP is the client address without the port.
func peerIP(ctx context.Context) string {
\tp, ok := peer.FromContext(ctx)
\tif !ok {
\t\treturn "unknown"
\t}
\thost, _, err := net.SplitHostPort(p.Addr.String())
\tif err != nil {
\t\treturn p.Addr.String()
\t}
\treturn host
}`);
  }
  if (config.rateLimit) {
    parts.push(`${GO_IP_LIMITER}

// limiter is shared so unary calls and stream opens draw from one bucket per IP.
var limiter = newIPLimiter()

// RateLimit rejects RPCs with ResourceExhausted once a client IP exceeds its bucket.
func RateLimit() grpc.UnaryServerInterceptor {
\treturn func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
\t\tif !limiter.allow(peerIP(ctx)) {
\t\t\treturn nil, status.Error(codes.ResourceExhausted, "rate_limited")
\t\t}
\t\treturn handler(ctx, req)
\t}
}

// RateLimitStream is RateLimit for streaming RPCs.
// ponytail: charges one token per stream open, not per message; wrap
// grpc.ServerStream.RecvMsg if long-lived streams need per-message limits.
func RateLimitStream() grpc.StreamServerInterceptor {
\treturn func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
\t\tif !limiter.allow(peerIP(ss.Context())) {
\t\t\treturn status.Error(codes.ResourceExhausted, "rate_limited")
\t\t}
\t\treturn handler(srv, ss)
\t}
}`);
  }
  if (config.audit) {
    parts.push(`// Audit logs one structured line per RPC.
func Audit(log *slog.Logger) grpc.UnaryServerInterceptor {
\treturn func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
\t\tresp, err := handler(ctx, req)
\t\tlog.Info("audit", "method", info.FullMethod, "code", status.Code(err).String(), "ip", peerIP(ctx))
\t\treturn resp, err
\t}
}

// AuditStream logs one line when a streaming RPC ends, with its final status.
func AuditStream(log *slog.Logger) grpc.StreamServerInterceptor {
\treturn func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
\t\terr := handler(srv, ss)
\t\tlog.Info("audit", "method", info.FullMethod, "code", status.Code(err).String(), "ip", peerIP(ss.Context()))
\t\treturn err
\t}
}`);
  }
  if (o.monitoring === "prometheus") {
    parts.push(`var (
\trpcsHandled = promauto.NewCounterVec(prometheus.CounterOpts{
\t\tName: "grpc_server_handled_total",
\t\tHelp: "RPCs completed on the server, by method and status code.",
\t}, []string{"grpc_method", "grpc_code"})
\trpcSeconds = promauto.NewHistogramVec(prometheus.HistogramOpts{
\t\tName:    "grpc_server_handling_seconds",
\t\tHelp:    "RPC latency on the server, by method.",
\t\tBuckets: prometheus.DefBuckets,
\t}, []string{"grpc_method"})
)

// Metrics records per-RPC count and latency; cmd/api serves them on METRICS_PORT.
func Metrics() grpc.UnaryServerInterceptor {
\treturn func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
\t\tstart := time.Now()
\t\tresp, err := handler(ctx, req)
\t\trpcsHandled.WithLabelValues(info.FullMethod, status.Code(err).String()).Inc()
\t\trpcSeconds.WithLabelValues(info.FullMethod).Observe(time.Since(start).Seconds())
\t\treturn resp, err
\t}
}

// MetricsStream is Metrics for streaming RPCs; latency is the stream's lifetime.
func MetricsStream() grpc.StreamServerInterceptor {
\treturn func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
\t\tstart := time.Now()
\t\terr := handler(srv, ss)
\t\trpcsHandled.WithLabelValues(info.FullMethod, status.Code(err).String()).Inc()
\t\trpcSeconds.WithLabelValues(info.FullMethod).Observe(time.Since(start).Seconds())
\t\treturn err
\t}
}`);
  }
  if (o.monitoring === "sentry") {
    parts.push(`// SentryRecover reports a panicking RPC to Sentry and answers Internal
// instead of crashing the process.
func SentryRecover() grpc.UnaryServerInterceptor {
\treturn func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\tsentry.CurrentHub().Recover(r)
\t\t\t\terr = status.Error(codes.Internal, "internal error")
\t\t\t}
\t\t}()
\t\treturn handler(ctx, req)
\t}
}

// SentryRecoverStream is SentryRecover for streaming RPCs.
func SentryRecoverStream() grpc.StreamServerInterceptor {
\treturn func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\tsentry.CurrentHub().Recover(r)
\t\t\t\terr = status.Error(codes.Internal, "internal error")
\t\t\t}
\t\t}()
\t\treturn handler(srv, ss)
\t}
}`);
  }
  if (guarded.length > 0) {
    parts.push(`// protectedRPCs are the entity RPCs whose REST routes require auth.
var protectedRPCs = []string{
${guarded.map((m) => `\t"${m}",`).join("\n")}
}

// Auth requires a valid bearer token in the "authorization" metadata for
// protectedRPCs, checked by the same verifier (internal/auth) as the REST
// middleware. Innermost in the chain, like the REST route-level guard.
func Auth() grpc.UnaryServerInterceptor {
\treturn func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
\t\tif !slices.Contains(protectedRPCs, info.FullMethod) {
\t\t\treturn handler(ctx, req)
\t\t}
\t\tmd, _ := metadata.FromIncomingContext(ctx)
\t\th := http.Header{}
\t\tfor _, v := range md.Get("authorization") {
\t\t\th.Add("Authorization", v)
\t\t}
\t\traw, err := auth.ExtractBearer(h)
\t\tif err != nil {
\t\t\treturn nil, status.Error(codes.Unauthenticated, "missing_or_malformed_token")
\t\t}
\t\tv, err := auth.Default()
\t\tif err != nil {
\t\t\treturn nil, status.Error(codes.Internal, "auth_unconfigured")
\t\t}
\t\tclaims, err := v.Verify(ctx, raw)
\t\tif err != nil {
\t\t\treturn nil, status.Error(codes.Unauthenticated, "invalid_token")
\t\t}
\t\treturn handler(auth.NewContext(ctx, claims), req)
\t}
}`);
  }
  if (parts.length === 0) return "";
  const code = parts.join("\n\n") + "\n";
  return `package grpcserver

${goImports(code, [["context", "context"], ["slog", "log/slog"], ["net", "net"], ["http", "net/http"], ["slices", "slices"], ["sync", "sync"], ["time", "time"]], [
    ["auth", `${module}/internal/auth`],
    ["sentry", "github.com/getsentry/sentry-go"],
    ["prometheus", "github.com/prometheus/client_golang/prometheus"],
    ["promauto", "github.com/prometheus/client_golang/prometheus/promauto"],
    ["rate", "golang.org/x/time/rate"],
    ["grpc", "google.golang.org/grpc"],
    ["codes", "google.golang.org/grpc/codes"],
    ["metadata", "google.golang.org/grpc/metadata"],
    ["peer", "google.golang.org/grpc/peer"],
    ["status", "google.golang.org/grpc/status"],
  ])}

${code}`;
}

function goGrpcMain(module: string, pkgPath: string, config: StackConfig, entities: Entity[], o: GoGrpcObs, store: GoStore, withAuth: boolean): string {
  const handle = store === "gorm" ? "gormDB" : "store";
  const registrations = entities
    .map((e) => `\tpb.Register${e.name}ServiceServer(grpcSrv, grpcserver.New${e.name}Service(${handle}))`)
    .join("\n");
  // Same connection setup as the REST server (internal/server goServerDeps).
  const openDb = store === "gorm" ? `\tgormDB, err := db.OpenGorm(cfg.DatabaseURL)
\tif err != nil {
\t\tlog.Error("database", "err", err)
\t\tos.Exit(1)
\t}
\tif sqlDB, err := gormDB.DB(); err == nil {
\t\tclosers = append(closers, func(context.Context) error { return sqlDB.Close() })
\t}`
    : store === "mongo" ? `\tstore, err := db.OpenMongo(context.Background(), cfg.MongoURI)
\tif err != nil {
\t\tlog.Error("database", "err", err)
\t\tos.Exit(1)
\t}
\tclosers = append(closers, store.Close)`
    : store === "memory" ? `\t// ponytail: in-memory store — no ${config.database || "database"} repository is generated (see internal/db/docstore.go).
\tstore := db.NewMemoryStore()`
    : "";

  // Outermost first — same order as the REST middleware chain in go.ts goServer.
  const unary = [
    o.monitoring === "sentry" ? "grpcserver.SentryRecover()" : "",
    o.monitoring === "datadog" ? "grpctrace.UnaryServerInterceptor(grpctrace.WithServiceName(cfg.AppName))" : "",
    o.monitoring === "prometheus" ? "grpcserver.Metrics()" : "",
    config.rateLimit ? "grpcserver.RateLimit()" : "",
    config.audit ? "grpcserver.Audit(log)" : "",
    withAuth ? "grpcserver.Auth()" : "",
  ].filter(Boolean);
  // Same chain for streaming RPCs, so user-added stream methods are covered.
  const stream = [
    o.monitoring === "sentry" ? "grpcserver.SentryRecoverStream()" : "",
    o.monitoring === "datadog" ? "grpctrace.StreamServerInterceptor(grpctrace.WithServiceName(cfg.AppName))" : "",
    o.monitoring === "prometheus" ? "grpcserver.MetricsStream()" : "",
    config.rateLimit ? "grpcserver.RateLimitStream()" : "",
    config.audit ? "grpcserver.AuditStream(log)" : "",
  ].filter(Boolean);
  const opts = [
    o.tracing ? "\t\tgrpc.StatsHandler(otelgrpc.NewServerHandler()), // one span per RPC" : "",
    unary.length ? `\t\tgrpc.ChainUnaryInterceptor(\n${unary.map((u) => `\t\t\t${u},`).join("\n")}\n\t\t),` : "",
    stream.length ? `\t\tgrpc.ChainStreamInterceptor(\n${stream.map((u) => `\t\t\t${u},`).join("\n")}\n\t\t),` : "",
  ].filter(Boolean);
  const newServer = opts.length ? `grpc.NewServer(\n${opts.join("\n")}\n\t)` : "grpc.NewServer()";

  const deps = [
    o.tracing ? `\tif shutdown, err := tracing.Init(context.Background(), cfg.AppName); err != nil {
\t\tlog.Warn("tracing disabled", "err", err)
\t} else {
\t\tclosers = append(closers, shutdown)
\t}` : "",
    o.monitoring === "sentry" ? "\tclosers = append(closers, monitoring.InitSentry(log))" : "",
    o.monitoring === "datadog" ? "\tclosers = append(closers, monitoring.InitDatadog(cfg.AppName, log))" : "",
    openDb,
  ].filter(Boolean).join("\n");

  const prom = o.monitoring === "prometheus";
  const code = `func main() {
\tlog := slog.New(slog.NewJSONHandler(os.Stdout, nil))
\tslog.SetDefault(log)

\tcfg, err := config.Load()
\tif err != nil {
\t\tlog.Error("config", "err", err)
\t\tos.Exit(1)
\t}

\t// closers run in reverse on shutdown (tracing flush, APM stop).
\tvar closers []func(context.Context) error
${deps ? deps + "\n" : ""}
\tlis, err := net.Listen("tcp", ":"+cfg.Port)
\tif err != nil {
\t\tlog.Error("listen", "err", err)
\t\tos.Exit(1)
\t}

\tgrpcSrv := ${newServer}

${registrations ? registrations + "\n\n" : ""}\t// Standard gRPC health service — probes use grpc-health-probe or
\t// the grpc.health.v1.Health endpoint.
\thealthSrv := health.NewServer()
\thealthpb.RegisterHealthServer(grpcSrv, healthSrv)
\thealthSrv.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

\t// Server reflection makes tools like grpcurl / bloomrpc work without a proto file.
\treflection.Register(grpcSrv)
${prom ? `
\t// Prometheus scrapes this plain-HTTP listener; the gRPC port only speaks HTTP/2.
\tmetricsAddr := ":" + os.Getenv("METRICS_PORT")
\tif metricsAddr == ":" {
\t\tmetricsAddr = ":9464"
\t}
\tmetricsSrv := &http.Server{Addr: metricsAddr, Handler: promhttp.Handler(), ReadHeaderTimeout: 10 * time.Second}
\tgo func() {
\t\tif err := metricsSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
\t\t\tlog.Error("metrics", "err", err)
\t\t}
\t}()
` : ""}
\tgo func() {
\t\tlog.Info("gRPC server listening", "addr", lis.Addr().String())
\t\tif err := grpcSrv.Serve(lis); err != nil {
\t\t\tlog.Error("serve", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\tctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
\tdefer stop()
\t<-ctx.Done()

\tlog.Info("shutdown requested; draining connections")
\thealthSrv.SetServingStatus("", healthpb.HealthCheckResponse_NOT_SERVING)
\tgrpcSrv.GracefulStop()

\tshutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
${prom ? "\t_ = metricsSrv.Shutdown(shutdown)\n" : ""}\tfor i := len(closers) - 1; i >= 0; i-- {
\t\tif err := closers[i](shutdown); err != nil {
\t\t\tlog.Warn("shutdown", "err", err)
\t\t}
\t}
}
`;
  return `package main

${goImports(code, [["context", "context"], ["errors", "errors"], ["slog", "log/slog"], ["net", "net"], ["http", "net/http"], ["os", "os"], ["signal", "os/signal"], ["syscall", "syscall"], ["time", "time"]], [
    ["config", `${module}/internal/config`],
    ["db", `${module}/internal/db`],
    ["grpcserver", `${module}/internal/grpcserver`],
    ["monitoring", `${module}/internal/monitoring`],
    ["tracing", `${module}/internal/tracing`],
    ["pb", pkgPath],
    ["promhttp", "github.com/prometheus/client_golang/prometheus/promhttp"],
    ["otelgrpc", "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"],
    ["grpc", "google.golang.org/grpc"],
    ["health", "google.golang.org/grpc/health"],
    ["healthpb", "google.golang.org/grpc/health/grpc_health_v1"],
    ["reflection", "google.golang.org/grpc/reflection"],
    ["grpctrace", "gopkg.in/DataDog/dd-trace-go.v1/contrib/google.golang.org/grpc"],
  ])}

${code}`;
}

// Helpers shared by the entity services: List paging and data-layer error →
// gRPC status mapping, for whichever REST data layer backs them.
function goGrpcServer(module: string, store: GoStore): string {
  const gorm = store === "gorm";
  const notFound = gorm ? "errors.Is(err, gorm.ErrRecordNotFound)" : "errors.Is(err, db.ErrNotFound)";
  const dup = gorm
    ? `\t// ponytail: matches the driver's wording (Postgres "duplicate key", MySQL
\t// "Duplicate entry", SQLite "UNIQUE constraint failed"). Set
\t// gorm.Config{TranslateError: true} to rely on gorm.ErrDuplicatedKey alone.
\tmsg := strings.ToLower(err.Error())
\tif errors.Is(err, gorm.ErrDuplicatedKey) || strings.Contains(msg, "duplicate") || strings.Contains(msg, "unique constraint") {
\t\treturn status.Error(codes.AlreadyExists, "already exists")
\t}
`
    : store === "mongo" ? `\tif mongo.IsDuplicateKeyError(err) {
\t\treturn status.Error(codes.AlreadyExists, "already exists")
\t}
` : "";
  const docHelpers = gorm ? "" : `

// toDoc turns a request message into the JSON-shaped document the DocStore
// keeps (protojson field names, RFC 3339 timestamps). full also writes unset
// fields, so an Update replaces the whole document.
func toDoc(m proto.Message, full bool) (map[string]any, error) {
\tb, err := protojson.MarshalOptions{EmitUnpopulated: full}.Marshal(m)
\tif err != nil {
\t\treturn nil, err
\t}
\tvar d map[string]any
\treturn d, json.Unmarshal(b, &d)
}

// fromDoc decodes a stored document into out, ignoring unknown keys.
func fromDoc(d map[string]any, out proto.Message) error {
\tb, err := json.Marshal(d)
\tif err != nil {
\t\treturn err
\t}
\treturn protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(b, out)
}

// now is the server-managed createdAt / updatedAt value, in protojson form.
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }`;
  const code = `// pageOf applies the List defaults: page 1, 20 items, at most 100 per page.
func pageOf(page, size uint32) (uint32, uint32) {
\tif page == 0 {
\t\tpage = 1
\t}
\tif size == 0 {
\t\tsize = 20
\t}
\treturn page, min(size, 100)
}
${gorm ? `
// asTime converts an optional Timestamp; unset maps to the zero time.
func asTime(ts *timestamppb.Timestamp) time.Time {
\tif ts == nil {
\t\treturn time.Time{}
\t}
\treturn ts.AsTime()
}
` : ""}
// dbError maps a data-layer error to a gRPC status. Unexpected errors are
// logged and answered with Internal so driver details don't reach clients.
func dbError(err error) error {
\tif ${notFound} {
\t\treturn status.Error(codes.NotFound, "not found")
\t}
${dup}\tslog.Error("database", "err", err)
\treturn status.Error(codes.Internal, "internal error")
}${docHelpers}
`;
  return `package grpcserver

${goImports(code, [["json", "encoding/json"], ["errors", "errors"], ["slog", "log/slog"], ["strings", "strings"], ["time", "time"]], [
    ["db", `${module}/internal/db`],
    ["mongo", "go.mongodb.org/mongo-driver/mongo"],
    ["codes", "google.golang.org/grpc/codes"],
    ["status", "google.golang.org/grpc/status"],
    ["protojson", "google.golang.org/protobuf/encoding/protojson"],
    ["proto", "google.golang.org/protobuf/proto"],
    ["timestamppb", "google.golang.org/protobuf/types/known/timestamppb"],
    ["gorm", "gorm.io/gorm"],
  ])}

${code}`;
}

// protoc-gen-go's Go name for a proto field ("created_at" → "CreatedAt").
const goPbName = (f: EntityField) => protoField(f).split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
const isText = (f: EntityField) => f.type === "string" || f.type === "text" || f.type === "uuid";

// InvalidArgument checks for a Create/Update request: required text fields
// must be non-empty, required timestamps set, JSON payloads valid.
function goValidate(fields: EntityField[]): string {
  const bad = (cond: string, msg: string) => `\tif ${cond} {\n\t\treturn nil, status.Error(codes.InvalidArgument, "${msg}")\n\t}\n`;
  return fields.map((f) => {
    const get = `req.Get${goPbName(f)}()`;
    const n = protoField(f);
    if (f.type === "json") return (f.required ? bad(`len(${get}) == 0`, `${n} is required`) : "") + bad(`len(${get}) > 0 && !json.Valid(${get})`, `${n} must be valid JSON`);
    if (!f.required) return "";
    if (isText(f)) return bad(`${get} == ""`, `${n} is required`);
    if (f.type === "date") return bad(`${get} == nil`, `${n} is required`);
    return "";
  }).join("");
}

// The primary key as a query argument, with an InvalidArgument guard.
function goKey(entity: Entity): { check: string; arg: string; col: string } {
  const pk = pkOf(entity);
  const get = `req.Get${goPbName(pk)}()`;
  const num = pk.type === "number";
  return {
    check: `\tif ${get} == ${num ? "0" : `""`} {\n\t\treturn nil, status.Error(codes.InvalidArgument, "${protoField(pk)} is required")\n\t}\n`,
    arg: num ? `int64(${get})` : get,
    col: toSnake(pk.name),
  };
}

// Entity service on the gorm models the REST handlers use (internal/models).
function goGrpcGormService(module: string, pkgPath: string, entity: Entity): string {
  const name = entity.name;
  const lc = name[0].toLowerCase() + name.slice(1);
  const key = goKey(entity);
  const pk = pkOf(entity);
  const toPB = [...entity.fields, ...serverTimestamps(entity)].map((f) => {
    const m = `m.${toPascal(f.name)}`;
    const v = f.type === "number" ? `float64(${m})` : f.type === "date" ? `timestamppb.New(${m})` : f.type === "json" ? `[]byte(${m})` : m;
    return `\tout.${goPbName(f)} = ${v}`;
  }).join("\n");
  const assign = (fields: EntityField[]) => fields.map((f) => {
    const get = `req.Get${goPbName(f)}()`;
    const v = f.type === "number" ? `int64(${get})` : f.type === "date" ? `asTime(${get})` : f.type === "json" ? `datatypes.JSON(${get})` : get;
    return `\tm.${toPascal(f.name)} = ${v}`;
  }).join("\n");
  const createFields = creatableFields(entity);
  const updateFields = entity.fields.filter((f) => f !== pk);
  const where = `"${key.col} = ?", ${key.arg}`;

  const code = `// ${name}Service implements pb.${name}ServiceServer on the gorm models the
// REST handlers use (internal/models). Errors map to gRPC codes in dbError.
type ${name}Service struct {
\tpb.Unimplemented${name}ServiceServer
\tdb *gorm.DB
}

func New${name}Service(db *gorm.DB) *${name}Service {
\treturn &${name}Service{db: db}
}

func ${lc}ToPB(m *models.${name}) *pb.${name} {
\tout := &pb.${name}{}
${toPB}
\treturn out
}

func (s *${name}Service) List${name}(ctx context.Context, req *pb.List${name}Request) (*pb.List${name}Response, error) {
\tpage, size := pageOf(req.GetPage(), req.GetPageSize())
\tvar total int64
\tif err := s.db.WithContext(ctx).Model(&models.${name}{}).Count(&total).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
\tvar rows []models.${name}
\tif err := s.db.WithContext(ctx).Order("${key.col}").Offset(int((page - 1) * size)).Limit(int(size)).Find(&rows).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
\tout := &pb.List${name}Response{Total: uint32(total), Page: page, PageSize: size}
\tfor i := range rows {
\t\tout.Items = append(out.Items, ${lc}ToPB(&rows[i]))
\t}
\treturn out, nil
}

func (s *${name}Service) Get${name}(ctx context.Context, req *pb.Get${name}Request) (*pb.${name}, error) {
${key.check}\tvar m models.${name}
\tif err := s.db.WithContext(ctx).First(&m, ${where}).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}ToPB(&m), nil
}

func (s *${name}Service) Create${name}(ctx context.Context, req *pb.Create${name}Request) (*pb.${name}, error) {
${goValidate(createFields)}\tvar m models.${name}
${assign(createFields)}
\tif err := s.db.WithContext(ctx).Create(&m).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}ToPB(&m), nil
}

// Update${name} replaces every field (the proto has no field mask).
func (s *${name}Service) Update${name}(ctx context.Context, req *pb.Update${name}Request) (*pb.${name}, error) {
${key.check}${goValidate(updateFields)}\tvar m models.${name}
\tif err := s.db.WithContext(ctx).First(&m, ${where}).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
${assign(updateFields)}
\tif err := s.db.WithContext(ctx).Save(&m).Error; err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}ToPB(&m), nil
}

func (s *${name}Service) Delete${name}(ctx context.Context, req *pb.Delete${name}Request) (*emptypb.Empty, error) {
${key.check}\tres := s.db.WithContext(ctx).Delete(&models.${name}{}, ${where})
\tif res.Error != nil {
\t\treturn nil, dbError(res.Error)
\t}
\tif res.RowsAffected == 0 {
\t\treturn nil, status.Error(codes.NotFound, "not found")
\t}
\treturn &emptypb.Empty{}, nil
}
`;
  return `package grpcserver

${goImports(code, [["context", "context"], ["json", "encoding/json"]], [
    ["models", `${module}/internal/models`],
    ["pb", pkgPath],
    ["codes", "google.golang.org/grpc/codes"],
    ["status", "google.golang.org/grpc/status"],
    ["emptypb", "google.golang.org/protobuf/types/known/emptypb"],
    ["timestamppb", "google.golang.org/protobuf/types/known/timestamppb"],
    ["datatypes", "gorm.io/datatypes"],
    ["gorm", "gorm.io/gorm"],
  ])}

${code}`;
}

// Entity service on the REST DocStore (MongoDB, or the in-memory store for
// databases without a generated repository). Documents live in the same
// collection as the REST handlers', keyed by "id".
function goGrpcDocService(module: string, pkgPath: string, entity: Entity): string {
  const name = entity.name;
  const lc = name[0].toLowerCase() + name.slice(1);
  const pk = pkOf(entity);
  const key = goKey(entity);
  const pkJson = protoJsonName(pk);
  const stamps = serverTimestamps(entity).map((f) => f.name);
  // ponytail: a numeric primary key is stored as its decimal string.
  const id = pk.type === "number" ? `fmt.Sprint(${key.arg})` : key.arg;
  // A primary key not named "id" is mirrored into the store's "id" key.
  const toStoreId = pkJson === "id" ? "" : `\tif v, ok := d["${pkJson}"]; ok {\n\t\td["id"] = v\n\t}\n`;
  const fromStoreId = pkJson === "id" ? "" : `\td["${pkJson}"] = d["id"]\n`;
  const code = `const ${lc}Collection = "${toSnake(entity.name)}s"

// ${name}Service implements pb.${name}ServiceServer on the DocStore the REST
// handlers use (internal/db). Errors map to gRPC codes in dbError.
type ${name}Service struct {
\tpb.Unimplemented${name}ServiceServer
\tstore db.DocStore
}

func New${name}Service(store db.DocStore) *${name}Service {
\treturn &${name}Service{store: store}
}

func ${lc}FromDoc(d map[string]any) (*pb.${name}, error) {
${fromStoreId}\tout := &pb.${name}{}
\tif err := fromDoc(d, out); err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn out, nil
}

// List${name} pages in memory, ordered by id.
// ponytail: DocStore.List loads the whole collection; add skip/limit to the
// DocStore interface once collections outgrow memory.
func (s *${name}Service) List${name}(ctx context.Context, req *pb.List${name}Request) (*pb.List${name}Response, error) {
\tpage, size := pageOf(req.GetPage(), req.GetPageSize())
\tdocs, err := s.store.List(ctx, ${lc}Collection)
\tif err != nil {
\t\treturn nil, dbError(err)
\t}
\tsort.Slice(docs, func(i, j int) bool { return fmt.Sprint(docs[i]["id"]) < fmt.Sprint(docs[j]["id"]) })
\tout := &pb.List${name}Response{Total: uint32(len(docs)), Page: page, PageSize: size}
\tstart := min(int((page-1)*size), len(docs))
\tfor _, d := range docs[start:min(start+int(size), len(docs))] {
\t\titem, err := ${lc}FromDoc(d)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\tout.Items = append(out.Items, item)
\t}
\treturn out, nil
}

func (s *${name}Service) Get${name}(ctx context.Context, req *pb.Get${name}Request) (*pb.${name}, error) {
${key.check}\td, err := s.store.Get(ctx, ${lc}Collection, ${id})
\tif err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}FromDoc(d)
}

func (s *${name}Service) Create${name}(ctx context.Context, req *pb.Create${name}Request) (*pb.${name}, error) {
${goValidate(creatableFields(entity))}\td, err := toDoc(req, false)
\tif err != nil {
\t\treturn nil, status.Error(codes.InvalidArgument, err.Error())
\t}
${toStoreId}${stamps.map((n) => `\td["${n}"] = now()\n`).join("")}\td, err = s.store.Create(ctx, ${lc}Collection, d)
\tif err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}FromDoc(d)
}

// Update${name} replaces every field (the proto has no field mask).
func (s *${name}Service) Update${name}(ctx context.Context, req *pb.Update${name}Request) (*pb.${name}, error) {
${key.check}${goValidate(entity.fields.filter((f) => f !== pk))}\td, err := toDoc(req, true)
\tif err != nil {
\t\treturn nil, status.Error(codes.InvalidArgument, err.Error())
\t}
\tdelete(d, "${pkJson}")
${stamps.includes("updatedAt") ? `\td["updatedAt"] = now()\n` : ""}\td, err = s.store.Update(ctx, ${lc}Collection, ${id}, d)
\tif err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn ${lc}FromDoc(d)
}

func (s *${name}Service) Delete${name}(ctx context.Context, req *pb.Delete${name}Request) (*emptypb.Empty, error) {
${key.check}\tif err := s.store.Delete(ctx, ${lc}Collection, ${id}); err != nil {
\t\treturn nil, dbError(err)
\t}
\treturn &emptypb.Empty{}, nil
}
`;
  return `package grpcserver

${goImports(code, [["context", "context"], ["json", "encoding/json"], ["fmt", "fmt"], ["sort", "sort"]], [
    ["db", `${module}/internal/db`],
    ["pb", pkgPath],
    ["codes", "google.golang.org/grpc/codes"],
    ["status", "google.golang.org/grpc/status"],
    ["emptypb", "google.golang.org/protobuf/types/known/emptypb"],
  ])}

${code}`;
}

function goGrpcHealth(): string {
  return `package grpcserver

// The standard grpc.health.v1.Health service is registered in cmd/api/main.go.
// This file is a placeholder for liveness/readiness helpers you may want to
// expose separately (e.g. checking DB connectivity before reporting SERVING).
`;
}

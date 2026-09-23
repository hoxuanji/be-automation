import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toSnake } from "../types";
import { GO_IP_LIMITER, goDatadogInit, goImports, goRateLimitTest, goSentryInit, goTracing } from "../go";

/**
 * Emits a Go gRPC server skeleton. Assumes the user runs `make proto` once
 * after cloning to produce the generated stubs under `gen/go/`. We deliberately
 * do NOT commit generated code from Helios — users regenerate from their own
 * proto edits, and committing stale generated Go into every Helios zip would
 * be noise.
 */
export function goGrpcFiles(
  config: StackConfig,
  entities: Entity[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const module = `github.com/your-username/${name}`;
  const pkg = name.replace(/-/g, "_") + "v1";
  const pkgPath = `${module}/gen/go/${name.replace(/-/g, "_")}/v1`;
  const o = goGrpcObservability(config);

  const files: GeneratedFile[] = [];

  files.push({
    path: "cmd/api/main.go",
    content: goGrpcMain(module, pkgPath, config, entities, o),
  });

  files.push({
    path: "internal/grpcserver/server.go",
    content: goGrpcServer(pkg, pkgPath, entities),
  });

  for (const entity of entities) {
    files.push({
      path: `internal/grpcserver/${toSnake(entity.name)}_service.go`,
      content: goGrpcEntityService(pkg, pkgPath, entity),
    });
  }

  files.push({
    path: "internal/grpcserver/health.go",
    content: goGrpcHealth(),
  });

  const interceptors = goGrpcInterceptors(config, o);
  if (interceptors) files.push({ path: "internal/grpcserver/interceptors.go", content: interceptors });
  if (config.rateLimit) files.push({ path: "internal/grpcserver/ratelimit_test.go", content: goRateLimitTest("grpcserver") });
  // Same provider setup as the REST tree; the per-RPC spans come from otelgrpc.
  if (o.tracing) files.push({ path: "internal/tracing/tracing.go", content: goTracing("chi") });
  if (o.monitoring === "sentry") files.push({ path: "internal/monitoring/sentry.go", content: goSentryInit("chi") });
  if (o.monitoring === "datadog") files.push({ path: "internal/monitoring/datadog.go", content: goDatadogInit("chi") });

  return files;
}

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

// Unary interceptors for the cross-cutting flags. Streaming RPCs are not
// intercepted — the generated services are all unary.
function goGrpcInterceptors(config: StackConfig, o: GoGrpcObs): string {
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

// RateLimit rejects RPCs with ResourceExhausted once a client IP exceeds its bucket.
func RateLimit() grpc.UnaryServerInterceptor {
\tl := newIPLimiter()
\treturn func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
\t\tif !l.allow(peerIP(ctx)) {
\t\t\treturn nil, status.Error(codes.ResourceExhausted, "rate_limited")
\t\t}
\t\treturn handler(ctx, req)
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
}`);
  }
  if (parts.length === 0) return "";
  const code = parts.join("\n\n") + "\n";
  return `package grpcserver

${goImports(code, [["context", "context"], ["slog", "log/slog"], ["net", "net"], ["sync", "sync"], ["time", "time"]], [
    ["sentry", "github.com/getsentry/sentry-go"],
    ["prometheus", "github.com/prometheus/client_golang/prometheus"],
    ["promauto", "github.com/prometheus/client_golang/prometheus/promauto"],
    ["rate", "golang.org/x/time/rate"],
    ["grpc", "google.golang.org/grpc"],
    ["codes", "google.golang.org/grpc/codes"],
    ["peer", "google.golang.org/grpc/peer"],
    ["status", "google.golang.org/grpc/status"],
  ])}

${code}`;
}

function goGrpcMain(module: string, pkgPath: string, config: StackConfig, entities: Entity[], o: GoGrpcObs): string {
  const registrations = entities
    .map((e) => `\tpb.Register${e.name}ServiceServer(grpcSrv, grpcserver.New${e.name}Service())`)
    .join("\n");

  // Outermost first — same order as the REST middleware chain in go.ts goServer.
  const unary = [
    o.monitoring === "sentry" ? "grpcserver.SentryRecover()" : "",
    o.monitoring === "datadog" ? "grpctrace.UnaryServerInterceptor(grpctrace.WithServiceName(cfg.AppName))" : "",
    o.monitoring === "prometheus" ? "grpcserver.Metrics()" : "",
    config.rateLimit ? "grpcserver.RateLimit()" : "",
    config.audit ? "grpcserver.Audit(log)" : "",
  ].filter(Boolean);
  const opts = [
    o.tracing ? "\t\tgrpc.StatsHandler(otelgrpc.NewServerHandler()), // one span per RPC" : "",
    unary.length ? `\t\tgrpc.ChainUnaryInterceptor(\n${unary.map((u) => `\t\t\t${u},`).join("\n")}\n\t\t),` : "",
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

function goGrpcServer(pkg: string, pkgPath: string, _entities: Entity[]): string {
  return `package grpcserver

// This package holds one server type per entity service. Each server embeds
// the generated \`Unimplemented<Entity>ServiceServer\` so that future proto
// additions don't break the build — unimplemented RPCs return
// \`codes.Unimplemented\` until you fill them in.
//
// Wire a real database (gorm / sqlx / pgx) in place of the TODO stubs.

import (
\t_ "${pkgPath}"
)
`;
}

function goGrpcEntityService(pkg: string, pkgPath: string, entity: Entity): string {
  const name = entity.name;
  return `package grpcserver

import (
\t"context"

\t"google.golang.org/grpc/codes"
\t"google.golang.org/grpc/status"
\t"google.golang.org/protobuf/types/known/emptypb"

\tpb "${pkgPath}"
)

// ${name}Service implements pb.${name}ServiceServer.
//
// The stubs below return \`Unimplemented\` — replace each with real data-layer
// calls (gorm repository, sqlx queries, etc). Signatures are fixed by the
// generated proto; do not rename them.
type ${name}Service struct {
\tpb.Unimplemented${name}ServiceServer
}

func New${name}Service() *${name}Service {
\treturn &${name}Service{}
}

func (s *${name}Service) List${name}(ctx context.Context, req *pb.List${name}Request) (*pb.List${name}Response, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "List${name} not implemented")
}

func (s *${name}Service) Get${name}(ctx context.Context, req *pb.Get${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Get${name} not implemented")
}

func (s *${name}Service) Create${name}(ctx context.Context, req *pb.Create${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Create${name} not implemented")
}

func (s *${name}Service) Update${name}(ctx context.Context, req *pb.Update${name}Request) (*pb.${name}, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Update${name} not implemented")
}

func (s *${name}Service) Delete${name}(ctx context.Context, req *pb.Delete${name}Request) (*emptypb.Empty, error) {
\treturn nil, status.Errorf(codes.Unimplemented, "Delete${name} not implemented")
}
`;
}

function goGrpcHealth(): string {
  return `package grpcserver

// The standard grpc.health.v1.Health service is registered in cmd/api/main.go.
// This file is a placeholder for liveness/readiness helpers you may want to
// expose separately (e.g. checking DB connectivity before reporting SERVING).
`;
}

import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toSnake } from "../types";

/**
 * Emits a Python gRPC server using grpcio + grpcio-health-checking.
 *
 * Proto stubs are generated at container-build time by `python -m grpc_tools.protoc`,
 * driven by the Makefile target the buf generator emits. Users don't have to
 * install `buf` specifically — the Makefile falls back to grpc_tools which is
 * pulled in as a dev dependency.
 */
export function pyGrpcFiles(
  config: StackConfig,
  entities: Entity[],
  // app/tracing.py from the REST generator ("" when tracing is off).
  tracingModule = ""
): GeneratedFile[] {
  const name = safeName(config.name);
  // Stubs land in gen/python/<proto package>/v1 (see the Dockerfile protoc
  // step); gen/python is on PYTHONPATH, so they import as <proto package>.v1.
  const protoPkg = name.replace(/-/g, "_");
  const o = pyGrpcObservability(config);

  const files: GeneratedFile[] = [];
  files.push({ path: "pyproject.toml", content: pyGrpcPyproject(name, entities.length > 0, o) });
  files.push({ path: "Dockerfile", content: pyGrpcDockerfile() });
  files.push({ path: "app/__init__.py", content: "" });
  files.push({ path: "app/main.py", content: pyGrpcMain(protoPkg, entities, o) });
  if (o.interceptors.length > 0) {
    files.push({ path: "app/interceptors.py", content: pyGrpcInterceptors(o) });
  }
  if (tracingModule) files.push({ path: "app/tracing.py", content: tracingModule });

  for (const entity of entities) {
    files.push({
      path: `app/services/${toSnake(entity.name)}.py`,
      content: pyGrpcEntityService(protoPkg, entity),
    });
  }
  if (entities.length > 0) {
    files.push({ path: "app/services/__init__.py", content: "" });
  }

  return files;
}

type PyGrpcObs = {
  tracing: boolean;
  prom: boolean;
  sentry: boolean;
  datadog: boolean;
  // app/interceptors.py classes, in the same order as the REST middleware.
  interceptors: string[];
};

function pyGrpcObservability(config: StackConfig): PyGrpcObs {
  const prom = /prometheus|grafana/.test(config.monitoring);
  return {
    tracing: config.tracing,
    prom,
    sentry: /sentry/.test(config.monitoring),
    datadog: /datadog/.test(config.monitoring),
    interceptors: [
      prom ? "MetricsInterceptor" : "",
      config.rateLimit ? "RateLimitInterceptor" : "",
      config.audit ? "AuditInterceptor" : "",
    ].filter(Boolean),
  };
}

function pyGrpcPyproject(name: string, hasEntities: boolean, o: PyGrpcObs): string {
  const extras = hasEntities
    ? `sqlalchemy = "^2.0.36"\nasyncpg = "^0.30.0"\n`
    : "";
  const obs = [
    o.prom ? `prometheus-client = "^0.21.0"` : "",
    o.sentry ? `sentry-sdk = "^2.19.0"` : "",
    o.datadog ? `ddtrace = "^2.14.0"` : "",
    ...(o.tracing
      ? [`opentelemetry-sdk = "~1.29.0"`, `opentelemetry-exporter-otlp-proto-http = "~1.29.0"`, `opentelemetry-instrumentation-grpc = "~0.50b0"`]
      : []),
  ].filter(Boolean).map((l) => `${l}\n`).join("");
  return `[tool.poetry]
name = "${name}"
version = "0.1.0"
description = ""
authors = ["helios"]

[tool.poetry.dependencies]
python = "^3.12"
grpcio = "^1.68.0"
grpcio-health-checking = "^1.68.0"
grpcio-reflection = "^1.68.0"
protobuf = "^5.28.3"
${extras}pydantic-settings = "^2.6.1"
${obs}
[tool.poetry.group.dev.dependencies]
grpcio-tools = "^1.68.0"
pytest = "^8.3.3"

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
`;
}

function pyGrpcDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM python:3.12-slim AS build
WORKDIR /build
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Install Poetry and dependencies.
COPY pyproject.toml ./
RUN pip install --no-cache-dir poetry==1.8.3 \\
 && poetry config virtualenvs.create false \\
 && (poetry install --no-root || pip install grpcio grpcio-tools grpcio-health-checking grpcio-reflection protobuf pydantic-settings)

# Compile .proto → Python stubs into gen/python/.
COPY proto ./proto
RUN mkdir -p gen/python \\
 && python -m grpc_tools.protoc \\
     -I proto \\
     --python_out=gen/python \\
     --pyi_out=gen/python \\
     --grpc_python_out=gen/python \\
     proto/*/v1/*.proto

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app:/app/gen/python

# Non-root user (UID 1001 matches other language Dockerfiles in Helios).
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app

# Install runtime deps only (no grpcio-tools).
COPY --from=build /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=build /build/gen /app/gen
COPY --chown=app:app app /app/app

USER app
EXPOSE 8080
CMD ["python", "-m", "app.main"]
`;
}


function pyGrpcMain(protoPkg: string, entities: Entity[], o: PyGrpcObs): string {
  const imports: string[] = [];
  const registrations: string[] = [];
  for (const entity of entities) {
    const snake = toSnake(entity.name);
    imports.push(`from app.services.${snake} import ${entity.name}Service`);
    registrations.push(
      `    service_pb2_grpc.add_${entity.name}ServiceServicer_to_server(${entity.name}Service(), server)`
    );
  }
  const interceptors = [o.tracing ? "server_interceptor()" : "", ...o.interceptors.map((c) => `${c}()`)].filter(Boolean);
  const importBlock = [
    // ddtrace.auto must be the very first import: it patches grpc as it loads.
    ...(o.datadog ? [`import ddtrace.auto  # noqa: F401 — must stay the first import`] : []),
    `import asyncio`,
    `import logging`,
    `import os`,
    `import signal`,
    `from concurrent import futures`,
    ``,
    `import grpc`,
    `from grpc_health.v1 import health, health_pb2, health_pb2_grpc`,
    `from grpc_reflection.v1alpha import reflection`,
    ...(o.tracing ? [`from opentelemetry.instrumentation.grpc import server_interceptor`] : []),
    ...(o.prom ? [`from prometheus_client import start_http_server`] : []),
    ...(o.sentry ? [`import sentry_sdk`, `from sentry_sdk.integrations.grpc import GRPCIntegration`] : []),
    ``,
    entities.length > 0 ? `from ${protoPkg}.v1 import service_pb2_grpc` : `# no entity services defined`,
    ...(o.interceptors.length ? [`from app.interceptors import ${o.interceptors.join(", ")}`] : []),
    ...(o.tracing ? [`from app.tracing import configure_tracing`] : []),
    ...imports,
  ].join("\n");

  return `${importBlock}

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)
${o.sentry ? `
# Initialised before grpc.server() so the integration can wrap it.
sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0, integrations=[GRPCIntegration()])
` : ""}

def serve() -> None:
${o.tracing ? "    configure_tracing()\n" : ""}    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),${interceptors.length ? `\n        interceptors=[${interceptors.join(", ")}],` : ""}
    )

${registrations.length > 0 ? registrations.join("\n") : "    # No entity services defined — add them once entities exist in the builder."}

    # Standard grpc.health.v1.Health service. grpc-health-probe (used in K8s
    # probes) calls Check with an empty service name; we mark that SERVING.
    health_servicer = health.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)

    # Reflection enables \`grpcurl\` / BloomRPC introspection without a local proto.
    service_names = (
        reflection.SERVICE_NAME,
        health.SERVICE_NAME,
    )
    reflection.enable_server_reflection(service_names, server)
${o.prom ? `
    # Prometheus scrapes this plain-HTTP listener; the gRPC port only speaks HTTP/2.
    start_http_server(int(os.environ.get("METRICS_PORT", "9464")))
` : ""}
    port = int(os.environ.get("PORT", "8080"))
    server.add_insecure_port(f"0.0.0.0:{port}")
    server.start()
    log.info("gRPC server listening on :%d", port)

    # Graceful shutdown.
    shutdown_event = asyncio.Event()

    def _on_signal(*_: object) -> None:
        log.info("shutdown signal received; draining")
        health_servicer.set("", health_pb2.HealthCheckResponse.NOT_SERVING)
        server.stop(grace=10).wait()
        shutdown_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _on_signal)

    server.wait_for_termination()


if __name__ == "__main__":
    serve()
`;
}

// Interceptors for the cross-cutting flags. They wrap all four handler kinds:
// the generated RPCs are unary, but user-added streaming methods must not
// bypass rate limiting / audit / metrics.
function pyGrpcInterceptors(o: PyGrpcObs): string {
  const has = (c: string) => o.interceptors.includes(c);
  const blocks: string[] = [];
  if (has("MetricsInterceptor")) {
    blocks.push(`_RPCS = Counter("grpc_server_handled_total", "RPCs completed on the server, by method and status code.", ["grpc_method", "grpc_code"])
_SECONDS = Histogram("grpc_server_handling_seconds", "RPC latency on the server, by method.", ["grpc_method"])


class MetricsInterceptor(grpc.ServerInterceptor):
    """Per-RPC count + latency; app.main serves them on METRICS_PORT."""

    def intercept_service(self, continuation, handler_call_details):
        method = handler_call_details.method

        @contextmanager
        def around(context):
            start = time.perf_counter()
            failed = False
            try:
                yield
            except Exception:
                failed = True
                raise
            finally:
                _SECONDS.labels(method).observe(time.perf_counter() - start)
                _RPCS.labels(method, _status(context, failed)).inc()

        return _wrap(continuation(handler_call_details), around)`);
  }
  if (has("RateLimitInterceptor")) {
    blocks.push(`class RateLimitInterceptor(grpc.ServerInterceptor):
    """Rejects RPCs with RESOURCE_EXHAUSTED past 60 / minute / client.

    ponytail: in-memory fixed window, per process. Move the counters to Redis
    if the limit must hold across replicas.
    """

    def __init__(self, limit: int = 60, window: float = 60.0):
        self._limit = limit
        self._window = window
        self._hits: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def _allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            count, reset_at = self._hits.get(key, (0, now + self._window))
            if reset_at < now:
                count, reset_at = 0, now + self._window
            if count >= self._limit:
                return False
            self._hits[key] = (count + 1, reset_at)
            return True

    def intercept_service(self, continuation, handler_call_details):
        # ponytail: one hit per RPC (a stream counts once), not per message.
        @contextmanager
        def around(context):
            if not self._allow(_peer(context)):
                context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "rate_limited")
            yield

        return _wrap(continuation(handler_call_details), around)`);
  }
  if (has("AuditInterceptor")) {
    blocks.push(`class AuditInterceptor(grpc.ServerInterceptor):
    """One structured log line per RPC."""

    _log = logging.getLogger("audit")

    def intercept_service(self, continuation, handler_call_details):
        method = handler_call_details.method

        @contextmanager
        def around(context):
            failed = False
            try:
                yield
            except Exception:
                failed = True
                raise
            finally:
                self._log.info("audit", extra={
                    "event": "audit",
                    "method": method,
                    "code": _status(context, failed),
                    "peer": _peer(context),
                })

        return _wrap(continuation(handler_call_details), around)`);
  }
  const std = [
    has("AuditInterceptor") ? "import logging" : "",
    has("RateLimitInterceptor") ? "import threading" : "",
    has("MetricsInterceptor") || has("RateLimitInterceptor") ? "import time" : "",
    "from contextlib import contextmanager",
  ].filter(Boolean);
  const third = ["import grpc", has("MetricsInterceptor") ? "from prometheus_client import Counter, Histogram" : ""].filter(Boolean);
  const imports = [...std, ...(std.length ? [""] : []), ...third].join("\n");
  return `"""gRPC server interceptors: ${o.interceptors.join(", ")}."""
${imports}


def _wrap(handler, around):
    """Run the handler inside the around(context) context manager, whatever its kind.

    Response-streaming handlers are wrapped as generators so around() spans the
    whole stream (final status, full latency), not just the call that creates it.
    """
    if handler is None:
        return None

    def unary(inner):
        def call(request, context):
            with around(context):
                return inner(request, context)
        return call

    def streaming(inner):
        def call(request, context):
            with around(context):
                yield from inner(request, context)
        return call

    return handler._replace(
        unary_unary=handler.unary_unary and unary(handler.unary_unary),
        stream_unary=handler.stream_unary and unary(handler.stream_unary),
        unary_stream=handler.unary_stream and streaming(handler.unary_stream),
        stream_stream=handler.stream_stream and streaming(handler.stream_stream),
    )


def _peer(context) -> str:
    """Client address without the port ("ipv4:10.0.0.1:5123" -> "ipv4:10.0.0.1")."""
    return context.peer().rsplit(":", 1)[0]


def _status(context, failed: bool) -> str:
    code = context.code()
    if code is not None:
        return code.name
    return "UNKNOWN" if failed else "OK"


${blocks.join("\n\n\n")}
`;
}

function pyGrpcEntityService(pkg: string, entity: Entity): string {
  const name = entity.name;
  return `# Handlers for ${name}Service. Each method is a stub that returns
# UNIMPLEMENTED — fill in real persistence (SQLAlchemy, asyncpg, motor, …) below.
#
# Method signatures are fixed by the generated stubs; do not rename them.

import grpc
from ${pkg}.v1 import service_pb2, service_pb2_grpc


class ${name}Service(service_pb2_grpc.${name}ServiceServicer):
    def List${name}(self, request, context):
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("List${name} not implemented")
        return service_pb2.List${name}Response()

    def Get${name}(self, request, context):
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Get${name} not implemented")
        return service_pb2.${name}()

    def Create${name}(self, request, context):
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Create${name} not implemented")
        return service_pb2.${name}()

    def Update${name}(self, request, context):
        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Update${name} not implemented")
        return service_pb2.${name}()

    def Delete${name}(self, request, context):
        from google.protobuf import empty_pb2

        context.set_code(grpc.StatusCode.UNIMPLEMENTED)
        context.set_details("Delete${name} not implemented")
        return empty_pb2.Empty()
`;
}

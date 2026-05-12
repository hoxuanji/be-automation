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
  entities: Entity[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const pkg = name.replace(/-/g, "_") + "_v1";

  const files: GeneratedFile[] = [];
  files.push({ path: "pyproject.toml", content: pyGrpcPyproject(name, entities.length > 0) });
  files.push({ path: "Dockerfile", content: pyGrpcDockerfile() });
  files.push({ path: "app/__init__.py", content: "" });
  files.push({ path: "app/main.py", content: pyGrpcMain(pkg, entities) });

  for (const entity of entities) {
    files.push({
      path: `app/services/${toSnake(entity.name)}.py`,
      content: pyGrpcEntityService(pkg, entity),
    });
  }
  if (entities.length > 0) {
    files.push({ path: "app/services/__init__.py", content: "" });
  }

  return files;
}

function pyGrpcPyproject(name: string, hasEntities: boolean): string {
  const extras = hasEntities
    ? `"sqlalchemy>=2.0.36",\n    "asyncpg>=0.30.0",\n    `
    : "";
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

function pyGrpcMain(pkg: string, entities: Entity[]): string {
  const modulePath = `${pkg}.v1.service_pb2_grpc`;
  const imports: string[] = [];
  const registrations: string[] = [];
  for (const entity of entities) {
    const snake = toSnake(entity.name);
    imports.push(`from app.services.${snake} import ${entity.name}Service`);
    registrations.push(
      `    ${modulePath}.add_${entity.name}ServiceServicer_to_server(${entity.name}Service(), server)`
    );
  }
  const importBlock = [
    `import asyncio`,
    `import logging`,
    `import os`,
    `import signal`,
    `from concurrent import futures`,
    ``,
    `import grpc`,
    `from grpc_health.v1 import health, health_pb2, health_pb2_grpc`,
    `from grpc_reflection.v1alpha import reflection`,
    ``,
    entities.length > 0 ? `from gen.python.${pkg}.v1 import service_pb2_grpc as ${pkg}_grpc  # noqa: E402` : `# no entity services defined`,
    ...imports,
  ].join("\n");

  return `${importBlock}

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


def serve() -> None:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))

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

function pyGrpcEntityService(pkg: string, entity: Entity): string {
  const name = entity.name;
  return `# Handlers for ${name}Service. Each method is a stub that returns
# UNIMPLEMENTED — fill in real persistence (SQLAlchemy, asyncpg, motor, …) below.
#
# Method signatures are fixed by the generated stubs; do not rename them.

import grpc
from gen.python.${pkg}.v1 import service_pb2, service_pb2_grpc


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

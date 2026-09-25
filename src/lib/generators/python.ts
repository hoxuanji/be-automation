import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab } from "./types";
import { pyGrpcFiles } from "./grpc/python";
import { pythonGraphqlFiles } from "./graphql/python";
import { isGraphqlSupported } from "./types";
import { pyPatternRoute, pyPatternImports, pyNativeRoutes, pyNativeImports, pyHasRedis, pyAuthMode, type PyAuthMode, type NativeRoute } from "./patterns/python";

export function pythonFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  // gRPC mode replaces the FastAPI / Django / Litestar bootstrap entirely.
  if (config.api === "grpc") {
    return pyGrpcFiles(config, entities, config.tracing ? pyTracingModule(config.name) : "");
  }

  // GraphQL: Strawberry mounted on the REST FastAPI app (built with no routes),
  // so its middleware — slowapi, audit, OTel, Prometheus/Sentry — applies.
  if (config.api === "graphql" && isGraphqlSupported(config.language)) {
    const rest = (ents: Entity[]) => pythonFiles({ ...config, api: "rest", framework: "fastapi" }, [], ents);
    return pythonGraphqlFiles(entities, rest([]), rest(entities));
  }

  const files: GeneratedFile[] = [];
  const authMode = pyAuthMode(config, endpoints);
  const withAuth = authMode !== "off";
  const hasEntities = entities.length > 0;
  const isMongo = /mongo/.test(config.database);

  files.push({ path: "pyproject.toml", content: pyproject(config, hasEntities, authMode, endpoints) });
  files.push({ path: "Dockerfile", content: pyDockerfile() });
  files.push({ path: "app/__init__.py", content: "" });
  files.push({
    path: "app/config.py",
    content: `from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "app"
    log_level: str = "info"
    database_url: str | None = None
    redis_url: str | None = None
    jwt_secret: str | None = None

    class Config:
        env_file = ".env"

settings = Settings()
`,
  });

  if (hasEntities && !isMongo && config.framework === "fastapi") {
    files.push({ path: "app/db.py", content: dbFile(config) });
    files.push({ path: "app/models.py", content: sqlalchemyModels(config, entities) });
    files.push({ path: "app/routers/__init__.py", content: "" });
    for (const entity of entities) {
      const snake = toSnake(entity.name);
      const pascal = toPascal(entity.name);
      const kebab = toKebab(entity.name);
      const nonPkFields = entity.fields.filter((f) => !f.primaryKey);
      files.push({
        path: `app/routers/${snake}.py`,
        content: entityRouterFile(pascal, snake, kebab, nonPkFields),
      });
    }
    files.push({ path: "tests/__init__.py", content: "" });
    files.push({ path: "tests/conftest.py", content: confpyFile() });
    for (const entity of entities) {
      const snake = toSnake(entity.name);
      const kebab = toKebab(entity.name);
      const nonPkFields = entity.fields.filter((f) => !f.primaryKey);
      files.push({
        path: `tests/test_${snake}.py`,
        content: entityTestFile(snake, kebab, nonPkFields),
      });
    }
  } else if (hasEntities) {
    // Litestar / Django pattern handlers use the same SQLAlchemy session helper.
    if (!isMongo) files.push({ path: "app/db.py", content: dbFile(config) });
    files.push({ path: "app/models.py", content: sqlalchemyModels(config, entities) });
  }

  files.push({
    path: "app/main.py",
    content: appMain(config, endpoints, hasEntities && !isMongo ? entities : [], authMode),
  });

  if (withAuth) {
    files.push({ path: "app/auth.py", content: authMode === "hs256" ? pyAuthHS256Module(config.framework) : pyAuthModule(config.framework) });
  }

  if (pyHasRedis(config)) {
    files.push({
      path: "app/cache.py",
      content: `"""Shared async Redis client (Redis, Dragonfly or Upstash via rediss://)."""
import os

import redis.asyncio as redis

redis_client = redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379"), decode_responses=True)
`,
    });
  }
  if (config.tracing && config.framework !== "django") {
    files.push({ path: "app/tracing.py", content: pyTracingModule(config.name) });
  }
  if (config.audit) {
    files.push({ path: "app/audit.py", content: config.framework === "django" ? djangoAuditModule() : asgiAuditModule() });
  }

  files.push({
    path: "app/logging_config.py",
    content: `"""Structured JSON logging for the FastAPI app.

stdlib-only — emits one JSON object per line on stdout, which Loki /
CloudWatch / Datadog / GCP Logging all parse natively. Uvicorn's access
log is redirected through this same handler so every line is JSON.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # Merge structured \`extra={...}\` fields without stomping core keys.
        for key, value in record.__dict__.items():
            if key in ("args", "asctime", "created", "exc_info", "exc_text", "filename",
                      "funcName", "levelname", "levelno", "lineno", "message", "module",
                      "msecs", "msg", "name", "pathname", "process", "processName",
                      "relativeCreated", "stack_info", "thread", "threadName", "taskName"):
                continue
            if key not in payload:
                payload[key] = value
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # Uvicorn installs its own handlers on these loggers; replace them so
    # access logs are JSON too.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv = logging.getLogger(name)
        uv.handlers = [handler]
        uv.propagate = False
`,
  });

  return files;
}

function dbFile(config: StackConfig): string {
  const isSqlite = /sqlite/.test(config.database);
  return `"""Database connection helper.

Opens a SQLAlchemy engine with production-minded defaults:
  - pool_pre_ping to detect stale connections after a DB restart.
  - Modest pool_size / max_overflow that match a single-container deployment.
    Tune when running behind a PgBouncer or a read replica.
  - Startup retry loop — Kubernetes pods often boot before the DB is ready.
"""
from __future__ import annotations

import logging
import time

from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from .config import settings

log = logging.getLogger(__name__)

_url = settings.database_url or "sqlite:///./app.db"
# Map the URLs used in .env to SQLAlchemy dialect+driver URLs: SQLAlchemy 2
# rejects "postgres://", MySQL needs an explicit driver, and "file:" is the
# Prisma-style SQLite form.
for _prefix, _replacement in (("postgres://", "postgresql+psycopg2://"),
                              ("mysql://", "mysql+pymysql://"),
                              ("file:", "sqlite:///")):
    if _url.startswith(_prefix):
        _url = _replacement + _url[len(_prefix):]
        break
_is_sqlite = "sqlite" in _url

_engine_kwargs = {
    "pool_pre_ping": True,
    ${isSqlite ? '"connect_args": {"check_same_thread": False},' : '"pool_size": 10,\n    "max_overflow": 20,\n    "pool_recycle": 1800,'}
}

engine = create_engine(_url, **_engine_kwargs)


def _wait_for_db(max_attempts: int = 6, base_delay: float = 0.5) -> None:
    """Retry initial connection with exponential backoff — up to ~30s total."""
    if _is_sqlite:
        return  # SQLite opens lazily; no server to wait for.
    delay = base_delay
    for attempt in range(1, max_attempts + 1):
        try:
            with engine.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            return
        except OperationalError as exc:
            if attempt == max_attempts:
                raise
            log.warning("db: connection attempt %d/%d failed (%s); retrying in %.1fs",
                        attempt, max_attempts, exc.__class__.__name__, delay)
            time.sleep(delay)
            delay = min(delay * 2, 5.0)


_wait_for_db()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
`;
}

function entityRouterFile(
  pascal: string,
  snake: string,
  kebab: string,
  nonPkFields: EntityField[]
): string {
  const inputFields = nonPkFields
    .map((f) => {
      const t = pyType(f.type);
      return f.required ? `    ${f.name}: ${t}` : `    ${f.name}: ${t} | None = None`;
    })
    .join("\n");

  const assignFields = nonPkFields.map((f) => `        ${f.name}=body.${f.name},`).join("\n");

  return `from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from ..db import get_db
from ..models import ${pascal}

router = APIRouter(prefix="/${kebab}s", tags=["${kebab}s"])


class ${pascal}Input(BaseModel):
${inputFields || "    pass"}


@router.get("/")
def list_${snake}s(db: Session = Depends(get_db)):
    return db.query(${pascal}).all()


@router.get("/{id}")
def get_${snake}(id: str, db: Session = Depends(get_db)):
    item = db.query(${pascal}).filter(${pascal}.id == id).first()
    if not item:
        raise HTTPException(status_code=404, detail="${pascal} not found")
    return item


@router.post("/", status_code=201)
def create_${snake}(body: ${pascal}Input, db: Session = Depends(get_db)):
    item = ${pascal}(
${assignFields}
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.put("/{id}")
def update_${snake}(id: str, body: ${pascal}Input, db: Session = Depends(get_db)):
    item = db.query(${pascal}).filter(${pascal}.id == id).first()
    if not item:
        raise HTTPException(status_code=404, detail="${pascal} not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{id}", status_code=204)
def delete_${snake}(id: str, db: Session = Depends(get_db)):
    item = db.query(${pascal}).filter(${pascal}.id == id).first()
    if not item:
        raise HTTPException(status_code=404, detail="${pascal} not found")
    db.delete(item)
    db.commit()
`;
}

function sqlalchemyModels(config: StackConfig, entities: Entity[]): string {
  const isMongo = /mongo/.test(config.database);

  if (isMongo) {
    const docs = entities
      .map((e) => {
        const fields = e.fields
          .filter((f) => !f.primaryKey)
          .map((f) => `    ${f.name}: ${pyType(f.type)}${f.required ? "" : " | None"} = None`);
        return `class ${e.name}(BaseModel):\n    id: str = Field(default_factory=lambda: str(uuid.uuid4()))\n${fields.join("\n")}`;
      })
      .join("\n\n");

    return `# Auto-generated by Helios — edit freely
from pydantic import BaseModel, Field
import uuid

${docs}
`;
  }

  const isPostgres = /postgres|neon|supabase|cockroach/.test(config.database);

  const models = entities
    .map((e) => {
      const tableName = toSnake(e.name) + "s";
      const cols = e.fields.map((f) => {
        const colType = saColType(f.type, isPostgres);
        const pk = f.primaryKey ? ", primary_key=True" : "";
        const uniq = f.unique && !f.primaryKey ? ", unique=True" : "";
        const nullable = !f.required && !f.primaryKey ? ", nullable=True" : "";
        // String(36) PKs (non-Postgres) need a str; the DB drivers can't bind uuid.UUID.
        const default_ = f.primaryKey && f.type === "uuid" ? (isPostgres ? ", default=uuid.uuid4" : ", default=lambda: str(uuid.uuid4())") : "";
        return `    ${f.name} = Column(${colType}${pk}${default_}${uniq}${nullable})`;
      });
      if (!e.fields.some((f) => f.name === "createdAt"))
        cols.push("    created_at = Column(DateTime, default=datetime.utcnow)");
      if (!e.fields.some((f) => f.name === "updatedAt"))
        cols.push("    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)");

      return `class ${e.name}(Base):\n    __tablename__ = "${tableName}"\n${cols.join("\n")}`;
    })
    .join("\n\n");

  return `# Auto-generated by Helios — edit freely
from sqlalchemy import Column, String, Integer, Boolean, DateTime, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import DeclarativeBase
from datetime import datetime
import uuid


class Base(DeclarativeBase):
    pass


${models}
`;
}

function pyType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "str";
    case "string":  return "str";
    case "text":    return "str";
    case "number":  return "int";
    case "boolean": return "bool";
    case "date":    return "str";
    case "json":    return "dict";
  }
}

function saColType(t: FieldType, isPostgres: boolean): string {
  switch (t) {
    case "uuid":    return isPostgres ? "UUID(as_uuid=True)" : "String(36)";
    case "string":  return "String(255)";
    case "text":    return "Text";
    case "number":  return "Integer";
    case "boolean": return "Boolean";
    case "date":    return "DateTime";
    case "json":    return isPostgres ? "JSONB" : "Text";
  }
}

function pyproject(config: StackConfig, withModels: boolean, authMode: PyAuthMode, endpoints: Endpoint[]) {
  const isPostgres = /postgres|neon|supabase|cockroach/.test(config.database);
  const isMysql = /mysql|planetscale/.test(config.database);
  // db.py uses a sync SQLAlchemy engine, so the drivers are the sync ones:
  // psycopg2 for Postgres, PyMySQL for MySQL, stdlib sqlite3 otherwise.
  const sqlDeps = withModels && !(/mongo/.test(config.database))
    ? `\nsqlalchemy = "^2.0.0"\nalembic = "^1.13.0"\n${isPostgres ? `psycopg2-binary = "^2.9.0"\n` : isMysql ? `pymysql = "^1.1.1"\n` : ""}`
    : "";
  const authDeps = (authMode !== "off" ? `\npyjwt = { version = "^2.9.0", extras = ["crypto"] }` : "")
    + (authMode === "hs256" ? `\nbcrypt = "^4.2.0"` : "");
  const fw = config.framework;
  const extra: string[] = [];
  if (/prometheus|grafana/.test(config.monitoring)) {
    extra.push(fw === "fastapi" ? `prometheus-fastapi-instrumentator = "^7.0.0"` : fw === "litestar" ? `prometheus-client = "^0.21.0"` : `django-prometheus = "^2.3.1"`);
  } else if (/sentry/.test(config.monitoring)) {
    extra.push(fw === "fastapi" ? `sentry-sdk = { version = "^2.19.0", extras = ["fastapi"] }` : `sentry-sdk = "^2.19.0"`);
  } else if (/datadog/.test(config.monitoring)) {
    extra.push(`ddtrace = "^2.14.0"`);
  }
  if (config.rateLimit && fw === "fastapi") extra.push(`slowapi = "^0.1.9"`);
  if (config.tracing && fw !== "django") {
    extra.push(
      `opentelemetry-sdk = "~1.29.0"`,
      `opentelemetry-exporter-otlp-proto-http = "~1.29.0"`,
      fw === "fastapi" ? `opentelemetry-instrumentation-fastapi = "~0.50b0"` : `opentelemetry-instrumentation-asgi = "~0.50b0"`,
    );
  }
  if (pyHasRedis(config)) extra.push(`redis = "^5.2.0"`);
  // FastAPI refuses to register UploadFile routes without python-multipart.
  if (fw === "fastapi" && endpoints.some((e) => e.pattern === "file_upload")) extra.push(`python-multipart = "^0.0.20"`);
  const monDeps = extra.map((l) => `\n${l}`).join("");
  const deps =
    config.framework === "fastapi"
      ? `fastapi = "^0.115.0"\nuvicorn = { extras = ["standard"], version = "^0.30.0" }\npydantic = "^2.9.0"\npydantic-settings = "^2.5.0"${sqlDeps}${authDeps}${monDeps}`
      : config.framework === "litestar"
      ? `litestar = { extras = ["standard"], version = "^2.12.0" }\npydantic-settings = "^2.5.0"${sqlDeps}${authDeps}${monDeps}`
      : `django = "^5.1.0"\nuvicorn = { extras = ["standard"], version = "^0.30.0" }\npydantic-settings = "^2.5.0"${sqlDeps}${authDeps}${monDeps}`;
  return `[tool.poetry]
name = "${config.name}"
version = "0.1.0"
description = ""
authors = []

[tool.poetry.dependencies]
python = "^3.12"
${deps}

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"
httpx = "^0.27.0"
pytest-asyncio = "^0.23.0"

[build-system]
requires = ["poetry-core>=1.0.0"]
build-backend = "poetry.core.masonry.api"
`;
}

function pyAuthModule(fw: string): string {
  return `"""JWT verification for incoming requests.

Uses PyJWT's built-in PyJWKClient which fetches and caches keys from the
configured JWKS endpoint. Works with any OIDC / OAuth2 provider that
publishes a JWKS URL — Clerk, Auth0, Cognito, Firebase, Keycloak, and
Supabase Auth (asymmetric mode) are all supported out of the box.
"""
from __future__ import annotations

import os
from functools import lru_cache

import jwt
${pyAuthImports(fw)}from jwt import PyJWKClient


@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    url = os.environ.get("AUTH_JWKS_URL")
    if not url:
        raise RuntimeError("AUTH_JWKS_URL is not set")
    # PyJWKClient caches keys in-process and refreshes on unknown kids.
    return PyJWKClient(url, cache_keys=True, lifespan=3600)


def _verify(token: str) -> dict:
    issuer = os.environ.get("AUTH_ISSUER")
    audience = os.environ.get("AUTH_AUDIENCE")  # optional
    if not issuer:
        raise RuntimeError("AUTH_ISSUER is not set")

    signing_key = _jwks_client().get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256", "ES256"],
        issuer=issuer,
        audience=audience if audience else None,
        options={"verify_aud": bool(audience)},
        leeway=30,
    )


${pyAuthRequired(fw)}`;
}

function pyAuthImports(fw: string): string {
  if (fw === "litestar") return "from litestar import Request\nfrom litestar.exceptions import InternalServerException, NotAuthorizedException\n";
  return fw === "django" ? "" : "from fastapi import Header, HTTPException, status\n";
}

// auth_required body shared by the JWKS and HS256 modules; both expose _verify().
function pyAuthRequired(fw: string): string {
  if (fw === "litestar") {
    return `async def auth_required(request: Request) -> dict:
    """Litestar dependency (app-level Provide) returning the verified Bearer JWT claims."""
    authorization = request.headers.get("authorization")
    if not authorization or not authorization.startswith("Bearer "):
        raise NotAuthorizedException(detail="missing_or_malformed_token")
    token = authorization[len("Bearer "):].strip()
    try:
        return _verify(token)
    except jwt.InvalidTokenError:
        raise NotAuthorizedException(detail="invalid_token")
    except RuntimeError as exc:
        raise InternalServerException(detail=str(exc))


async def auth_guard(connection, _handler) -> None:
    """Route guard for endpoints marked auth: same check, claims discarded."""
    await auth_required(connection)
`;
  }
  if (fw === "django") {
    return `def auth_required(request) -> dict:
    """Verified claims of the request's Bearer JWT. Raises PermissionError(detail),
    which main._endpoint answers with 401."""
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        raise PermissionError("missing_or_malformed_token")
    try:
        return _verify(authorization[len("Bearer "):].strip())
    except jwt.InvalidTokenError:
        raise PermissionError("invalid_token")
`;
  }
  return `async def auth_required(authorization: str | None = Header(default=None)) -> dict:
    """FastAPI dependency that enforces a valid Bearer JWT.

    Usage::

        @app.get("/me")
        async def me(claims: dict = Depends(auth_required)):
            return {"sub": claims["sub"]}
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="missing_or_malformed_token")
    token = authorization[len("Bearer "):].strip()
    try:
        return _verify(token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="invalid_token")
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail=str(exc))
`;
}

function pyAuthHS256Module(fw: string): string {
  return `"""HS256 JWTs this service issues itself (auth "none" = self-managed).

The login/register/refresh handlers sign with JWT_SECRET and auth_required
verifies exactly those tokens — no external identity provider involved.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import jwt
${pyAuthImports(fw)}

def _secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET is not set")
    return secret


def create_access_token(sub: str, ttl: timedelta = timedelta(hours=24)) -> str:
    now = datetime.now(tz=timezone.utc)
    return jwt.encode({"sub": sub, "iat": now, "exp": now + ttl}, _secret(), algorithm="HS256")


def verify_token(token: str) -> dict:
    """Signature (HS256 only) + expiry check; raises jwt.InvalidTokenError."""
    return jwt.decode(token, _secret(), algorithms=["HS256"], options={"require": ["exp", "sub"]})


_verify = verify_token


${pyAuthRequired(fw)}`;
}

function pyDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Create a non-root user to run the app. Pinned UID/GID keeps volume
# permissions deterministic across hosts.
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app \\
 && mkdir -p /home/app && chown -R app:app /home/app

COPY pyproject.toml ./
RUN pip install --no-cache-dir poetry==1.8.3 \\
 && poetry config virtualenvs.create false \\
 && poetry install --without dev --no-root
COPY --chown=app:app . .

USER app
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

export function pyTracingModule(name: string): string {
  return `"""OpenTelemetry tracing — spans are exported over OTLP/HTTP.

The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318).
"""
import os

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure_tracing() -> None:
    provider = TracerProvider(
        resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", ${JSON.stringify(name)})})
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
`;
}

function asgiAuditModule(): string {
  return `"""Audit log — one structured log line per HTTP request.

Plain ASGI middleware, so it works with FastAPI (app.add_middleware) and
Litestar (middleware=[...]) alike.
"""
import logging

log = logging.getLogger("audit")


class AuditMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        status = {"code": 500}

        async def _send(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            client = scope.get("client")
            log.info("audit", extra={
                "event": "audit",
                "method": scope["method"],
                "path": scope["path"],
                "status": status["code"],
                "ip": client[0] if client else None,
            })
`;
}

function djangoAuditModule(): string {
  return `"""Audit log — one structured log line per HTTP request."""
import logging

log = logging.getLogger("audit")


class AuditMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        user = getattr(request, "user", None)
        log.info("audit", extra={
            "event": "audit",
            "method": request.method,
            "path": request.path,
            "status": response.status_code,
            "user_id": getattr(user, "pk", None),
            "ip": request.META.get("REMOTE_ADDR"),
        })
        return response
`;
}

// Monitoring / tracing / rate-limit / audit wiring shared by both FastAPI
// entrypoints. `top` runs before the app exists; `after` runs right after.
function fastapiWiring(config: StackConfig): { top: string; after: string } {
  const top: string[] = [];
  const after: string[] = [];
  if (/sentry/.test(config.monitoring)) {
    top.push(`import os\nimport sentry_sdk\n\n# Initialised before the app so the FastAPI integration can hook in.\nsentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0)`);
  }
  if (/prometheus|grafana/.test(config.monitoring)) {
    after.push(`from prometheus_fastapi_instrumentator import Instrumentator\nInstrumentator().instrument(app).expose(app)  # GET /metrics`);
  }
  if (config.rateLimit) {
    after.push(`from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

# 60 requests / minute / client IP, in-memory. Pass storage_uri="redis://…" to share across replicas.
app.state.limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)`);
  }
  if (config.audit) {
    after.push(`from .audit import AuditMiddleware\napp.add_middleware(AuditMiddleware)`);
  }
  if (config.tracing) {
    after.push(`from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from .tracing import configure_tracing

configure_tracing()
FastAPIInstrumentor.instrument_app(app)`);
  }
  return {
    top: top.length ? "\n" + top.join("\n\n") + "\n" : "",
    after: after.length ? "\n" + after.join("\n\n") + "\n" : "",
  };
}

// ddtrace.auto must be the very first import: it patches libraries as they load.
function ddtracePreamble(config: StackConfig): string {
  return /datadog/.test(config.monitoring) ? "import ddtrace.auto  # noqa: F401 — must stay the first import\n" : "";
}

function appMain(config: StackConfig, endpoints: Endpoint[], entities: Entity[], authMode: PyAuthMode) {
  const withAuth = authMode !== "off";
  if (config.framework === "fastapi") {
    const patternExtraImports = pyPatternImports(endpoints, config, entities, authMode).join("\n");
    const wiring = fastapiWiring(config);
    const routes = endpoints
      .map((e) => {
        if (e.pattern) return pyPatternRoute(e, config, entities, authMode);
        const py = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
        const paramsDecl = (e.path.match(/:([a-zA-Z0-9_]+)/g) ?? [])
          .map((p) => `${p.slice(1)}: str`)
          .join(", ");
        return `@app.${e.method.toLowerCase()}(${JSON.stringify(py)})
async def ${handlerName(e)}(${paramsDecl}):
    return {"ok": True, "op": "${e.method} ${e.path}"}`;
      })
      .join("\n\n");

    if (entities.length > 0) {
      const routerImports = entities
        .map((e) => `from .routers import ${toSnake(e.name)}`)
        .join("\n");
      const routerIncludes = entities
        .map((e) => `app.include_router(${toSnake(e.name)}.router)`)
        .join("\n");

      return `${ddtracePreamble(config)}from fastapi import FastAPI, Depends, HTTPException, Header
from .config import settings
from .db import engine
from .logging_config import configure_logging
from .models import Base
${withAuth ? "from .auth import auth_required\n" : ""}${routerImports}
${patternExtraImports}

configure_logging()
${wiring.top}
Base.metadata.create_all(bind=engine)

app = FastAPI(title=settings.app_name)
${wiring.after}
${routerIncludes}


@app.get("/health")
async def health():
    return {"ok": True}

${routes}
`;
    }

    return `${ddtracePreamble(config)}from contextlib import asynccontextmanager
import math
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Header, Query, Response
from fastapi.responses import JSONResponse

from .config import settings
from .logging_config import configure_logging
${withAuth ? "from .auth import auth_required\n" : ""}${patternExtraImports}


configure_logging()
${wiring.top}

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Lifespan context — runs before the first request (startup) and after
    the last in-flight request drains (shutdown).

    Uvicorn already responds to SIGTERM by initiating a graceful shutdown,
    but it only invokes lifespan hooks if the app opts in to the lifespan
    protocol. By passing \`lifespan=lifespan\` below we guarantee that any
    cleanup (DB pool.dispose(), worker cancellation, etc.) runs on the way
    out — essential for K8s rolling deploys.
    """
    # Startup — add resource init here (DB warmup, cache pre-fill, …).
    yield
    # Shutdown — add resource teardown here (close DB pools, flush buffers, …).


app = FastAPI(title=settings.app_name, lifespan=lifespan)
${wiring.after}

@app.get("/health")
async def health():
    return {"ok": True}

${routes}
`;
  }
  if (config.framework === "litestar") {
    const prom = /prometheus|grafana/.test(config.monitoring);
    const middleware = [
      config.rateLimit ? "RateLimitConfig(rate_limit=(\"minute\", 60)).middleware" : "",
      prom ? "PrometheusConfig().middleware" : "",
      config.tracing ? "OpenTelemetryConfig().middleware" : "",
      config.audit ? "AuditMiddleware" : "",
    ].filter(Boolean);
    const routes = pyNativeRoutes("litestar", endpoints, config, entities, authMode);
    const decorators = ["get", "post", "put", "patch", "delete"].filter((m) => m === "get" || routes.some((r) => r.method === m));
    const deps = [
      routes.some((r) => r.db) ? `"db": Provide(get_db)` : "",
      routes.some((r) => r.claims) ? `"claims": Provide(auth_required)` : "",
    ].filter(Boolean);
    const authNames = [routes.some((r) => r.claims) ? "auth_required" : "", routes.some((r) => r.code.includes("guards=[auth_guard]")) ? "auth_guard" : ""].filter(Boolean);
    const localImports = [
      deps.length ? "from litestar.di import Provide\n" : "",
      ...pyNativeImports(routes, "litestar", entities).map((l) => l + "\n"),
      entities.length ? "from .db import engine\nfrom .models import Base\n" : "",
      routes.some((r) => r.db) ? "from .db import get_db\n" : "",
      authNames.length ? `from .auth import ${authNames.join(", ")}\n` : "",
    ].join("");
    return `${ddtracePreamble(config)}from contextlib import asynccontextmanager

from litestar import Litestar, ${decorators.join(", ")}
${config.rateLimit ? "from litestar.middleware.rate_limit import RateLimitConfig\n" : ""}${prom ? "from litestar.contrib.prometheus import PrometheusConfig, PrometheusController\n" : ""}${config.tracing ? "from litestar.contrib.opentelemetry import OpenTelemetryConfig\n" : ""}
from .logging_config import configure_logging
${config.audit ? "from .audit import AuditMiddleware\n" : ""}${config.tracing ? "from .tracing import configure_tracing\n" : ""}${localImports}
configure_logging()
${config.tracing ? "configure_tracing()\n" : ""}${entities.length ? "Base.metadata.create_all(bind=engine)\n" : ""}${/sentry/.test(config.monitoring) ? `
import os
import sentry_sdk

# Initialised before the app; sentry-sdk auto-enables its Litestar integration.
sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0)
` : ""}

@asynccontextmanager
async def lifespan(_app: Litestar):
    # Startup — init resources here.
    yield
    # Shutdown — release resources here. Runs on SIGTERM from uvicorn.


@get("/health")
async def health() -> dict:
    return {"ok": True}
${routes.map((r) => `\n\n${r.code}\n`).join("")}

app = Litestar(
    route_handlers=[health${routes.map((r) => ", " + r.name).join("")}${prom ? ", PrometheusController" : ""}],
${deps.length ? `    dependencies={${deps.join(", ")}},\n` : ""}    lifespan=[lifespan],
    logging_config=None,  # keep the JSON root handler from configure_logging()
${middleware.length ? `    middleware=[${middleware.join(", ")}],\n` : ""})
`;
  }
  // Django: single-module project so `uvicorn app.main:app` (the Dockerfile
  // CMD) serves it without a separate settings package.
  const prom = /prometheus|grafana/.test(config.monitoring);
  const djMiddleware = [
    prom ? `"django_prometheus.middleware.PrometheusBeforeMiddleware"` : "",
    config.audit ? `"app.audit.AuditMiddleware"` : "",
    prom ? `"django_prometheus.middleware.PrometheusAfterMiddleware"` : "",
  ].filter(Boolean);
  const routes = pyNativeRoutes("django", endpoints, config, entities, authMode);
  // Django matches urlpatterns in order, so static paths ("users/search") go
  // before converter paths ("users/<str:id>") that would otherwise swallow them.
  const byPath = new Map<string, NativeRoute[]>();
  for (const r of routes) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const urls = [...byPath]
    .sort(([a], [b]) => (a.match(/</g) ?? []).length - (b.match(/</g) ?? []).length)
    .map(([p, rs]) => `    path(${JSON.stringify(p)}, _route(${rs.map((r) => `${r.method.toUpperCase()}=${r.name}`).join(", ")})),\n`)
    .join("");
  return `${ddtracePreamble(config)}import os

from django.conf import settings

from .logging_config import configure_logging

configure_logging()
${/sentry/.test(config.monitoring) ? `
import sentry_sdk

# sentry-sdk auto-enables its Django integration.
sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0)
` : ""}
settings.configure(
    DEBUG=os.environ.get("DEBUG") == "1",
    SECRET_KEY=os.environ.get("DJANGO_SECRET_KEY", "insecure-dev-only-set-DJANGO_SECRET_KEY"),
    ALLOWED_HOSTS=os.environ.get("ALLOWED_HOSTS", "*").split(","),
    ROOT_URLCONF=__name__,
    INSTALLED_APPS=[${prom ? `"django_prometheus"` : ""}],
    MIDDLEWARE=[${djMiddleware.join(", ")}],
)

from django.core.asgi import get_asgi_application  # noqa: E402 — needs settings
from django.http import ${routes.length ? "HttpResponse, " : ""}JsonResponse  # noqa: E402
from django.urls import ${prom ? "include, " : ""}path  # noqa: E402
${djangoRoutes(routes, entities, withAuth)}

def health(_):
    return JsonResponse({"ok": True})
${routes.map((r) => `\n\n${r.code}\n`).join("")}

urlpatterns = [
    path("health", health),
${urls}${prom ? `    path("", include("django_prometheus.urls")),  # GET /metrics\n` : ""}]

app = get_asgi_application()
`;
}

// Django wiring for pyNativeRoutes: imports + the _endpoint view adapter
// (auth, SQLAlchemy session, HTTPException → JSON, dict → JsonResponse) and
// _route, which dispatches one URL to its per-method views.
function djangoRoutes(routes: NativeRoute[], entities: Entity[], withAuth: boolean): string {
  if (!routes.length) return "";
  const db = routes.some((r) => r.db);
  const imports = [
    ...pyNativeImports(routes, "django", entities),
    ...(entities.length ? ["from .db import engine", "from .models import Base"] : []),
    ...(db ? ["from .db import SessionLocal"] : []),
    ...(withAuth ? ["from .auth import auth_required"] : []),
  ];
  return `${imports.join("\n")}
${entities.length ? "\nBase.metadata.create_all(bind=engine)\n" : ""}

def _endpoint(status=200${withAuth ? ", auth=False, claims=False" : ""}${db ? ", db=False" : ""}):
    def wrap(view):
        @functools.wraps(view)
        async def inner(request, **kwargs):
${withAuth ? `            if auth or claims:
                try:
                    token_claims = auth_required(request)
                except PermissionError as exc:
                    return JsonResponse({"detail": str(exc)}, status=401)
                if claims:
                    kwargs["claims"] = token_claims
` : ""}${db ? `            if db:
                kwargs["db"] = SessionLocal()
` : ""}            try:
                result = await view(request, **kwargs)
            except HTTPException as exc:
                return JsonResponse({"detail": exc.detail}, status=exc.status_code)
${db ? `            finally:
                if db:
                    kwargs["db"].close()
` : ""}            return result if isinstance(result, HttpResponse) else JsonResponse(result, status=status)
        return inner
    return wrap


def _route(**views):
    async def dispatch(request, **kwargs):
        view = views.get(request.method)
        if view is None:
            return JsonResponse({"detail": "method_not_allowed"}, status=405)
        return await view(request, **kwargs)
    return dispatch
`;
}

function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "by_" + p.slice(1) : p.replace(/[^a-zA-Z0-9]/g, "_")));
  return (e.method.toLowerCase() + "_" + parts.join("_")).replace(/_+$/g, "");
}

function confpyFile(): string {
  return `import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient

from app.main import app
from app.db import get_db
from app.models import Base


@pytest.fixture(scope="session")
def engine():
    _engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=_engine)
    yield _engine
    _engine.dispose()


@pytest.fixture()
def db(engine):
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def client(db):
    def _get_db():
        yield db

    app.dependency_overrides[get_db] = _get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
`;
}

function pyTestVal(type: FieldType): string {
  switch (type) {
    case "string": case "text": return '"test value"';
    case "number": return "1";
    case "boolean": return "True";
    case "uuid": return '"00000000-0000-0000-0000-000000000001"';
    case "date": return '"2024-01-01T00:00:00"';
    case "json": return "{}";
  }
}

function buildPyPayload(fields: EntityField[], isUpdate = false): string {
  const relevant = fields.slice(0, 4);
  if (relevant.length === 0) return '{"name": "test"}';
  const pairs = relevant.map((f) => {
    const val = isUpdate
      ? (f.type === "string" || f.type === "text" ? '"updated value"' : pyTestVal(f.type))
      : pyTestVal(f.type);
    return `"${f.name}": ${val}`;
  });
  return `{${pairs.join(", ")}}`;
}

function entityTestFile(snake: string, kebab: string, nonPkFields: EntityField[]): string {
  const requiredFields = nonPkFields.filter((f) => f.required);
  const createPayload = buildPyPayload(requiredFields);
  const updatePayload = buildPyPayload(requiredFields, true);
  return `def test_list_${snake}s_empty(client):
    res = client.get("/${kebab}s/")
    assert res.status_code == 200
    assert isinstance(res.json(), list)


def test_create_${snake}(client):
    res = client.post("/${kebab}s/", json=${createPayload})
    assert res.status_code == 201
    data = res.json()
    assert "id" in data
    return data["id"]


def test_get_${snake}(client):
    created = client.post("/${kebab}s/", json=${createPayload}).json()
    res = client.get(f"/${kebab}s/{created['id']}")
    assert res.status_code == 200
    assert res.json()["id"] == created["id"]


def test_get_${snake}_not_found(client):
    res = client.get("/${kebab}s/00000000-0000-0000-0000-000000000000")
    assert res.status_code == 404


def test_update_${snake}(client):
    created = client.post("/${kebab}s/", json=${createPayload}).json()
    res = client.put(f"/${kebab}s/{created['id']}", json=${updatePayload})
    assert res.status_code == 200


def test_delete_${snake}(client):
    created = client.post("/${kebab}s/", json=${createPayload}).json()
    res = client.delete(f"/${kebab}s/{created['id']}")
    assert res.status_code == 204
`;
}

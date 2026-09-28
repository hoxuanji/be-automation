import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab } from "./types";
import { pyGrpcFiles } from "./grpc/python";
import { pythonGraphqlFiles } from "./graphql/python";
import { isGraphqlSupported } from "./types";
import { AUTH_CREDENTIAL_ID, authCredentialEntities, selfAuthUser } from "./patterns/index";
import { pyPatternRoute, pyPatternImports, pyNativeRoutes, pyNativeImports, pyHasRedis, pyAuthMode, pyCrudPatternEntityIds, pyPatternPlan, type PyAuthMode, type NativeRoute } from "./patterns/python";
import { pyQueue, pyQueueDeps, pyQueueModule, pyWorkerModule } from "./queue/python";

export function pythonFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  // gRPC mode replaces the FastAPI / Django / Litestar bootstrap entirely.
  if (config.api === "grpc") {
    // Entity RPCs reuse the REST tree's config, SQLAlchemy db/models and token
    // verifier; Django's auth.py is the one without web-framework imports.
    const rest = pythonFiles({ ...config, api: "rest", framework: "django" }, endpoints, entities);
    return pyGrpcFiles(config, entities, config.tracing ? pyTracingModule(config.name) : "", endpoints, rest);
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
        # .env also carries vars read elsewhere (PORT, broker URLs, OTEL_*); don't crash on them.
        extra = "ignore"

settings = Settings()
`,
  });

  if (hasEntities && !isMongo && config.framework === "fastapi") {
    files.push({ path: "app/db.py", content: dbFile() });
    files.push({ path: "app/models.py", content: sqlalchemyModels(config, isMongo ? entities : [...entities, ...authCredentialEntities(config, endpoints, entities)]) });
    files.push({ path: "app/routers/__init__.py", content: "" });
    for (const entity of routerEntities(endpoints, entities)) {
      const snake = toSnake(entity.name);
      const pascal = toPascal(entity.name);
      const kebab = toKebab(entity.name);
      const nonPkFields = entity.fields.filter((f) => !f.primaryKey);
      files.push({
        path: `app/routers/${snake}.py`,
        content: entityRouterFile(pascal, snake, kebab, nonPkFields),
      });
    }
    for (const entity of routerEntities(endpoints, entities)) {
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
    if (!isMongo) files.push({ path: "app/db.py", content: dbFile() });
    files.push({ path: "app/models.py", content: sqlalchemyModels(config, isMongo ? entities : [...entities, ...authCredentialEntities(config, endpoints, entities)]) });
  }

  files.push({
    path: "app/main.py",
    content: appMain(config, endpoints, hasEntities && !isMongo ? entities : [], authMode),
  });

  // Contract tests (endpoints) and FastAPI router tests share one hermetic test environment.
  if (endpoints.length > 0 || files.some((f) => f.path.startsWith("tests/test_"))) {
    files.push({ path: "tests/__init__.py", content: "" });
    files.push({ path: "tests/conftest.py", content: confpyFile(config, hasEntities && !isMongo, authMode) });
  }

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
  const queue = pyQueue(config);
  if (queue) {
    files.push({ path: "app/queue.py", content: pyQueueModule(queue, config) });
    files.push({ path: "app/worker.py", content: pyWorkerModule() });
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

// FastAPI routers (unauthenticated generic CRUD) only for entities no crud_* pattern
// serves: a router mounted beside the guarded pattern routes would shadow them.
function routerEntities(endpoints: Endpoint[], entities: Entity[]): Entity[] {
  const served = pyCrudPatternEntityIds(endpoints, entities);
  return entities.filter((e) => !served.has(e.id));
}

function dbFile(): string {
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

from sqlalchemy import create_engine, event
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

# Decided by the URL, not the configured DB: the ./app.db fallback and the test
# suite's temp database are SQLite whatever the production database is.
if _is_sqlite:
    # Requests hop threads (threadpool dependencies, test clients); SQLite needs the opt-in.
    _engine_kwargs = {"pool_pre_ping": True, "connect_args": {"check_same_thread": False}}
else:
    _engine_kwargs = {"pool_pre_ping": True, "pool_size": 10, "max_overflow": 20, "pool_recycle": 1800}

engine = create_engine(_url, **_engine_kwargs)

if _is_sqlite:
    # SQLite ignores FOREIGN KEY / ON DELETE CASCADE unless each connection opts in.
    @event.listens_for(engine, "connect")
    def _sqlite_foreign_keys(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")


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
      // DateTime columns need a datetime (SQLite's driver rejects ISO strings); Pydantic parses the JSON string.
      const t = f.type === "date" ? "datetime" : pyType(f.type);
      return f.required ? `    ${f.name}: ${t}` : `    ${f.name}: ${t} | None = None`;
    })
    .join("\n");

  const assignFields = nonPkFields.map((f) => `        ${f.name}=body.${f.name},`).join("\n");

  return `${nonPkFields.some((f) => f.type === "date") ? "from datetime import datetime\n\n" : ""}from fastapi import APIRouter, Depends, HTTPException
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

  // The credentials row is deleted with its user (see AUTH_CREDENTIAL_ID).
  const credUser = selfAuthUser(entities);
  const models = entities
    .map((e) => {
      const tableName = toSnake(e.name) + "s";
      const cols = e.fields.map((f) => {
        const fk = e.id === AUTH_CREDENTIAL_ID && credUser && f.name === "user_id"
          ? `, ForeignKey("${toSnake(credUser.entity.name)}s.${credUser.pk.name}", ondelete="CASCADE")` : "";
        const colType = saColType(f.type, isPostgres);
        const pk = f.primaryKey ? ", primary_key=True" : "";
        const uniq = f.unique && !f.primaryKey ? ", unique=True" : "";
        const nullable = !f.required && !f.primaryKey ? ", nullable=True" : "";
        // Server-generated string ids (uuid columns hold the str form; see saColType), so POST bodies can omit the PK.
        const default_ = f.primaryKey && (f.type === "uuid" || f.type === "string") ? ", default=lambda: str(uuid.uuid4())" : "";
        // Attribute keeps the entity (JSON) name; the column is snake_case like db/sql.ts's migration.
        const col = toSnake(f.name);
        const colName = col === f.name ? "" : `"${col}", `;
        // The migration makes these server-managed (NOT NULL DEFAULT now); mirror that here.
        if (col === "created_at") return `    ${f.name} = Column(${colName}DateTime, default=datetime.utcnow)`;
        if (col === "updated_at") return `    ${f.name} = Column(${colName}DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)`;
        return `    ${f.name} = Column(${colName}${colType}${fk}${pk}${default_}${uniq}${nullable})`;
      });
      if (!e.fields.some((f) => toSnake(f.name) === "created_at"))
        cols.push("    created_at = Column(DateTime, default=datetime.utcnow)");
      if (!e.fields.some((f) => toSnake(f.name) === "updated_at"))
        cols.push("    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)");

      return `class ${e.name}(Base):\n    __tablename__ = "${tableName}"\n${cols.join("\n")}`;
    })
    .join("\n\n");

  return `# Auto-generated by Helios — edit freely
from sqlalchemy import JSON, Column, String, Float, Boolean, DateTime, Text${entities.some((e) => e.id === AUTH_CREDENTIAL_ID) ? ", ForeignKey" : ""}
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
    case "number":  return "float";
    case "boolean": return "bool";
    case "date":    return "str";
    case "json":    return "dict";
  }
}

function saColType(t: FieldType, isPostgres: boolean): string {
  switch (t) {
    // as_uuid=False: ids are str in Python on every dialect (path params, JWT subs, SQLite tests).
    case "uuid":    return isPostgres ? "UUID(as_uuid=False)" : "String(36)";
    case "string":  return "String(255)";
    case "text":    return "Text";
    case "number":  return "Float"; // migrations: DOUBLE PRECISION / DOUBLE / REAL
    case "boolean": return "Boolean";
    case "date":    return "DateTime";
    case "json":    return isPostgres ? "JSON().with_variant(JSONB(), \"postgresql\")" : "JSON";
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
  const queue = pyQueue(config);
  // bullmq pins redis==7.4.x, so a direct redis dependency has to match it.
  if (pyHasRedis(config)) extra.push(queue === "bullmq" ? `redis = "^7.4.1"` : `redis = "^5.2.0"`);
  extra.push(...pyQueueDeps(queue));
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
  // A configured broker is connected at startup, closed on shutdown and
  // checked by the readiness probe (GET /health?ready=1); plain /health stays liveness.
  const hasQueue = !!pyQueue(config);
  const fastapiHealth = hasQueue ? `@app.get("/health")
async def health(ready: int = 0):
    if ready and not await broker.ping():
        raise HTTPException(status_code=503, detail="queue_unavailable")
    return {"ok": True}` : `@app.get("/health")
async def health():
    return {"ok": True}`;
  if (config.framework === "fastapi") {
    const patternExtraImports = pyPatternImports(endpoints, config, entities, authMode).join("\n");
    const wiring = fastapiWiring(config);
    // Starlette matches routes in registration order, so static paths ("/users/search")
    // go before converter paths ("/users/{id}") that would otherwise swallow them.
    const routes = [...endpoints]
      .sort((a, b) => pathParamCount(a.path) - pathParamCount(b.path))
      .map((e) => {
        if (e.pattern) return pyPatternRoute(e, config, entities, authMode);
        const py = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
        const paramsDecl = (e.path.match(/:([a-zA-Z0-9_]+)/g) ?? [])
          .map((p) => `${p.slice(1)}: str`)
          .join(", ");
        // Same status codes and guard as the pattern routes (and the Litestar / Django stubs).
        const status = e.method === "POST" ? ", status_code=201" : e.method === "DELETE" ? ", status_code=204" : "";
        const guard = e.auth && withAuth ? ", dependencies=[Depends(auth_required)]" : "";
        return `@app.${e.method.toLowerCase()}(${JSON.stringify(py)}${status}${guard})
async def ${handlerName(e)}(${paramsDecl}):
    return {"ok": True, "op": "${e.method} ${e.path}"}`;
      })
      .join("\n\n");

    if (entities.length > 0) {
      const routerImports = routerEntities(endpoints, entities)
        .map((e) => `from .routers import ${toSnake(e.name)}`)
        .join("\n");
      const routerIncludes = routerEntities(endpoints, entities)
        .map((e) => `app.include_router(${toSnake(e.name)}.router)`)
        .join("\n");

      return `${ddtracePreamble(config)}${hasQueue ? "from contextlib import asynccontextmanager\n\n" : ""}from fastapi import FastAPI, Depends, HTTPException, Header
from .config import settings
from .db import engine
${hasQueue ? "from . import queue as broker\n" : ""}from .logging_config import configure_logging
from .models import Base
${withAuth ? "from .auth import auth_required\n" : ""}${routerImports}
${patternExtraImports}

configure_logging()
${wiring.top}
Base.metadata.create_all(bind=engine)
${hasQueue ? `

@asynccontextmanager
async def lifespan(_: FastAPI):
    await broker.connect()
    yield
    await broker.close()

` : ""}
app = FastAPI(title=settings.app_name${hasQueue ? ", lifespan=lifespan" : ""})
${wiring.after}


${fastapiHealth}

${routes}
${routerIncludes ? `
# After the routes above, so static paths like "/posts/stats" win over the routers' "/{id}".
${routerIncludes}
` : ""}`;
    }

    return `${ddtracePreamble(config)}from contextlib import asynccontextmanager
import math
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Header, Query, Response
from fastapi.responses import JSONResponse

from .config import settings
${hasQueue ? "from . import queue as broker\n" : ""}from .logging_config import configure_logging
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
${hasQueue ? "    await broker.connect()\n" : ""}    yield
    # Shutdown — add resource teardown here (close DB pools, flush buffers, …).
${hasQueue ? "    await broker.close()\n" : ""}

app = FastAPI(title=settings.app_name, lifespan=lifespan)
${wiring.after}

${fastapiHealth}

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
${hasQueue ? "from litestar.exceptions import ServiceUnavailableException\n\nfrom . import queue as broker\n" : ""}from .logging_config import configure_logging
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
${hasQueue ? "    await broker.connect()\n" : ""}    yield
    # Shutdown — release resources here. Runs on SIGTERM from uvicorn.
${hasQueue ? "    await broker.close()\n" : ""}

${hasQueue ? `@get("/health")
async def health(ready: int = 0) -> dict:
    if ready and not await broker.ping():
        raise ServiceUnavailableException(detail="queue_unavailable")
    return {"ok": True}` : `@get("/health")
async def health() -> dict:
    return {"ok": True}`}
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

${hasQueue ? "from . import queue as broker\n" : ""}from .logging_config import configure_logging

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

${hasQueue ? `async def health(request):
    if request.GET.get("ready") and not await broker.ping():
        return JsonResponse({"ok": False, "detail": "queue_unavailable"}, status=503)
    return JsonResponse({"ok": True})` : `def health(_):
    return JsonResponse({"ok": True})`}
${routes.map((r) => `\n\n${r.code}\n`).join("")}

urlpatterns = [
    path("health", health),
${urls}${prom ? `    path("", include("django_prometheus.urls")),  # GET /metrics\n` : ""}]

${hasQueue ? djangoQueueLifespan() : "app = get_asgi_application()\n"}`;
}

// Django's ASGI handler ignores the lifespan protocol, so wrap it: uvicorn's
// startup / shutdown events connect and close the broker.
function djangoQueueLifespan(): string {
  return `_django_app = get_asgi_application()


async def app(scope, receive, send):
    if scope["type"] != "lifespan":
        await _django_app(scope, receive, send)
        return
    while True:
        message = await receive()
        if message["type"] == "lifespan.startup":
            try:
                await broker.connect()
            except Exception as exc:
                await send({"type": "lifespan.startup.failed", "message": str(exc)})
                return
            await send({"type": "lifespan.startup.complete"})
        elif message["type"] == "lifespan.shutdown":
            await broker.close()
            await send({"type": "lifespan.shutdown.complete"})
            return
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

function pathParamCount(path: string): number {
  return (path.match(/:/g) ?? []).length;
}

function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "by_" + p.slice(1) : p.replace(/[^a-zA-Z0-9]/g, "_")));
  return (e.method.toLowerCase() + "_" + parts.join("_")).replace(/_+$/g, "");
}

// Hermetic pytest environment for every framework: env set before the app is
// imported, cache / queue clients swapped for in-memory fakes through their
// module-level seams, test-signed tokens, empty tables per test.
function confpyFile(config: StackConfig, hasDb: boolean, authMode: PyAuthMode): string {
  const fw = config.framework;
  const redis = pyHasRedis(config);
  const queue = !!pyQueue(config);
  const s: string[] = [];
  s.push(`"""Test environment — runs with no database server, cache, broker or identity provider.

App modules read their settings at import, so the environment is set first:
SQLite in a temp dir, the OTel SDK off, test secrets. The cache and queue
clients are swapped for in-memory fakes through their module-level seams
(app.cache.redis_client, app.queue.*)${authMode === "jwks" ? ", and the JWKS lookup returns a test key, so\ntokens are still verified (signature, issuer, expiry)" : ""}.
"""
import os
import tempfile
${authMode === "jwks" ? "import time\n" : ""}
os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["WEBHOOK_SECRET"] = "test-webhook-secret"
${/datadog/.test(config.monitoring) ? `os.environ["DD_TRACE_ENABLED"] = "false"\n` : ""}${authMode === "hs256" ? `os.environ["JWT_SECRET"] = "test-jwt-secret-used-only-by-the-test-suite-0123456789"\n` : ""}${authMode === "jwks" ? `os.environ["AUTH_ISSUER"] = "https://issuer.test/"
os.environ["AUTH_JWKS_URL"] = "https://issuer.test/.well-known/jwks.json"  # never fetched: see _TestJWKS
os.environ.pop("AUTH_AUDIENCE", None)
` : ""}
import pytest  # noqa: E402`);
  if (redis) s.push(`from app import cache  # noqa: E402


class FakeRedis:
    """The redis.asyncio calls the app makes, backed by a dict."""

    def __init__(self):
        self.data: dict = {}

    async def get(self, key):
        return self.data.get(key)

    async def set(self, key, value, ex=None):
        self.data[key] = value
        return True

    async def delete(self, *keys):
        return sum(self.data.pop(k, None) is not None for k in keys)

    async def ping(self):
        return True


cache.redis_client = FakeRedis()  # before app.main imports the name`);
  if (queue) s.push(`from app import queue as broker  # noqa: E402

published: list = []


async def _noop() -> None:
    return None


async def _ping() -> bool:
    return True


async def _publish(topic: str, payload: dict) -> None:
    published.append((topic, payload))


# The app calls these through the module (broker.publish), so swapping them is the whole fake.
broker.connect, broker.close, broker.ping, broker.publish = _noop, _noop, _ping, _publish`);
  if (authMode === "jwks") s.push(`import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

from app import auth  # noqa: E402

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _TestJWKS:
    """Stands in for PyJWKClient: every token's signing key is the test key's public half."""

    def get_signing_key_from_jwt(self, _token):
        return type("SigningKey", (), {"key": _KEY.public_key()})()


auth._jwks_client = lambda: _TestJWKS()


def _make_token(sub: str) -> str:
    now = int(time.time())
    claims = {"sub": sub, "iss": os.environ["AUTH_ISSUER"], "iat": now, "exp": now + 300}
    return jwt.encode(claims, _KEY, algorithm="RS256")`);
  if (authMode === "hs256") s.push(`from app import auth  # noqa: E402


def _make_token(sub: str) -> str:
    return auth.create_access_token(sub)  # the app's own issuer, keyed by JWT_SECRET above`);
  s.push(fw === "django" ? `import app.main  # noqa: E402,F401 — runs settings.configure() and defines the URLconf` : `from app.main import app  # noqa: E402`);
  if (fw === "fastapi") s.push(`from fastapi.testclient import TestClient  # noqa: E402`);
  if (fw === "litestar") s.push(`from litestar.testing import TestClient  # noqa: E402${config.rateLimit ? "\nfrom litestar.stores.memory import MemoryStore  # noqa: E402" : ""}`);
  if (fw === "django") s.push(`import json as _json  # noqa: E402

from django.core.files.uploadedfile import SimpleUploadedFile  # noqa: E402
from django.test import Client  # noqa: E402`);
  if (hasDb) s.push(`from app.db import engine  # noqa: E402
from app.models import Base  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_tables():
    """Every test starts with empty tables."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield`);
  if (config.rateLimit && fw === "fastapi") s.push(`@pytest.fixture(autouse=True)
def _rate_limit_window():
    """The limiter stays on; each test gets a fresh window."""
    app.state.limiter.reset()
    yield`);
  if (config.rateLimit && fw === "litestar") s.push(`@pytest.fixture(autouse=True)
def _rate_limit_window():
    """The limiter stays on; each test gets a fresh window."""
    app.stores.register("rate_limit", MemoryStore(), allow_override=True)
    yield`);
  if (redis) s.push(`@pytest.fixture()
def fake_cache():
    cache.redis_client.data.clear()
    return cache.redis_client`);
  if (queue) s.push(`@pytest.fixture()
def published_messages():
    """(topic, payload) pairs the app published during the test."""
    published.clear()
    return published`);
  if (authMode !== "off") s.push(`@pytest.fixture()
def token():
    """token(sub) -> a bearer token app.auth accepts."""
    return _make_token`);
  if (fw === "django") s.push(`class DjangoTestClient:
    """httpx-style request() over django.test.Client, so the tests read the same on every framework."""

    def __init__(self):
        self._client = Client()

    def request(self, method, path, headers=None, json=None, files=None, content=None):
        headers = dict(headers or {})
        content_type = next((headers.pop(k) for k in list(headers) if k.lower() == "content-type"), "application/json")
        if files is not None:
            data = {k: SimpleUploadedFile(name, body, content_type=ctype) for k, (name, body, ctype) in files.items()}
            return self._client.post(path, data=data, headers=headers)
        if json is not None:
            content = _json.dumps(json)
        return self._client.generic(method, path, data=content or b"", content_type=content_type, headers=headers)


@pytest.fixture()
def client():
    return DjangoTestClient()`);
  else s.push(`@pytest.fixture()
def client():
    with TestClient(${fw === "litestar" ? "app=app" : "app"}) as c:  # runs the app's lifespan (fake broker connect / close)
        yield c`);
  return s.join("\n\n\n") + "\n";
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
// ─── Contract tests ─────────────────────────────────────────────────────────
// One pytest module over every endpoint, run in-process against conftest.py's
// fakes. Expectations come from pyPatternPlan — the same decision the route
// generator made — so a test fails when a handler stops doing its job.

const PY_PASSWORD = "correct-horse-battery";

function pyContractValue(f: EntityField, json: boolean): string {
  switch (f.type) {
    case "string": case "text":
      return f.name === "email" ? `f"user-{uuid.uuid4().hex[:12]}@example.com"` : `f"${f.name}-{uuid.uuid4().hex[:12]}"`;
    case "number": return "1.5";
    case "boolean": return "True";
    case "uuid": return "str(uuid.uuid4())";
    case "date": return json ? `"2024-01-01T00:00:00"` : "datetime(2024, 1, 1)";
    case "json": return `{"key": "value"}`;
  }
}

function pyDictLiteral(pairs: [string, string][]): string {
  return `{${pairs.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")}}`;
}

// Server-generated PKs (uuid / string) are left to the model default.
const pyServerPk = (f: EntityField) => f.type === "uuid" || f.type === "string";

function pyEntityHelpers(e: Entity): string {
  const snake = toSnake(e.name);
  const pk = e.fields.find((f) => f.primaryKey);
  const valueFields = e.fields.filter((f) => !(f.primaryKey && pyServerPk(f)));
  const bodyFields = e.fields.filter((f) => !f.primaryKey);
  return `def _${snake}_values() -> dict:
    """Model attributes for a direct insert."""
    return ${pyDictLiteral(valueFields.map((f) => [f.name, pyContractValue(f, false)]))}


def _${snake}_body() -> dict:
    """JSON body the create / update routes accept."""
    return ${pyDictLiteral(bodyFields.map((f) => [f.name, pyContractValue(f, true)]))}


def _seed_${snake}() -> str:
    with SessionLocal() as db:
        item = ${e.name}(**_${snake}_values())
        db.add(item)
        db.commit()
        return str(item.${pk?.name ?? "id"})
`;
}

type PyCase = { name: string; fixtures: string[]; body: string[] };

export function pythonContractTestFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  // gRPC / GraphQL trees serve no REST routes to test.
  if (config.api === "grpc" || config.api === "graphql" || endpoints.length === 0) return [];
  const fw = config.framework;
  const mode = pyAuthMode(config, endpoints);
  const dbEntities = /mongo/.test(config.database) ? [] : entities;
  const queue = !!pyQueue(config);
  const redis = pyHasRedis(config);
  const user = selfAuthUser(dbEntities);
  const used = new Set<Entity>();
  const flags = { uuid: false, datetime: false, hmac: false, bcrypt: false, auth: false, creds: false };
  const names = new Map<string, number>();
  const uniq = (n: string) => {
    const c = (names.get(n) ?? 0) + 1;
    names.set(n, c);
    return c === 1 ? n : `${n}_${c}`;
  };
  const q = (s: string) => JSON.stringify(s);

  const cases: PyCase[] = [{
    name: "test_health",
    fixtures: ["client"],
    body: [
      `res = client.request("GET", "/health")`,
      `assert res.status_code == 200`,
      `assert res.json()["ok"] is True`,
      ...(queue ? [`assert client.request("GET", "/health?ready=1").status_code == 200  # broker reachable`] : []),
    ],
  }];

  // Same dedupe as pyNativeRoutes (FastAPI's own /health also shadows a user GET /health).
  const seen = new Set(["GET /health"]);
  for (const e of endpoints) {
    const key = `${e.method} ${e.path.replace(/\/+$/, "") || "/"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { kind, entity } = e.pattern ? pyPatternPlan(e, dbEntities, mode) : { kind: "custom" as const, entity: undefined };
    const params = (e.path.match(/:([a-zA-Z0-9_]+)/g) ?? []).map((p) => p.slice(1));
    const last = params[params.length - 1];
    // The resource id goes in the last path param; any others get a fixed value.
    const pathWith = (idVar?: string) => {
      const s = e.path.replace(/:([a-zA-Z0-9_]+)/g, (_, p: string) => (idVar && p === last ? `{${idVar}}` : `test-${p}`));
      return idVar && last ? `f${q(s)}` : q(s);
    };
    const claimsKinds = ["auth_me", "auth_logout", "auth_change_password"];
    const guarded = mode !== "off" && (e.auth || claimsKinds.includes(kind));
    const base = uniq(`test_${e.method.toLowerCase()}_${e.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "root"}`);
    const m = e.method;
    const auth = (sub = `'test-user'`) => (guarded ? `{"Authorization": f"Bearer {token(${sub})}"}` : "");
    const hdr = (sub?: string) => (guarded ? `, headers=${auth(sub)}` : "");
    const fx = ["client", ...(guarded ? ["token"] : [])];
    const snake = entity ? toSnake(entity.name) : "";
    const pk = entity?.fields.find((f) => f.primaryKey)?.name ?? "id";
    const Model = entity?.name ?? "";
    const missingId = () => { flags.uuid = true; return `missing = str(uuid.uuid4())`; };
    if (entity) { used.add(entity); flags.uuid = true; }
    const echoKeys = entity ? entity.fields.filter((f) => !f.primaryKey && f.type !== "date").map((f) => f.name) : [];
    const echo = (v: string) => echoKeys.length ? [`for k in (${echoKeys.map(q).join(", ")},):`, `    assert ${v}[k] == body[k], k`] : [];

    if (guarded) {
      cases.push({
        name: `${base}_requires_token`,
        fixtures: ["client"],
        body: [
          `assert client.request(${q(m)}, ${pathWith()}).status_code == 401`,
          `assert client.request(${q(m)}, ${pathWith()}, headers={"Authorization": "Bearer not-a-valid-token"}).status_code == 401`,
        ],
      });
    }

    let c: PyCase;
    switch (kind) {
      case "provider_managed": case "no_entity": case "no_user":
        c = { name: `${base}_not_implemented`, fixtures: fx, body: [`res = client.request(${q(m)}, ${pathWith()}${hdr()})`, `assert res.status_code == 501`] };
        break;
      case "crud_list": case "paginated_search":
        c = { name: base, fixtures: fx, body: [
          `${snake}_id = _seed_${snake}()`,
          `res = client.request("GET", ${pathWith()}${hdr()})`,
          `assert res.status_code == 200`,
          `body = res.json()`,
          `assert [row[${q(pk)}] for row in body["data"]] == [${snake}_id]`,
          kind === "crud_list" ? `assert body["meta"]["total"] == 1` : `assert body["has_more"] is False`,
        ] };
        break;
      case "aggregate_stats":
        c = { name: base, fixtures: fx, body: [
          `_seed_${snake}()`,
          `res = client.request("GET", ${pathWith()}${hdr()})`,
          `assert res.status_code == 200`,
          `assert sum(row["count"] for row in res.json()["data"]) == 1`,
          `assert client.request("GET", ${pathWith()} + "?group_by=fortnight"${hdr()}).status_code == 422`,
        ] };
        break;
      case "crud_get": case "cache_read":
        if (!entity) {
          c = { name: base, fixtures: fx, body: [`assert client.request("GET", ${pathWith()}${hdr()}).status_code == 404`] };
          break;
        }
        c = { name: base, fixtures: [...fx, ...(kind === "cache_read" && redis ? ["fake_cache"] : [])], body: [
          `${snake}_id = _seed_${snake}()`,
          `res = client.request("GET", ${pathWith(`${snake}_id`)}${hdr()})`,
          `assert res.status_code == 200`,
          `assert res.json()[${q(pk)}] == ${snake}_id`,
          ...(kind === "cache_read" && redis ? [
            `assert len(fake_cache.data) == 1  # populated on the miss`,
            `assert client.request("GET", ${pathWith(`${snake}_id`)}${hdr()}).json()[${q(pk)}] == ${snake}_id  # served from cache`,
          ] : []),
          missingId(),
          `assert client.request("GET", ${pathWith("missing")}${hdr()}).status_code == 404`,
        ] };
        break;
      case "crud_create":
        c = { name: base, fixtures: fx, body: [
          `body = _${snake}_body()`,
          `res = client.request("POST", ${pathWith()}${hdr()}, json=body)`,
          `assert res.status_code == 201`,
          `created = res.json()`,
          ...echo("created"),
          `with SessionLocal() as db:`,
          `    assert db.get(${Model}, created[${q(pk)}]) is not None`,
        ] };
        break;
      case "crud_update":
        c = { name: base, fixtures: fx, body: [
          `${snake}_id = _seed_${snake}()`,
          `body = _${snake}_body()`,
          `res = client.request(${q(m)}, ${pathWith(`${snake}_id`)}${hdr()}, json=body)`,
          `assert res.status_code == 200`,
          `updated = res.json()`,
          `assert updated[${q(pk)}] == ${snake}_id`,
          ...echo("updated"),
          missingId(),
          `assert client.request(${q(m)}, ${pathWith("missing")}${hdr()}, json=body).status_code == 404`,
        ] };
        break;
      case "crud_delete":
        c = { name: base, fixtures: fx, body: [
          `${snake}_id = _seed_${snake}()`,
          `assert client.request("DELETE", ${pathWith(`${snake}_id`)}${hdr()}).status_code == 204`,
          `with SessionLocal() as db:`,
          `    assert db.get(${Model}, ${snake}_id) is None`,
          `assert client.request("DELETE", ${pathWith(`${snake}_id`)}${hdr()}).status_code == 404`,
        ] };
        break;
      case "auth_login": {
        flags.auth = flags.creds = true;
        c = { name: base, fixtures: fx, body: [
          `user_id, email = _seed_login()`,
          `res = client.request("POST", ${pathWith()}${hdr()}, json={"email": email, "password": PASSWORD})`,
          `assert res.status_code == 201`,
          `assert auth.verify_token(res.json()["token"])["sub"] == user_id`,
          `assert client.request("POST", ${pathWith()}${hdr()}, json={"email": email, "password": "wrong-password"}).status_code == 401`,
        ] };
        break;
      }
      case "auth_register": {
        flags.auth = flags.uuid = true;
        const extra = user!.settable.map((f) => [f.name, pyContractValue(f, true)] as [string, string]);
        c = { name: base, fixtures: fx, body: [
          `body = ${pyDictLiteral([["email", `f"new-{uuid.uuid4().hex[:12]}@example.com"`], ["password", "PASSWORD"], ...extra])}`,
          `res = client.request("POST", ${pathWith()}${hdr()}, json=body)`,
          `assert res.status_code == 201`,
          `created = res.json()`,
          `assert created["user"]["email"] == body["email"]`,
          `assert auth.verify_token(created["token"])["sub"] == created["user"]["id"]`,
          `assert client.request("POST", ${pathWith()}${hdr()}, json=body).status_code == 409  # email taken`,
        ] };
        break;
      }
      case "auth_me":
        c = { name: base, fixtures: fx, body: [
          `res = client.request(${q(m)}, ${pathWith()}${hdr(`'user-123'`)})`,
          `assert res.status_code == 200`,
          `assert res.json()["sub"] == "user-123"`,
        ] };
        break;
      case "auth_logout":
        c = { name: base, fixtures: fx, body: [`assert client.request(${q(m)}, ${pathWith()}${hdr()}${["POST", "PUT", "PATCH"].includes(m) ? ", json={}" : ""}).status_code == 204`] };
        break;
      case "auth_refresh":
        flags.auth = true;
        c = { name: base, fixtures: [...fx, ...(guarded ? [] : ["token"])], body: [
          `res = client.request("POST", ${pathWith()}${hdr()}, json={"refresh_token": token("user-123")})`,
          `assert res.status_code == 201`,
          `assert auth.verify_token(res.json()["token"])["sub"] == "user-123"`,
          `assert client.request("POST", ${pathWith()}${hdr()}, json={"refresh_token": "not-a-token"}).status_code == 401`,
        ] };
        break;
      case "auth_change_password":
        flags.creds = true;
        c = { name: base, fixtures: fx, body: [
          `user_id, _ = _seed_login()`,
          `res = client.request("POST", ${pathWith()}${hdr("user_id")}, json={"current_password": PASSWORD, "new_password": "a-brand-new-password"})`,
          `assert res.status_code == 204`,
          `with SessionLocal() as db:`,
          `    assert bcrypt.checkpw(b"a-brand-new-password", db.get(AuthCredential, user_id).password_hash.encode())`,
          `wrong = {"current_password": "wrong-password", "new_password": "another-new-password"}`,
          `assert client.request("POST", ${pathWith()}${hdr("user_id")}, json=wrong).status_code == 401`,
        ] };
        break;
      case "health_check":
        c = { name: base, fixtures: fx, body: [
          `res = client.request(${q(m)}, ${pathWith()}${hdr()})`,
          `assert res.status_code == 200`,
          `assert res.json() == ${pyDictLiteral([["status", `"ok"`], ...(dbEntities.length ? [["db", `"ok"`]] as [string, string][] : []), ...(redis ? [["cache", `"ok"`]] as [string, string][] : []), ...(queue ? [["queue", `"ok"`]] as [string, string][] : [])])}`,
        ] };
        break;
      case "webhook_receive": {
        flags.hmac = true;
        const signed = guarded ? `{**${auth()}, "x-hub-signature-256": sig, "content-type": "application/json"}` : `{"x-hub-signature-256": sig, "content-type": "application/json"}`;
        c = { name: base, fixtures: [...fx, ...(queue ? ["published_messages"] : [])], body: [
          `raw = b'{"id": "evt_1"}'`,
          `sig = "sha256=" + hmac.new(b"test-webhook-secret", raw, hashlib.sha256).hexdigest()`,
          `res = client.request("POST", ${pathWith()}, content=raw, headers=${signed})`,
          ...(queue
            ? [`assert res.status_code == 201`, `assert res.json()["received"] is True`, `assert published_messages == [("webhooks", {"body": raw.decode()})]`]
            : [`assert res.status_code == 503  # no queue configured to hand the event to`]),
          `sig = "sha256=" + "0" * 64`,
          `assert client.request("POST", ${pathWith()}, content=raw, headers=${signed}).status_code == 401`,
        ] };
        break;
      }
      case "file_upload":
        c = { name: base, fixtures: fx, body: [
          `res = client.request("POST", ${pathWith()}${hdr()}, files={"file": ("pixel.png", b"\\x89PNG\\r\\n\\x1a\\n", "image/png")})`,
          `assert res.status_code == 201`,
          `assert res.json()["mime"] == "image/png"`,
          `assert client.request("POST", ${pathWith()}${hdr()}, files={"file": ("notes.txt", b"hi", "text/plain")}).status_code == 415`,
        ] };
        break;
      case "send_notification":
        c = { name: base, fixtures: [...fx, ...(queue ? ["published_messages"] : [])], body: [
          `body = {"recipient": "user@example.com", "channel": "email", "message": "hello"}`,
          `res = client.request("POST", ${pathWith()}${hdr()}, json=body)`,
          ...(queue
            ? [`assert res.status_code == 201`, `assert res.json() == {"queued": True, "channel": "email"}`, `assert published_messages == [("notifications", body)]`]
            : [`assert res.status_code == 503  # no queue configured to deliver it`]),
        ] };
        break;
      default: {
        // Plain routes and custom handlers.
        const call = `client.request(${q(m)}, ${pathWith()}${hdr()}${["POST", "PUT", "PATCH"].includes(m) ? ", json={}" : ""})`;
        if (e.logicCode) {
          // FastAPI runs the custom code as written; Litestar / Django keep it as a comment and answer 501.
          c = { name: base, fixtures: fx, body: fw === "fastapi" ? [`assert ${call}.status_code not in (404, 405)  # served`] : [`assert ${call}.status_code == 501`] };
          break;
        }
        const status = m === "POST" ? 201 : m === "DELETE" ? (fw === "litestar" ? 200 : 204) : 200;
        c = { name: base, fixtures: fx, body: [`res = ${call}`, `assert res.status_code == ${status}`, ...(status === 204 ? [] : [`assert res.json()["ok"] is True`])] };
      }
    }
    cases.push(c);
  }

  if (flags.creds) { used.add(user!.entity); flags.auth = flags.bcrypt = true; }
  const needsDb = used.size > 0;
  if (used.size) flags.uuid = true;
  if ([...used].some((e) => e.fields.some((f) => f.type === "date"))) flags.datetime = true;
  const models = [...[...used].map((e) => e.name), ...(flags.creds ? ["AuthCredential"] : [])];
  const imports = [
    ...(flags.hmac ? ["import hashlib", "import hmac"] : []),
    ...(flags.uuid ? ["import uuid"] : []),
    ...(flags.datetime ? ["from datetime import datetime"] : []),
    ...(flags.bcrypt ? ["", "import bcrypt"] : []),
    ...(flags.auth || needsDb ? [""] : []),
    ...(flags.auth ? ["from app import auth"] : []),
    ...(needsDb ? ["from app.db import SessionLocal", `from app.models import ${models.join(", ")}`] : []),
  ];
  const helpers = [
    ...[...used].map(pyEntityHelpers),
    ...(flags.creds ? [`PASSWORD = ${q(PY_PASSWORD)}


def _seed_login() -> tuple[str, str]:
    """A ${user!.entity.name} with a password credential; returns (id, email)."""
    ${toSnake(user!.entity.name)}_id = _seed_${toSnake(user!.entity.name)}()
    with SessionLocal() as db:
        db.add(AuthCredential(user_id=${toSnake(user!.entity.name)}_id, password_hash=bcrypt.hashpw(PASSWORD.encode(), bcrypt.gensalt()).decode()))
        db.commit()
        return ${toSnake(user!.entity.name)}_id, db.get(${user!.entity.name}, ${toSnake(user!.entity.name)}_id).${user!.email.name}
`] : []),
  ];
  const tests = cases.map((c) => `def ${c.name}(${[...new Set(c.fixtures)].join(", ")}):\n${c.body.map((l) => `    ${l}`).join("\n")}\n`);
  const content = `"""API contract tests for ${config.name} — in-process, against the fakes in conftest.py.

Every route is served; protected routes reject missing / invalid tokens with
401; data routes round-trip through the database; publishers hand off to the
queue. Run with: pytest -q
"""
${imports.join("\n")}


${[...helpers, ...tests].join("\n\n")}`;
  return [{ path: "tests/test_contracts.py", content: content.replace(/\n{3,}(?=def |PASSWORD)/g, "\n\n\n") }];
}

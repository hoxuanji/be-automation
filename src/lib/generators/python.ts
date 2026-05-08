import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab } from "./types";

export function pythonFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const hasEntities = entities.length > 0;
  const isMongo = /mongo/.test(config.database);

  files.push({ path: "pyproject.toml", content: pyproject(config, hasEntities) });
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
    files.push({ path: "app/models.py", content: sqlalchemyModels(config, entities) });
  }

  files.push({
    path: "app/main.py",
    content: appMain(config, endpoints, hasEntities && !isMongo ? entities : []),
  });

  return files;
}

function dbFile(config: StackConfig): string {
  const isSqlite = /sqlite/.test(config.database);
  const connectArgs = isSqlite
    ? `\nconnect_args = {"check_same_thread": False} if "sqlite" in (settings.database_url or "") else {}`
    : "";
  return `from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from .config import settings
${connectArgs ? connectArgs + "\n" : ""}
_url = settings.database_url or "sqlite:///./app.db"
engine = create_engine(_url${isSqlite ? ', connect_args={"check_same_thread": False}' : ""})
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
        const default_ = f.primaryKey && f.type === "uuid" ? ", default=uuid.uuid4" : "";
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

function pyproject(config: StackConfig, withModels = false) {
  const isPostgres = /postgres|neon|supabase|cockroach/.test(config.database);
  const sqlDeps = withModels && !(/mongo/.test(config.database))
    ? `\nsqlalchemy = "^2.0.0"\nalembic = "^1.13.0"\n${isPostgres ? `psycopg2-binary = "^2.9.0"\n` : `aiosqlite = "^0.20.0"\n`}`
    : "";
  const deps =
    config.framework === "fastapi"
      ? `fastapi = "^0.115.0"\nuvicorn = { extras = ["standard"], version = "^0.30.0" }\npydantic = "^2.9.0"\npydantic-settings = "^2.5.0"${sqlDeps}`
      : config.framework === "litestar"
      ? `litestar = { extras = ["standard"], version = "^2.12.0" }\npydantic-settings = "^2.5.0"${sqlDeps}`
      : `django = "^5.1.0"\npydantic-settings = "^2.5.0"${sqlDeps}`;
  return `[project]
name = "${config.name}"
version = "0.1.0"
requires-python = ">=3.12"

[tool.poetry.dependencies]
python = "^3.12"
${deps}

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"
httpx = "^0.27.0"
pytest-asyncio = "^0.23.0"
`;
}

function pyDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml ./
RUN pip install --no-cache-dir poetry==1.8.3 && poetry config virtualenvs.create false && poetry install --only main --no-root || pip install fastapi uvicorn pydantic pydantic-settings
COPY . .
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

function appMain(config: StackConfig, endpoints: Endpoint[], entities: Entity[]) {
  if (config.framework === "fastapi") {
    const routes = endpoints
      .map((e) => {
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

      return `from fastapi import FastAPI, Depends, HTTPException, Header
from .config import settings
from .db import engine
from .models import Base
${routerImports}

Base.metadata.create_all(bind=engine)

app = FastAPI(title=settings.app_name)

${routerIncludes}


async def auth_required(authorization: str | None = Header(default=None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
async def health():
    return {"ok": True}

${routes}
`;
    }

    return `from fastapi import FastAPI, Depends, HTTPException, Header
from .config import settings

app = FastAPI(title=settings.app_name)


async def auth_required(authorization: str | None = Header(default=None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
async def health():
    return {"ok": True}

${routes}
`;
  }
  if (config.framework === "litestar") {
    return `from litestar import Litestar, get

@get("/health")
async def health() -> dict:
    return {"ok": True}

app = Litestar(route_handlers=[health])
`;
  }
  // django minimal
  return `# Minimal Django entrypoint — see deploy/k8s for production setup
from django.http import JsonResponse
from django.urls import path

def health(_):
    return JsonResponse({"ok": True})

urlpatterns = [path("health", health)]
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

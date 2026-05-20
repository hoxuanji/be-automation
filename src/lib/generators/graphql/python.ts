import type { Entity, GeneratedFile, StackConfig } from "../types";
import { primaryKey, pluralize } from "./schema";

/**
 * Emits a Python GraphQL server using Strawberry. We pick Strawberry over
 * Graphene because (a) it's type-hint-driven, which composes better with
 * the rest of the FastAPI/SQLAlchemy code we generate, and (b) its
 * @strawberry.type / @strawberry.field decorators read like dataclasses
 * — friendlier than Graphene's class-attribute-as-field pattern.
 *
 * The schema.py file is the single source of truth for types and
 * resolvers. We do not emit a separate SDL parser — Strawberry derives
 * the SDL from Python types at startup. The graphql/schema.graphql file
 * (emitted by the shared SDL generator) is included for reference and
 * tooling parity with TS/Go.
 */
export function pythonGraphqlFiles(
  config: StackConfig,
  entities: Entity[]
): GeneratedFile[] {
  void config;
  const files: GeneratedFile[] = [];

  files.push({ path: "app/__init__.py", content: "" });
  files.push({ path: "app/main.py", content: pyGraphqlMain() });
  files.push({ path: "app/schema.py", content: pyGraphqlSchema(entities) });
  files.push({ path: "app/graphql_store.py", content: pyGraphqlStore(entities) });
  files.push({ path: "pyproject.toml", content: pyGraphqlPyproject() });
  files.push({ path: "Dockerfile", content: pyGraphqlDockerfile() });

  return files;
}

function pyGraphqlPyproject(): string {
  return `[tool.poetry]
name = "graphql-app"
version = "0.1.0"
description = "Helios-generated GraphQL server"
authors = ["you <you@example.com>"]
package-mode = false

[tool.poetry.dependencies]
python = "^3.12"
fastapi = "^0.115.0"
uvicorn = {extras = ["standard"], version = "^0.32.0"}
"strawberry-graphql" = {extras = ["fastapi"], version = "^0.247.0"}

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"
httpx = "^0.27.0"

[build-system]
requires = ["poetry-core>=1.0.0"]
build-backend = "poetry.core.masonry.api"
`;
}

function pyGraphqlDockerfile(): string {
  return `# syntax=docker/dockerfile:1.7

FROM python:3.12-slim AS deps
WORKDIR /app
RUN pip install --no-cache-dir poetry==1.8.4
COPY pyproject.toml ./
RUN poetry config virtualenvs.create false && poetry install --no-root --without dev

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin
COPY app ./app
COPY graphql ./graphql
RUN useradd -m -u 1001 app && chown -R app:app /app
USER app
EXPOSE 4000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4000"]
`;
}

function pyGraphqlMain(): string {
  return `"""Application entrypoint. Mounts the Strawberry schema at /graphql.

The schema is built once at import time so first request latency is dominated
by Python startup, not GraphQL introspection.
"""

import logging
import signal
from contextlib import asynccontextmanager

from fastapi import FastAPI
from strawberry.fastapi import GraphQLRouter

from app.schema import schema

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001 — FastAPI requires the parameter
    logger.info("startup: GraphQL ready at /graphql")
    yield
    logger.info("shutdown")


app = FastAPI(lifespan=lifespan)
graphql_app = GraphQLRouter(schema)
app.include_router(graphql_app, prefix="/graphql")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _term(*_args: object) -> None:
    """Strawberry/uvicorn handle SIGTERM themselves — this only runs if we are
    embedded in a host that doesn't. Safe to leave in place.
    """
    raise SystemExit(0)


for sig in (signal.SIGINT, signal.SIGTERM):
    try:
        signal.signal(sig, _term)
    except (ValueError, OSError):
        # Worker thread — uvicorn's main process owns the real handlers.
        pass
`;
}

function pyGraphqlSchema(entities: Entity[]): string {
  const imports = `import strawberry
from datetime import datetime
from typing import Optional
from uuid import uuid4

from app.graphql_store import store`;

  if (entities.length === 0) {
    return `${imports}


@strawberry.type
class Query:
    @strawberry.field
    def health(self) -> str:
        return "ok"


schema = strawberry.Schema(query=Query)
`;
  }

  const typeBlocks = entities.map((e) => buildPyType(e)).join("\n\n\n");
  const inputBlocks = entities.map((e) => buildPyInputs(e)).join("\n\n\n");
  const pageBlocks = entities.map((e) => buildPyPage(e)).join("\n\n\n");
  const queryFields = entities.map((e) => buildPyQueryFields(e)).join("\n\n");
  const mutationFields = entities.map((e) => buildPyMutationFields(e)).join("\n\n");

  return `${imports}


${typeBlocks}


${inputBlocks}


${pageBlocks}


@strawberry.type
class Query:
    @strawberry.field
    def health(self) -> str:
        return "ok"

${queryFields}


@strawberry.type
class Mutation:
${mutationFields}


schema = strawberry.Schema(query=Query, mutation=Mutation)
`;
}

function pyGraphqlStore(entities: Entity[]): string {
  // Single dict-of-dicts in-memory store. Each entity gets its own bucket.
  const buckets = entities.map((e) => `    "${e.name}": {},`).join("\n");
  return `"""In-memory store for the GraphQL resolvers.

Replace with SQLAlchemy / a real DB call when wiring persistence; the
resolver code in schema.py only depends on the dict interface here.
"""

from typing import Any

store: dict[str, dict[str, Any]] = {
${buckets}
}
`;
}

function buildPyType(e: Entity): string {
  const fields = e.fields.map((f) => {
    const t = pyType(f.type);
    const optional = f.required ? t : `Optional[${t}] = None`;
    return `    ${f.name}: ${optional}`;
  });
  return `@strawberry.type
class ${e.name}:
${fields.join("\n")}`;
}

function buildPyInputs(e: Entity): string {
  const pk = primaryKey(e);
  const isServerPk = pk.primaryKey && pk.type === "uuid";

  const createFields = e.fields
    .filter((f) => !(isServerPk && f === pk))
    .map((f) => {
      const t = pyType(f.type);
      const optional = f.required ? t : `Optional[${t}] = None`;
      return `    ${f.name}: ${optional}`;
    });

  const updateFields = [
    `    ${pk.name}: ${pyType(pk.type)}`,
    ...e.fields
      .filter((f) => f !== pk)
      .map((f) => {
        const t = pyType(f.type);
        const optional = f.required ? t : `Optional[${t}] = None`;
        return `    ${f.name}: ${optional}`;
      }),
  ];

  return `@strawberry.input
class Create${e.name}Input:
${createFields.join("\n")}


@strawberry.input
class Update${e.name}Input:
${updateFields.join("\n")}`;
}

function buildPyPage(e: Entity): string {
  const plural = pluralize(e.name);
  return `@strawberry.type
class ${plural}Page:
    items: list[${e.name}]
    total: int
    page: int
    page_size: int`;
}

function buildPyQueryFields(e: Entity): string {
  const pk = primaryKey(e);
  const plural = pluralize(e.name);
  return `    @strawberry.field
    def list_${snake(plural)}(self, page: int = 1, page_size: int = 20) -> ${plural}Page:
        bucket = store["${e.name}"]
        items = list(bucket.values())
        page = max(1, page)
        page_size = max(1, min(100, page_size))
        start = (page - 1) * page_size
        return ${plural}Page(
            items=items[start : start + page_size],
            total=len(items),
            page=page,
            page_size=page_size,
        )

    @strawberry.field
    def get_${snake(e.name)}(self, ${pk.name}: ${pyType(pk.type)}) -> Optional[${e.name}]:
        return store["${e.name}"].get(str(${pk.name}))`;
}

function buildPyMutationFields(e: Entity): string {
  const pk = primaryKey(e);
  return `    @strawberry.mutation
    def create_${snake(e.name)}(self, input: Create${e.name}Input) -> ${e.name}:
        data = strawberry.asdict(input)
        if not data.get("${pk.name}"):
            data["${pk.name}"] = str(uuid4())
        row = ${e.name}(**data)
        store["${e.name}"][str(data["${pk.name}"])] = row
        return row

    @strawberry.mutation
    def update_${snake(e.name)}(self, input: Update${e.name}Input) -> ${e.name}:
        data = strawberry.asdict(input)
        key = str(data["${pk.name}"])
        if key not in store["${e.name}"]:
            raise ValueError(f"${e.name} {key} not found")
        existing = store["${e.name}"][key]
        merged = {**existing.__dict__, **{k: v for k, v in data.items() if v is not None}}
        row = ${e.name}(**merged)
        store["${e.name}"][key] = row
        return row

    @strawberry.mutation
    def delete_${snake(e.name)}(self, ${pk.name}: ${pyType(pk.type)}) -> bool:
        return store["${e.name}"].pop(str(${pk.name}), None) is not None`;
}

function pyType(t: string): string {
  switch (t) {
    case "string":
    case "text":
    case "uuid":
      return "str";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "date":
      return "datetime";
    case "json":
      return "strawberry.scalars.JSON";
    default:
      return "str";
  }
}

function snake(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

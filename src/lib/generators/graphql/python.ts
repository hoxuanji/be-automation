import type { Entity, GeneratedFile } from "../types";
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
 *
 * Resolvers use the REST data layer — app/db.py (SQLAlchemy session) and
 * app/models.py — taken from `restWithEntities`, the REST tree built with the
 * entities (its routers are not used). MongoDB has no REST data layer, so it
 * keeps an in-memory store.
 */
export function pythonGraphqlFiles(
  entities: Entity[],
  rest: GeneratedFile[],
  restWithEntities: GeneratedFile[]
): GeneratedFile[] {
  const dataLayer = restWithEntities.filter((f) => f.path === "app/db.py" || f.path === "app/models.py");
  const sql = dataLayer.some((f) => f.path === "app/db.py");
  const pyproject = restWithEntities.find((f) => f.path === "pyproject.toml")!;

  // `rest` is the FastAPI tree built with no routes. Mount Strawberry right
  // before /health, i.e. after every middleware wired onto `app`.
  const health = "\n\n@app.get(\"/health\")";
  const files = rest.map((f) => {
    if (f.path === "app/main.py") {
      if (!f.content.includes(health)) throw new Error("graphql/python: REST main.py has no /health route to mount GraphQL beside");
      return {
        ...f,
        content: f.content.replace(health, `\n\nfrom strawberry.fastapi import GraphQLRouter\n\nfrom .schema import schema\n\napp.include_router(GraphQLRouter(schema), prefix="/graphql")\n${health}`),
      };
    }
    if (f.path === "pyproject.toml") {
      if (!/^fastapi = .*$/m.test(pyproject.content)) throw new Error("graphql/python: REST pyproject.toml has no fastapi dependency");
      return { ...f, content: pyproject.content.replace(/^fastapi = .*$/m, `$&\nstrawberry-graphql = { extras = ["fastapi"], version = "^0.327.0" }`) };
    }
    return f;
  });

  files.push({ path: "app/schema.py", content: pyGraphqlSchema(entities, sql) });
  if (sql) files.push(...dataLayer);
  else if (entities.length > 0) files.push({ path: "app/graphql_store.py", content: pyGraphqlStore(entities) });

  return files;
}

function pyGraphqlSchema(entities: Entity[], sql: boolean): string {
  if (entities.length === 0) {
    return `import strawberry


@strawberry.type
class Query:
    @strawberry.field
    def health(self) -> str:
        return "ok"


schema = strawberry.Schema(query=Query)
`;
  }

  const imports = sql
    ? `import strawberry
from datetime import datetime
from typing import Optional

from graphql import GraphQLError
from sqlalchemy import func, select
from sqlalchemy.exc import DataError, IntegrityError

from app import models
from app.db import SessionLocal`
    : `import strawberry
from datetime import datetime
from typing import Optional
from uuid import uuid4

from graphql import GraphQLError

from app.graphql_store import store`;

  const helpers = sql
    ? `

def _not_found(entity: str, key) -> GraphQLError:
    return GraphQLError(f"{entity} {key} not found", extensions={"code": "NOT_FOUND"})


def _require(data: dict, fields: tuple[str, ...]) -> None:
    # Same rule as the REST validators: required strings must not be empty.
    for name in fields:
        if data.get(name) == "":
            raise GraphQLError(f"{name} must not be empty", extensions={"code": "BAD_USER_INPUT"})


def _lookup(db, model, key):
    try:
        return db.get(model, key)
    except DataError:  # e.g. a malformed UUID on Postgres
        db.rollback()
        return None


def _commit(db) -> None:
    try:
        db.commit()
    except (IntegrityError, DataError) as exc:
        db.rollback()
        raise GraphQLError(f"Invalid input: {exc.orig}", extensions={"code": "BAD_USER_INPUT"}) from exc`
    : `

def _not_found(entity: str, key) -> GraphQLError:
    return GraphQLError(f"{entity} {key} not found", extensions={"code": "NOT_FOUND"})`;

  const typeBlocks = entities.map((e) => buildPyType(e)).join("\n\n\n");
  const inputBlocks = entities.map((e) => buildPyInputs(e)).join("\n\n\n");
  const pageBlocks = entities.map((e) => buildPyPage(e)).join("\n\n\n");
  const outBlocks = sql ? "\n\n\n" + entities.map((e) => buildPyOut(e)).join("\n\n\n") : "";
  const queryFields = entities.map((e) => (sql ? buildSqlQueryFields(e) : buildPyQueryFields(e))).join("\n\n");
  const mutationFields = entities.map((e) => (sql ? buildSqlMutationFields(e) : buildPyMutationFields(e))).join("\n\n");

  return `${imports}
${helpers}


${typeBlocks}


${inputBlocks}


${pageBlocks}${outBlocks}


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

ponytail: MongoDB has no generated Python data layer (the REST routers are
SQLAlchemy-only), so GraphQL data lives in process memory — lost on restart
and not shared across replicas. Replace with a Motor/PyMongo repository.
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

// Maps a SQLAlchemy row (app/models.py) to the Strawberry type.
function buildPyOut(e: Entity): string {
  const args = e.fields.map((f) => `        ${f.name}=${f.type === "uuid" ? `str(row.${f.name}) if row.${f.name} is not None else None` : `row.${f.name}`},`);
  return `def _${snake(e.name)}_out(row: models.${e.name}) -> ${e.name}:
    return ${e.name}(
${args.join("\n")}
    )`;
}

function requiredStrings(e: Entity): string {
  const names = e.fields.filter((f) => f.required && f.type === "string" && f !== primaryKey(e)).map((f) => `"${f.name}"`);
  return `(${names.join(", ")}${names.length === 1 ? "," : ""})`;
}

function buildSqlQueryFields(e: Entity): string {
  const pk = primaryKey(e);
  const plural = pluralize(e.name);
  const out = `_${snake(e.name)}_out`;
  return `    @strawberry.field
    def list_${snake(plural)}(self, page: int = 1, page_size: int = 20) -> ${plural}Page:
        page = max(1, page)
        page_size = max(1, min(100, page_size))
        with SessionLocal() as db:
            total = db.scalar(select(func.count()).select_from(models.${e.name}))
            rows = db.scalars(
                select(models.${e.name})
                .order_by(models.${e.name}.${pk.name})
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
            return ${plural}Page(items=[${out}(r) for r in rows], total=total, page=page, page_size=page_size)

    @strawberry.field
    def get_${snake(e.name)}(self, ${pk.name}: ${pyType(pk.type)}) -> Optional[${e.name}]:
        with SessionLocal() as db:
            row = _lookup(db, models.${e.name}, ${pk.name})
            return ${out}(row) if row is not None else None`;
}

function buildSqlMutationFields(e: Entity): string {
  const pk = primaryKey(e);
  const out = `_${snake(e.name)}_out`;
  const req = requiredStrings(e);
  return `    @strawberry.mutation
    def create_${snake(e.name)}(self, input: Create${e.name}Input) -> ${e.name}:
        data = strawberry.asdict(input)
        _require(data, ${req})
        with SessionLocal() as db:
            row = models.${e.name}(**data)
            db.add(row)
            _commit(db)
            db.refresh(row)
            return ${out}(row)

    @strawberry.mutation
    def update_${snake(e.name)}(self, input: Update${e.name}Input) -> ${e.name}:
        data = strawberry.asdict(input)
        key = data.pop("${pk.name}")
        _require(data, ${req})
        with SessionLocal() as db:
            row = _lookup(db, models.${e.name}, key)
            if row is None:
                raise _not_found("${e.name}", key)
            for name, value in data.items():  # full replace, as declared by Update${e.name}Input
                setattr(row, name, value)
            _commit(db)
            db.refresh(row)
            return ${out}(row)

    @strawberry.mutation
    def delete_${snake(e.name)}(self, ${pk.name}: ${pyType(pk.type)}) -> bool:
        with SessionLocal() as db:
            row = _lookup(db, models.${e.name}, ${pk.name})
            if row is None:
                raise _not_found("${e.name}", ${pk.name})
            db.delete(row)
            _commit(db)
            return True`;
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
            raise _not_found("${e.name}", key)
        existing = store["${e.name}"][key]
        merged = {**existing.__dict__, **{k: v for k, v in data.items() if v is not None}}
        row = ${e.name}(**merged)
        store["${e.name}"][key] = row
        return row

    @strawberry.mutation
    def delete_${snake(e.name)}(self, ${pk.name}: ${pyType(pk.type)}) -> bool:
        if store["${e.name}"].pop(str(${pk.name}), None) is None:
            raise _not_found("${e.name}", ${pk.name})
        return True`;
}

function pyType(t: string): string {
  switch (t) {
    case "uuid":
      return "strawberry.ID";
    case "string":
    case "text":
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

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
 */
export function pythonGraphqlFiles(
  entities: Entity[],
  rest: GeneratedFile[]
): GeneratedFile[] {
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
      if (!/^fastapi = .*$/m.test(f.content)) throw new Error("graphql/python: REST pyproject.toml has no fastapi dependency");
      return { ...f, content: f.content.replace(/^fastapi = .*$/m, `$&\nstrawberry-graphql = { extras = ["fastapi"], version = "^0.247.0" }`) };
    }
    return f;
  });

  files.push({ path: "app/schema.py", content: pyGraphqlSchema(entities) });
  files.push({ path: "app/graphql_store.py", content: pyGraphqlStore(entities) });

  return files;
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

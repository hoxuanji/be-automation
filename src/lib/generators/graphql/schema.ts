import type { Entity, EntityField, FieldType, StackConfig } from "../types";
import { toPascal } from "../types";

// ─── Type mapping ────────────────────────────────────────────────────────────

// Helios field type → GraphQL scalar. UUIDs and dates use custom scalars so
// resolvers can validate format; clients typically alias them to String.
function gqlScalar(type: FieldType): string {
  switch (type) {
    case "string":
    case "text":
      return "String";
    case "uuid":
      return "ID";
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "date":
      return "DateTime";
    case "json":
      return "JSON";
  }
}

// Returns the SDL field signature: `name: Type[!]`.
function gqlField(f: EntityField): string {
  const base = gqlScalar(f.type);
  const required = f.required ? "!" : "";
  return `  ${f.name}: ${base}${required}`;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export type GraphqlSchemaFile = {
  path: string;
  content: string;
};

/**
 * Generates the GraphQL Schema Definition Language (SDL) string. The same
 * SDL is used by every supported language — only the resolver bindings
 * differ. Returns one file at `graphql/schema.graphql` (POSIX path).
 *
 * REST endpoints don't translate cleanly to GraphQL operations (verb + path
 * vs typed query/mutation), so the generator emits CRUD per entity and adds
 * a `health` query. Endpoints are surfaced as a comment so the user knows
 * they were intentionally skipped.
 */
export function generateGraphqlSchema(
  config: StackConfig,
  entities: Entity[],
  endpointCount: number
): GraphqlSchemaFile {
  void config; // kept for parity with proto generator; reserved for future use
  const blocks: string[] = [];

  // Always-present scalars and root types.
  blocks.push(
    [
      "# Auto-generated GraphQL schema. Edit by re-running Helios codegen.",
      "scalar DateTime",
      "scalar JSON",
    ].join("\n")
  );

  if (entities.length === 0) {
    blocks.push(
      [
        "# No entities defined — the only operation exposed is `health`.",
        "# Add entities in the builder and regenerate to get full CRUD.",
      ].join("\n")
    );
  }

  // One Type per entity + per-entity input shapes for create/update.
  for (const e of entities) {
    blocks.push(buildEntityType(e));
    blocks.push(buildEntityInputs(e));
  }

  // Root Query: health + per-entity list/get.
  const queries: string[] = ["  health: String!"];
  for (const e of entities) {
    queries.push(`  list${pluralize(e.name)}(page: Int = 1, pageSize: Int = 20): ${pluralize(e.name)}Page!`);
    const pk = primaryKey(e);
    queries.push(`  get${e.name}(${pk.name}: ${pkScalar(pk)}!): ${e.name}`);
  }
  blocks.push(`type Query {\n${queries.join("\n")}\n}`);

  // Root Mutation (only if at least one entity).
  if (entities.length > 0) {
    const mutations: string[] = [];
    for (const e of entities) {
      mutations.push(`  create${e.name}(input: Create${e.name}Input!): ${e.name}!`);
      mutations.push(`  update${e.name}(input: Update${e.name}Input!): ${e.name}!`);
      const pk = primaryKey(e);
      mutations.push(`  delete${e.name}(${pk.name}: ${pkScalar(pk)}!): Boolean!`);
    }
    blocks.push(`type Mutation {\n${mutations.join("\n")}\n}`);
  }

  // Pagination wrapper types.
  for (const e of entities) {
    blocks.push(
      `type ${pluralize(e.name)}Page {\n  items: [${e.name}!]!\n  total: Int!\n  page: Int!\n  pageSize: Int!\n}`
    );
  }

  if (endpointCount > 0) {
    blocks.push(
      [
        "# NOTE: REST-style endpoints (method + path) don't translate cleanly to",
        "#       GraphQL. They have been skipped in this schema. Switch",
        "#       `config.api` back to `rest` to regenerate their REST handlers,",
        "#       or model the same operations as entities for full GraphQL coverage.",
      ].join("\n")
    );
  }

  return {
    path: "graphql/schema.graphql",
    content: blocks.join("\n\n") + "\n",
  };
}

// ─── Helpers exported for resolver generators ────────────────────────────────

export function primaryKey(e: Entity): EntityField {
  return e.fields.find((f) => f.primaryKey) ?? e.fields[0];
}

export function pkScalar(f: EntityField): string {
  return gqlScalar(f.type);
}

export function pluralize(name: string): string {
  // Naive English plural — sufficient for generated identifiers. Users who
  // care about irregular plurals can rename in the editor.
  if (/(s|x|z|ch|sh)$/.test(name)) return name + "es";
  if (/[^aeiou]y$/.test(name)) return name.slice(0, -1) + "ies";
  return name + "s";
}

export function entityTypeName(e: Entity): string {
  return toPascal(e.name);
}

// ─── Type / input builders ───────────────────────────────────────────────────

function buildEntityType(e: Entity): string {
  return `type ${e.name} {\n${e.fields.map(gqlField).join("\n")}\n}`;
}

function buildEntityInputs(e: Entity): string {
  // Create input excludes server-generated UUID primary keys; clients pass
  // values for everything else.
  const pk = primaryKey(e);
  const isServerPk = pk.primaryKey && pk.type === "uuid";
  const createFields = e.fields.filter((f) => !(isServerPk && f === pk));
  const createInput = `input Create${e.name}Input {\n${createFields.map(gqlField).join("\n")}\n}`;

  // Update is full-replace (mirrors gRPC). Optional PATCH semantics would need
  // a FieldMask-equivalent, which we skip for the first pass.
  const updateFields: string[] = [];
  updateFields.push(`  ${pk.name}: ${gqlScalar(pk.type)}!`);
  for (const f of e.fields) {
    if (f === pk) continue;
    updateFields.push(`  ${f.name}: ${gqlScalar(f.type)}${f.required ? "!" : ""}`);
  }
  const updateInput = `input Update${e.name}Input {\n${updateFields.join("\n")}\n}`;

  return [createInput, updateInput].join("\n\n");
}

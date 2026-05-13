import type { Entity, EntityField, FieldType, StackConfig } from "../types";
import { safeName, toSnake } from "../types";

// ─── Type mapping ────────────────────────────────────────────────────────────

// Helios field type → proto3 scalar / well-known type. When we need an import
// (Timestamp), the caller accumulates the set of WKT imports to add at the top
// of the proto file.
type ProtoType = { name: string; wkt?: "timestamp" };

function protoType(type: FieldType): ProtoType {
  switch (type) {
    case "string":
    case "text":
    case "uuid":
      return { name: "string" };
    case "number":
      // `double` covers integer and floating-point values without forcing the
      // user to pick int32/int64/float on the builder surface.
      return { name: "double" };
    case "boolean":
      return { name: "bool" };
    case "date":
      return { name: "google.protobuf.Timestamp", wkt: "timestamp" };
    case "json":
      // proto3's closest match is `bytes` (arbitrary opaque payload) OR a
      // `google.protobuf.Struct`. We pick bytes to keep client codegen simple.
      return { name: "bytes" };
  }
}

function snakeField(name: string): string {
  // proto3 convention is snake_case for field names.
  return toSnake(name);
}

// ─── Public entry point ──────────────────────────────────────────────────────

export type ProtoFile = {
  path: string;
  content: string;
};

/**
 * Generates a single `.proto` file describing one gRPC service per entity,
 * with standard CRUD RPCs and typed messages. Returns the file path (inside
 * the generated repo) and its string content.
 *
 * Non-CRUD REST endpoints are intentionally not translated to gRPC — the
 * semantic mismatch (HTTP verbs + paths vs. RPCs) produces bad proto. The
 * generator logs a warning comment in the proto file when endpoints exist
 * but have been skipped.
 */
export function generateProto(
  config: StackConfig,
  entities: Entity[],
  endpointCount: number
): ProtoFile {
  const pkg = safeName(config.name).replace(/-/g, "_") + ".v1";
  const goPackageOption = `github.com/your-username/${safeName(config.name)}/gen/go/${pkg.replace(/\./g, "/")};${pkg.split(".")[0]}v1`;
  const javaPackageOption = `dev.helios.${pkg.replace(/\./g, ".")}`;

  const wkt = new Set<"timestamp">();
  const body: string[] = [];

  // Auto-include a base `FieldMask`-style set of server-side timestamps so
  // clients can observe created/updated without the entity having to model it.
  const SERVER_TIMESTAMPS: EntityField[] = [
    { id: "_created_at", name: "createdAt", type: "date", required: false, unique: false } as EntityField,
    { id: "_updated_at", name: "updatedAt", type: "date", required: false, unique: false } as EntityField,
  ];

  if (entities.length === 0) {
    body.push("// No entities defined — gRPC output is empty. Add entities in the builder");
    body.push("// then regenerate to produce a service-per-entity proto file.");
  }

  for (const entity of entities) {
    const msg = buildEntityMessages(entity, SERVER_TIMESTAMPS, wkt);
    body.push(msg);
  }

  if (entities.length > 0) {
    for (const entity of entities) {
      body.push(buildService(entity));
    }
  }

  if (endpointCount > 0) {
    body.push(
      "// NOTE: REST-style endpoints (method + path) don't translate cleanly to",
      "//       gRPC. They have been skipped in this proto. Switch `config.api`",
      "//       back to `rest` to regenerate their REST handlers, or model the",
      "//       same operations as entities to get full gRPC coverage."
    );
  }

  const imports: string[] = [];
  if (wkt.has("timestamp")) imports.push(`import "google/protobuf/timestamp.proto";`);
  // Empty message type is handy for Delete responses.
  imports.push(`import "google/protobuf/empty.proto";`);

  const header = [
    `syntax = "proto3";`,
    ``,
    `package ${pkg};`,
    ``,
    ...imports,
    ``,
    `option go_package = "${goPackageOption}";`,
    `option java_multiple_files = true;`,
    `option java_package = "${javaPackageOption}";`,
    ``,
  ].join("\n");

  const content = header + body.join("\n\n") + "\n";
  return {
    path: `proto/${pkg.split(".")[0]}/v1/service.proto`,
    content,
  };
}

// ─── Messages ────────────────────────────────────────────────────────────────

function buildEntityMessages(
  entity: Entity,
  serverTimestamps: EntityField[],
  wkt: Set<"timestamp">
): string {
  const name = entity.name;
  const fields = entity.fields;

  // Main entity message — all user-defined fields plus server-managed
  // created_at/updated_at timestamps at fixed high field numbers so adding
  // new user fields never collides.
  const entityFields = fields.map((f, i) => formatField(f, i + 1, wkt));
  const timestampFields = serverTimestamps.map((f, i) => formatField(f, 90 + i, wkt));
  const entityMsg = `message ${name} {\n${[...entityFields, ...timestampFields].join("\n")}\n}`;

  // Request message for Get/Delete — keyed by the entity's primary key.
  const pk = fields.find((f) => f.primaryKey) ?? fields[0];
  const pkProto = protoType(pk.type);
  if (pkProto.wkt === "timestamp") wkt.add("timestamp");
  const keyReq = `message Get${name}Request {\n  ${pkProto.name} ${snakeField(pk.name)} = 1;\n}`;
  const deleteReq = `message Delete${name}Request {\n  ${pkProto.name} ${snakeField(pk.name)} = 1;\n}`;

  // Request message for Create — user-settable fields only (no PK if it's
  // server-generated UUID, and no server timestamps).
  const creatableFields = fields.filter((f) => !(f.primaryKey && f.type === "uuid"));
  const createReq = `message Create${name}Request {\n${creatableFields.map((f, i) => formatField(f, i + 1, wkt)).join("\n")}\n}`;

  // Update is a full replace (PUT-style) for simplicity — PATCH semantics need
  // FieldMask which is more than we want to inflict on a first pass.
  const updateReq = `message Update${name}Request {\n  ${pkProto.name} ${snakeField(pk.name)} = 1;\n${fields
    .filter((f) => f !== pk)
    .map((f, i) => formatField(f, i + 2, wkt))
    .join("\n")}\n}`;

  // List pagination: offset/limit is simpler than cursor tokens for a first
  // pass. Clients that want cursor paging can extend the proto later.
  const listReq = `message List${name}Request {\n  uint32 page = 1;\n  uint32 page_size = 2;\n}`;
  const listRes = `message List${name}Response {\n  repeated ${name} items = 1;\n  uint32 total = 2;\n  uint32 page = 3;\n  uint32 page_size = 4;\n}`;

  return [entityMsg, keyReq, deleteReq, createReq, updateReq, listReq, listRes].join("\n\n");
}

function formatField(f: EntityField, number: number, wkt: Set<"timestamp">): string {
  const t = protoType(f.type);
  if (t.wkt === "timestamp") wkt.add("timestamp");
  const comment = f.unique || f.primaryKey || f.required
    ? ` // ${[f.primaryKey && "pk", f.unique && "unique", f.required && "required"].filter(Boolean).join(", ")}`
    : "";
  return `  ${t.name} ${snakeField(f.name)} = ${number};${comment}`;
}

// ─── Services ────────────────────────────────────────────────────────────────

function buildService(entity: Entity): string {
  const name = entity.name;
  return [
    `service ${name}Service {`,
    `  rpc List${name}(List${name}Request) returns (List${name}Response);`,
    `  rpc Get${name}(Get${name}Request) returns (${name});`,
    `  rpc Create${name}(Create${name}Request) returns (${name});`,
    `  rpc Update${name}(Update${name}Request) returns (${name});`,
    `  rpc Delete${name}(Delete${name}Request) returns (google.protobuf.Empty);`,
    `}`,
  ].join("\n");
}

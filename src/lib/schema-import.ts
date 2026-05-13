import type { Entity, EntityField, FieldType } from "@/lib/store";

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeType(raw: string): FieldType {
  const t = raw.toLowerCase();
  if (t.includes("uuid") || t === "cuid" || t === "id") return "uuid";
  if (t === "text" || t === "longtext" || t === "clob") return "text";
  if (t === "int" || t === "integer" || t === "bigint" || t === "float" || t === "decimal" || t === "number" || t === "double" || t === "numeric" || t === "money") return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  if (t === "datetime" || t === "timestamp" || t === "date" || t === "timestamptz") return "date";
  if (t === "json" || t === "jsonb" || t === "object") return "json";
  return "string";
}

export function parsePrismaSchema(content: string): Entity[] {
  const entities: Entity[] = [];
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;

  while ((m = modelRegex.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields: EntityField[] = [];
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("@@"));

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const fieldName = parts[0];
      if (!fieldName || fieldName === "@@" || fieldName.startsWith("@")) continue;

      const rawType = parts[1].replace(/[?![\]]/g, "");
      const optional = parts[1].includes("?");
      const isId = line.includes("@id");
      const isUnique = line.includes("@unique");

      const prismaTypeMap: Record<string, FieldType> = {
        String: "string", Int: "number", Float: "number", Decimal: "number",
        Boolean: "boolean", DateTime: "date", Json: "json", BigInt: "number",
        Bytes: "string",
      };
      const type: FieldType = prismaTypeMap[rawType] ?? normalizeType(rawType);

      if (rawType[0] === rawType[0].toUpperCase() && !prismaTypeMap[rawType]) continue;

      fields.push({
        id: `f-${makeId()}`,
        name: fieldName,
        type,
        required: !optional,
        unique: isUnique || isId,
        primaryKey: isId,
      });
    }

    if (fields.length > 0) {
      entities.push({ id: `entity-${makeId()}`, name, fields });
    }
  }

  return entities;
}

export function parseHeliosJson(content: string): Entity[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }

  if (Array.isArray(parsed)) {
    return (parsed as unknown[]).flatMap((item) => parseEntityObject(item)).filter((e): e is Entity => !!e);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.entities)) {
      return (obj.entities as unknown[]).flatMap((item) => parseEntityObject(item)).filter((e): e is Entity => !!e);
    }
    if (Array.isArray(obj.models)) {
      return (obj.models as unknown[]).flatMap((item) => parseEntityObject(item)).filter((e): e is Entity => !!e);
    }
    const single = parseEntityObject(parsed);
    if (single) return [single];
  }
  return [];
}

function parseEntityObject(item: unknown): Entity | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : typeof obj.title === "string" ? obj.title : null;
  if (!name) return null;

  const rawFields = Array.isArray(obj.fields) ? obj.fields : Array.isArray(obj.properties) ? obj.properties : [];

  let fields: EntityField[] = [];

  if (rawFields.length > 0) {
    fields = (rawFields as unknown[]).flatMap((f): EntityField[] => {
      if (typeof f !== "object" || !f) return [];
      const ff = f as Record<string, unknown>;
      const fname = typeof ff.name === "string" ? ff.name : null;
      if (!fname) return [];
      return [{
        id: `f-${makeId()}`,
        name: fname,
        type: normalizeType(String(ff.type ?? "string")),
        required: ff.required === true || ff.required === 1,
        unique: ff.unique === true || ff.unique === 1,
        primaryKey: ff.primaryKey === true || fname === "id",
      }];
    });
  } else if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    const props = obj.properties as Record<string, Record<string, unknown>>;
    fields = Object.entries(props).map(([fname, fdef]) => ({
      id: `f-${makeId()}`,
      name: fname,
      type: normalizeType(String(fdef.type ?? "string")),
      required: Array.isArray(obj.required) && (obj.required as string[]).includes(fname),
      unique: false,
      primaryKey: fname === "id",
    }));
  }

  if (!fields.some((f) => f.primaryKey)) {
    fields.unshift({ id: `f-${makeId()}`, name: "id", type: "uuid", required: true, unique: true, primaryKey: true });
  }

  return { id: `entity-${makeId()}`, name: name[0].toUpperCase() + name.slice(1), fields };
}

export function detectAndParse(filename: string, content: string): Entity[] {
  if (filename.endsWith(".prisma")) return parsePrismaSchema(content);
  if (filename.endsWith(".json")) return parseHeliosJson(content);
  return [];
}

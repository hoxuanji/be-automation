import type { z } from "zod";
import type {
  stackConfigSchema,
  endpointSchema,
  entitySchema,
  entityFieldSchema,
  fieldTypeSchema,
} from "@/lib/schema";

export type StackConfig = z.infer<typeof stackConfigSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type EntityField = z.infer<typeof entityFieldSchema>;
export type FieldType = z.infer<typeof fieldTypeSchema>;

export type GeneratedFile = {
  path: string;
  content: string;
  mode?: number;
};

export function dedent(strings: TemplateStringsArray, ...values: unknown[]) {
  const raw = String.raw({ raw: strings }, ...values);
  const lines = raw.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const minIndent = nonEmpty.reduce((min, line) => {
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    return Math.min(min, indent);
  }, Infinity);
  return lines
    .map((l) => (l.length >= minIndent ? l.slice(minIndent) : l))
    .join("\n")
    .replace(/^\n/, "")
    .replace(/\n\s*$/, "\n");
}

export function toEnvKey(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function toPascal(s: string) {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

export function safeName(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

export function toKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

export function toSnake(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

export function toCamel(s: string): string {
  const pascal = toPascal(s);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : "";
}

// Languages where Helios emits a real gRPC server bootstrap. For others the
// proto/buf files are skipped and the generated README surfaces a warning.
// Lives in types.ts (not index.ts) to avoid a circular import with common.ts.
export function isGrpcSupported(language: "go" | "typescript" | "python" | "rust" | "java" | "kotlin"): boolean {
  return language === "go" || language === "typescript" || language === "python";
}

// Languages where Helios emits a real GraphQL server bootstrap. Other languages
// fall back to REST and the README surfaces a warning. Same shape as
// isGrpcSupported on purpose — both follow the schema-first language-shared
// dispatch pattern in index.ts.
export function isGraphqlSupported(language: "go" | "typescript" | "python" | "rust" | "java" | "kotlin"): boolean {
  return language === "go" || language === "typescript" || language === "python";
}

// Heuristic: treat any env var as sensitive if its key or value looks like a
// credential. Used to redact values out of committed artifacts (.env.example,
// README) even when the user forgets to flip the `secret` toggle.
export function looksLikeSecretValue(key: string, value: string): boolean {
  if (!value) return false;
  const k = key.toLowerCase();
  const sensitiveKey = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|auth|dsn|connection[_-]?string)/.test(k);
  if (sensitiveKey) return true;
  // URLs with embedded credentials (e.g. postgres://user:pass@host/db)
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i.test(value)) return true;
  // High-entropy-ish token (long, mostly alphanumeric with some symbols)
  if (value.length >= 24 && /^[A-Za-z0-9_\-+=/.]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)) {
    return true;
  }
  return false;
}

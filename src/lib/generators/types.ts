import type { z } from "zod";
import type {
  stackConfigSchema,
  endpointSchema,
} from "@/lib/schema";

export type StackConfig = z.infer<typeof stackConfigSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;

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

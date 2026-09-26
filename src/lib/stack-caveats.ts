// Single source of truth for "this choice is only partly supported for your
// stack" notes shown in the builder. Rules defer to the generator helpers so
// the UI can't drift from what actually gets emitted.
import type { StackConfig } from "@/lib/generators/types";
import type { StackConfig as StoreConfig } from "@/lib/store";
import { isGrpcSupported, isGraphqlSupported } from "@/lib/generators/types";
import { vercelSupported } from "@/lib/generators/deploy";

export type StackCaveat = {
  option: "queue" | "deployment" | "api";
  level: "warn" | "info";
  message: string;
};

const LANG: Record<StackConfig["language"], string> = {
  go: "Go", typescript: "TypeScript", python: "Python", rust: "Rust", java: "Java", kotlin: "Kotlin",
};

// Only the fields the rules read. Takes the store's looser type (language is
// `string` there) and narrows once; the generator helpers only read these.
type CaveatInput = Pick<StoreConfig, "language" | "framework" | "queue" | "deployment" | "api">;

export function stackCaveats(input: CaveatInput): StackCaveat[] {
  const config = input as StackConfig;
  const out: StackCaveat[] = [];
  const lang = LANG[config.language] ?? config.language;

  // TS uses bullmq on npm, Python the official bullmq PyPI port; the rest get a
  // plain Redis fallback (Java: pub/sub, Go/Rust/Kotlin: lists).
  if (config.queue === "bullmq" && config.language !== "typescript" && config.language !== "python") {
    out.push({
      option: "queue",
      level: "warn",
      message: `BullMQ has no ${lang} client, so Helios falls back to plain Redis ${config.language === "java" ? "pub/sub" : "lists"} on REDIS_URL. Not BullMQ-compatible (Node BullMQ workers won't see these jobs) and at-most-once.`,
    });
  }
  // TS, Python and Rust use JetStream; Go/Java/Kotlin use core NATS.
  if (config.queue === "nats" && (config.language === "go" || config.language === "java" || config.language === "kotlin")) {
    out.push({
      option: "queue",
      level: "info",
      message: `NATS in ${lang} uses core pub/sub: at-most-once, no redelivery. Switch to JetStream in the generated code if messages must survive a restart.`,
    });
  }
  if (config.deployment === "vercel" && !vercelSupported(config)) {
    out.push({
      option: "deployment",
      level: "warn",
      message: `Vercel only runs serverless TypeScript or Python/FastAPI (no gRPC). This ${lang}/${config.framework}${config.api === "grpc" ? " gRPC" : ""} stack will fail the deploy job; pick Railway, Render, Fly or a container platform.`,
    });
  }
  if (config.api === "grpc" && !isGrpcSupported(config.language)) {
    out.push({ option: "api", level: "warn", message: `gRPC isn't generated for ${lang} yet; the service falls back to REST.` });
  }
  if (config.api === "graphql" && !isGraphqlSupported(config.language)) {
    out.push({ option: "api", level: "warn", message: `GraphQL isn't generated for ${lang} yet; the service falls back to REST.` });
  }
  if (config.api === "trpc" && config.language !== "typescript") {
    out.push({ option: "api", level: "warn", message: `tRPC is TypeScript only; a ${lang} service falls back to REST.` });
  }
  return out;
}

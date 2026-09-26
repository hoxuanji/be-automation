// The builder warns users before they download a repo that silently degrades a
// choice (BullMQ -> Redis list, gRPC -> REST, Vercel deploy that fails). If a
// rule here stops firing, users find out from the generated repo instead.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { stackCaveats } from "@/lib/stack-caveats";
import type { StackConfig } from "@/lib/generators/types";

const cfg = (o: Partial<StackConfig>) =>
  ({ language: "typescript", framework: "express", queue: "none", deployment: "railway", api: "rest", ...o }) as StackConfig;
const options = (o: Partial<StackConfig>) => stackCaveats(cfg(o)).map((c) => c.option);

describe("stackCaveats", () => {
  it("is silent for a fully supported stack", () => {
    assert.deepEqual(stackCaveats(cfg({ queue: "bullmq", deployment: "vercel", api: "trpc" })), []);
  });

  it("BullMQ is real in TS and Python, a Redis fallback elsewhere", () => {
    assert.deepEqual(options({ language: "python", framework: "fastapi", queue: "bullmq" }), []);
    for (const language of ["go", "rust", "java", "kotlin"] as const) {
      assert.deepEqual(options({ language, queue: "bullmq" }), ["queue"], language);
    }
  });

  it("flags core (at-most-once) NATS only where JetStream isn't used", () => {
    for (const language of ["go", "java", "kotlin"] as const) assert.deepEqual(options({ language, queue: "nats" }), ["queue"]);
    for (const language of ["typescript", "python", "rust"] as const) assert.deepEqual(options({ language, queue: "nats" }), []);
  });

  it("Vercel: TS and FastAPI only, never gRPC", () => {
    assert.deepEqual(options({ language: "python", framework: "fastapi", deployment: "vercel" }), []);
    assert.deepEqual(options({ language: "python", framework: "django", deployment: "vercel" }), ["deployment"]);
    assert.deepEqual(options({ language: "go", framework: "gin", deployment: "vercel" }), ["deployment"]);
    assert.deepEqual(options({ deployment: "vercel", api: "grpc" }), ["deployment"]);
  });

  it("gRPC / GraphQL / tRPC fall back to REST where unsupported", () => {
    assert.deepEqual(options({ language: "go", api: "grpc" }), []);
    assert.deepEqual(options({ language: "rust", api: "grpc" }), ["api"]);
    assert.deepEqual(options({ language: "java", api: "graphql" }), ["api"]);
    assert.deepEqual(options({ language: "python", api: "trpc" }), ["api"]);
  });
});

import { commonFiles } from "./common";
import { goFiles } from "./go";
import { typescriptFiles } from "./typescript";
import { pythonFiles } from "./python";
import { rustFiles } from "./rust";
import { javaFiles } from "./java";
import { kotlinFiles } from "./kotlin";
import { generateProto } from "./grpc/proto";
import { bufFiles } from "./grpc/buf";
import { generateGraphqlSchema } from "./graphql/schema";
import { migrationFiles } from "./db/migrations";
import { clientSdkFiles } from "./client-sdk";
import { contractTestFiles } from "./contract-tests";
import { isGrpcSupported, isGraphqlSupported } from "./types";
import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { safeName } from "./types";
import type { GitConfig } from "../git-config";

export { isGrpcSupported, isGraphqlSupported } from "./types";

export function generate(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = [],
  gitConfig?: GitConfig
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  files.push(...commonFiles(config, endpoints, gitConfig));

  const wantsGrpc = config.api === "grpc";
  const grpcActive = wantsGrpc && isGrpcSupported(config.language);

  if (grpcActive) {
    const proto = generateProto(config, entities, endpoints.length);
    files.push({ path: proto.path, content: proto.content });
    for (const f of bufFiles(config)) {
      files.push(f);
    }
  }

  // Schema-first GraphQL: emit the SDL once, then each language attaches its
  // own server. We drop the SDL even for unsupported languages so users have
  // a starting point if they want to wire up a third-party GraphQL server.
  const wantsGraphql = config.api === "graphql";
  const graphqlActive = wantsGraphql && isGraphqlSupported(config.language);

  if (wantsGraphql) {
    const sdl = generateGraphqlSchema(config, entities, endpoints.length);
    files.push({ path: sdl.path, content: sdl.content });
  }

  void graphqlActive; // language entry points re-check this; kept for symmetry

  switch (config.language) {
    case "go":
      files.push(...goFiles(config, endpoints, entities));
      break;
    case "typescript":
      files.push(...typescriptFiles(config, endpoints, entities));
      break;
    case "python":
      files.push(...pythonFiles(config, endpoints, entities));
      break;
    case "rust":
      files.push(...rustFiles(config, endpoints, entities));
      break;
    case "java":
      files.push(...javaFiles(config, endpoints, entities));
      break;
    case "kotlin":
      files.push(...kotlinFiles(config, endpoints, entities));
      break;
  }

  // Migration scaffolding is language-aware but keyed on the stack's DB dialect.
  // Skipped for schemaless / keyvalue stores and when there are no entities.
  files.push(...migrationFiles(config, entities));

  // Typed client SDKs (TypeScript + Python) derived from the endpoint list.
  // Only emitted when there are endpoints to generate methods for.
  files.push(...clientSdkFiles(safeName(config.name), endpoints));

  // Contract tests — one test file per endpoint, covering status codes + content-type.
  files.push(...contractTestFiles(config, endpoints, entities));

  addComposeWorker(files);

  // Stable sort for deterministic zip contents
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

// Queue consumers each language emits, and how to start one from the api image.
// Keyed on the generated file so the worker service exists exactly when a worker does.
const WORKER_ENTRY: Record<string, string> = {
  "cmd/worker/main.go": `entrypoint: ["/worker"]`,
  "src/worker.ts": `command: ["node", "dist/worker.js"]`,
  "app/worker.py": `command: ["python", "-m", "app.worker"]`,
  "src/bin/worker.rs": `entrypoint: ["/worker"]`,
  "src/main/kotlin/Worker.kt": `entrypoint: ["java", "-cp", "app.jar", "Worker"]`,
};

// docker compose runs the queue consumer next to the api: same image, env and dependencies, no ports.
function addComposeWorker(files: GeneratedFile[]): void {
  const compose = files.find((f) => f.path === "docker-compose.yml");
  const start = files.map((f) => WORKER_ENTRY[f.path]).find(Boolean);
  if (!compose || !start) return;
  const api = compose.content.match(/^  api:\n[\s\S]*?^    restart: unless-stopped$/m);
  if (!api) throw new Error("docker-compose.yml: api service not found"); // fail loudly, never ship a half-wired compose
  const worker = api[0]
    .replace(/^  api:$/m, "  worker:")
    .replace(/^    ports:\n(?:^      - .*\n)+/m, "")
    .replace(/^    build: \.$/m, `    build: .\n    ${start}`);
  compose.content = compose.content.replace(api[0], `${api[0]}\n\n${worker}`);
}

export type { GeneratedFile } from "./types";

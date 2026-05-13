import { commonFiles } from "./common";
import { goFiles } from "./go";
import { typescriptFiles } from "./typescript";
import { pythonFiles } from "./python";
import { rustFiles } from "./rust";
import { javaFiles } from "./java";
import { kotlinFiles } from "./kotlin";
import { generateProto } from "./grpc/proto";
import { bufFiles } from "./grpc/buf";
import { migrationFiles } from "./db/migrations";
import { clientSdkFiles } from "./client-sdk";
import { contractTestFiles } from "./contract-tests";
import { isGrpcSupported } from "./types";
import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { safeName } from "./types";
import type { GitConfig } from "../git-config";

export { isGrpcSupported } from "./types";

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

  // Stable sort for deterministic zip contents
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export type { GeneratedFile } from "./types";

import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toCamel, toKebab } from "../types";

/**
 * Emits a TypeScript gRPC server using @grpc/grpc-js + @grpc/proto-loader.
 *
 * We pick the *dynamic* proto-loader route (vs. static codegen via ts-proto
 * or Connect-ES) because it gives users a working server immediately after
 * `npm install` — no `buf generate` step required. Callers that want
 * compile-time types can layer static codegen on top later.
 */
export function tsGrpcFiles(
  config: StackConfig,
  entities: Entity[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const pkg = name.replace(/-/g, "_") + ".v1";

  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: tsGrpcPkgJson(name, entities.length > 0, config.database) });
  files.push({ path: "tsconfig.json", content: tsGrpcTsconfig() });
  files.push({ path: "Dockerfile", content: tsGrpcDockerfile() });
  files.push({ path: "src/main.ts", content: tsGrpcMain(pkg, entities) });
  files.push({ path: "src/proto-loader.ts", content: tsGrpcProtoLoader(pkg) });

  for (const entity of entities) {
    files.push({
      path: `src/services/${toKebab(entity.name)}.service.ts`,
      content: tsGrpcEntityService(entity),
    });
  }

  return files;
}

function tsGrpcPkgJson(name: string, hasEntities: boolean, database: string): string {
  const deps: Record<string, string> = {
    "@grpc/grpc-js": "^1.12.3",
    "@grpc/proto-loader": "^0.7.13",
    "grpc-health-check": "^2.0.2",
  };
  if (hasEntities && /postgres|neon|supabase|mysql|planetscale|cockroach/.test(database)) {
    deps["@prisma/client"] = "^5.22.0";
  }

  const devDeps: Record<string, string> = {
    "@types/node": "^22.10.0",
    tsx: "^4.19.0",
    typescript: "^5.7.2",
  };
  if (deps["@prisma/client"]) devDeps["prisma"] = "^5.22.0";

  return JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "tsx watch src/main.ts",
        build: "tsc -p tsconfig.json",
        start: "node dist/main.js",
      },
      dependencies: deps,
      devDependencies: devDeps,
    },
    null,
    2
  ) + "\n";
}

function tsGrpcTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "Node16",
        moduleResolution: "Node16",
        outDir: "dist",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        declaration: false,
        sourceMap: true,
      },
      include: ["src/**/*.ts"],
    },
    null,
    2
  ) + "\n";
}

function tsGrpcDockerfile(): string {
  return `# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY proto ./proto
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/proto ./proto
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
`;
}

function tsGrpcProtoLoader(pkg: string): string {
  return `import { loadSync } from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve proto path relative to this module — works both in \`tsx\` (running
// src/) and in production (running dist/) because we copy proto/ into the
// image under /app/proto.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, "..", "proto", "${pkg.split(".")[0]}", "v1", "service.proto");

const packageDef = loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const loaded = grpc.loadPackageDefinition(packageDef) as unknown as Record<string, Record<string, Record<string, grpc.ServiceClientConstructor>>>;
const serviceMap = loaded["${pkg.split(".")[0]}"]?.["v1"] ?? {};

export function serviceDefOf(name: string): grpc.ServiceDefinition {
  const ctor = serviceMap[name];
  if (!ctor) throw new Error(\`proto: service '\${name}' not found — did you edit service.proto without restarting?\`);
  // \`service\` is the runtime ServiceDefinition attached by grpc-js.
  return (ctor as unknown as { service: grpc.ServiceDefinition }).service;
}
`;
}

function tsGrpcMain(pkg: string, entities: Entity[]): string {
  const imports = entities
    .map((e) => `import { ${toCamel(e.name)}Service } from "./services/${toKebab(e.name)}.service.js";`)
    .join("\n");

  const registrations = entities
    .map(
      (e) => `server.addService(serviceDefOf("${e.name}Service"), ${toCamel(e.name)}Service);`
    )
    .join("\n");

  return `import * as grpc from "@grpc/grpc-js";
import { HealthImplementation } from "grpc-health-check";
import { serviceDefOf } from "./proto-loader.js";
${imports}

const port = Number(process.env.PORT ?? 8080);
const server = new grpc.Server();

${registrations}

// Standard grpc.health.v1.Health — grpc-health-probe (used in the K8s probes)
// and load balancers rely on this service. Per convention, the empty service
// name "" represents the overall server health.
const health = new HealthImplementation({ "": "SERVING" });
health.addToServer(server);

server.bindAsync(\`0.0.0.0:\${port}\`, grpc.ServerCredentials.createInsecure(), (err, bound) => {
  if (err) {
    console.error("bind failed:", err);
    process.exit(1);
  }
  console.log(\`gRPC server listening on :\${bound}\`);
});

// Graceful shutdown on SIGTERM.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(\`\${signal} received — draining\`);
    health.setStatus("", "NOT_SERVING");
    server.tryShutdown((err) => {
      if (err) {
        console.error("graceful shutdown failed, forcing:", err);
        server.forceShutdown();
      }
      process.exit(0);
    });
  });
}
`;
}

function tsGrpcEntityService(entity: Entity): string {
  const name = entity.name;
  const varName = toCamel(name);
  return `import * as grpc from "@grpc/grpc-js";

// Handlers for ${name}Service. Each function accepts an untyped call because
// we load the proto dynamically — switch to ts-proto or protoc-gen-es if you
// want compile-time message types. Fill in real persistence in place of the
// UNIMPLEMENTED stubs below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = grpc.ServerUnaryCall<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Callback = grpc.sendUnaryData<any>;

function unimplemented(cb: Callback, rpc: string) {
  cb({ code: grpc.status.UNIMPLEMENTED, details: \`\${rpc} not implemented\` });
}

export const ${varName}Service = {
  list${name}(_call: Call, cb: Callback) {
    unimplemented(cb, "List${name}");
  },
  get${name}(_call: Call, cb: Callback) {
    unimplemented(cb, "Get${name}");
  },
  create${name}(_call: Call, cb: Callback) {
    unimplemented(cb, "Create${name}");
  },
  update${name}(_call: Call, cb: Callback) {
    unimplemented(cb, "Update${name}");
  },
  delete${name}(_call: Call, cb: Callback) {
    unimplemented(cb, "Delete${name}");
  },
};
`;
}

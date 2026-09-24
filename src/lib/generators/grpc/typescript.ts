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
  entities: Entity[],
  // REST-path instrumentation: main.ts preamble (tracing / APM / metrics
  // registry imports) and the npm deps it needs. Built by typescript.ts.
  obs: { preamble: string; deps: Record<string, string> } = { preamble: "", deps: {} }
): GeneratedFile[] {
  const name = safeName(config.name);
  const pkg = name.replace(/-/g, "_") + ".v1";
  const prom = /prometheus|grafana/.test(config.monitoring);

  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: tsGrpcPkgJson(name, entities.length > 0, config.database, obs.deps) });
  files.push({ path: "tsconfig.json", content: tsGrpcTsconfig() });
  files.push({ path: "Dockerfile", content: tsGrpcDockerfile() });
  // ESM (Node16 resolution) needs the .js suffix on relative imports.
  files.push({ path: "src/main.ts", content: obs.preamble.replace(`"./tracing"`, `"./tracing.js"`) + tsGrpcMain(pkg, entities, config, prom) });
  files.push({ path: "src/proto-loader.ts", content: tsGrpcProtoLoader(pkg) });
  if (config.rateLimit || config.audit || prom) {
    files.push({ path: "src/interceptors.ts", content: tsGrpcInterceptors(config, prom) });
  }

  for (const entity of entities) {
    files.push({
      path: `src/services/${toKebab(entity.name)}.service.ts`,
      content: tsGrpcEntityService(entity),
    });
  }

  return files;
}

function tsGrpcPkgJson(name: string, hasEntities: boolean, database: string, extraDeps: Record<string, string>): string {
  const deps: Record<string, string> = {
    "@grpc/grpc-js": "^1.12.3",
    "@grpc/proto-loader": "^0.7.13",
    "grpc-health-check": "^2.0.2",
    ...extraDeps,
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

function tsGrpcMain(pkg: string, entities: Entity[], config: StackConfig, prom: boolean): string {
  const intercepted = config.rateLimit || config.audit || prom;
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
${prom ? `import http from "node:http";\n` : ""}import { serviceDefOf } from "./proto-loader.js";
${intercepted ? `import { interceptors } from "./interceptors.js";\n` : ""}${imports}

const port = Number(process.env.PORT ?? 8080);
const server = new grpc.Server(${intercepted ? "{ interceptors }" : ""});

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
${prom ? `
// Prometheus scrapes this plain-HTTP listener; the gRPC port only speaks HTTP/2.
const metricsServer = http
  .createServer(async (req, res) => {
    if (req.url !== "/metrics") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", register.contentType);
    res.end(await register.metrics());
  })
  .listen(Number(process.env.METRICS_PORT ?? 9464));
` : ""}
// Graceful shutdown on SIGTERM.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(\`\${signal} received — draining\`);
    health.setStatus("", "NOT_SERVING");
${prom ? "    metricsServer.close();\n" : ""}    server.tryShutdown((err) => {
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

// Server interceptors for the cross-cutting flags (grpc-js >= 1.10).
function tsGrpcInterceptors(config: StackConfig, prom: boolean): string {
  const blocks: string[] = [];
  const names: string[] = [];
  if (prom) {
    names.push("metrics");
    blocks.push(`const rpcs = new Counter({
  name: "grpc_server_handled_total",
  help: "RPCs completed on the server, by method and status code.",
  labelNames: ["grpc_method", "grpc_code"],
});
const rpcSeconds = new Histogram({
  name: "grpc_server_handling_seconds",
  help: "RPC latency on the server, by method.",
  labelNames: ["grpc_method"],
});

// Per-RPC count + latency; main.ts serves them on METRICS_PORT.
const metrics: grpc.ServerInterceptor = (method, call) => {
  const end = rpcSeconds.startTimer({ grpc_method: method.path });
  return new grpc.ServerInterceptingCall(call, {
    sendStatus: (status, next) => {
      end();
      rpcs.inc({ grpc_method: method.path, grpc_code: grpc.status[status.code] });
      next(status);
    },
  });
};`);
  }
  if (config.rateLimit) {
    names.push("rateLimit");
    blocks.push(`// ponytail: in-memory fixed window (60 RPCs / min / client), per replica. Move
// the counter to Redis if limits must hold across replicas.
const buckets = new Map<string, { count: number; resetAt: number }>();

const rateLimit: grpc.ServerInterceptor = (_method, call) =>
  new grpc.ServerInterceptingCall(call, {
    start: (next) => {
      next({
        onReceiveMetadata: (metadata, mdNext) => {
          const key = peerOf(call);
          const now = Date.now();
          const b = buckets.get(key);
          if (!b || b.resetAt < now) buckets.set(key, { count: 1, resetAt: now + 60_000 });
          else if (b.count >= 60) return call.sendStatus({ code: grpc.status.RESOURCE_EXHAUSTED, details: "rate_limited" });
          else b.count++;
          mdNext(metadata);
        },
      });
    },
  });`);
  }
  if (config.audit) {
    names.push("audit");
    blocks.push(`// One structured log line per RPC.
const audit: grpc.ServerInterceptor = (method, call) =>
  new grpc.ServerInterceptingCall(call, {
    sendStatus: (status, next) => {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          event: "audit",
          method: method.path,
          code: grpc.status[status.code],
          peer: peerOf(call),
          time: new Date().toISOString(),
        }) + "\\n"
      );
      next(status);
    },
  });`);
  }
  const peer = config.rateLimit || config.audit
    ? `\n// Client address without the port ("ipv4:10.0.0.1:5123" -> "ipv4:10.0.0.1").
const peerOf = (call: grpc.ServerInterceptingCallInterface) => call.getPeer().replace(/:\\d+$/, "");\n`
    : "";
  return `import * as grpc from "@grpc/grpc-js";
${prom ? `import { Counter, Histogram } from "prom-client";\n` : ""}${peer}
${blocks.join("\n\n")}

// Same order as the REST middleware chain.
export const interceptors: grpc.ServerInterceptor[] = [${names.join(", ")}];
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

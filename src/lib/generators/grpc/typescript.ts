import type { Endpoint, Entity, EntityField, GeneratedFile, StackConfig } from "../types";
import { safeName, toCamel, toKebab } from "../types";
import { tsAuthMode, usesPrisma } from "../patterns/typescript";
import { tsTokenVerifier } from "../typescript";
import { creatableFields, pkOf, protectedRpcs, protoJsonName, serverTimestamps } from "./proto";

/**
 * Emits a TypeScript gRPC server using @grpc/grpc-js + @grpc/proto-loader.
 *
 * We pick the *dynamic* proto-loader route (vs. static codegen via ts-proto
 * or Connect-ES) because it gives users a working server immediately after
 * `npm install` — no `buf generate` step required. Callers that want
 * compile-time types can layer static codegen on top later.
 *
 * Entity RPCs use the same data layer as the REST repositories: the Prisma
 * client (prisma/schema.prisma), or an in-memory table when the database has
 * no Prisma support. Auth uses the REST token verifier.
 */
export function tsGrpcFiles(
  config: StackConfig,
  entities: Entity[],
  // REST-path instrumentation: main.ts preamble (tracing / APM / metrics
  // registry imports) and the npm deps it needs. Built by typescript.ts.
  obs: { preamble: string; deps: Record<string, string> } = { preamble: "", deps: {} },
  endpoints: Endpoint[] = []
): GeneratedFile[] {
  const name = safeName(config.name);
  const pkg = name.replace(/-/g, "_") + ".v1";
  const prom = /prometheus|grafana/.test(config.monitoring);
  const prisma = usesPrisma(config, entities);
  const mode = tsAuthMode(config, endpoints);
  // Full method paths ("/pkg.v1.UserService/GetUser") the auth interceptor guards.
  const guarded = mode === "off" ? []
    : entities.flatMap((e) => protectedRpcs(e, endpoints).map((rpc) => `/${pkg}.${e.name}Service/${rpc}`));

  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: tsGrpcPkgJson(name, prisma, guarded.length > 0, obs.deps) });
  files.push({ path: "tsconfig.json", content: tsGrpcTsconfig() });
  files.push({ path: "Dockerfile", content: tsGrpcDockerfile(prisma) });
  // ESM (Node16 resolution) needs the .js suffix on relative imports.
  files.push({ path: "src/main.ts", content: obs.preamble.replace(`"./tracing"`, `"./tracing.js"`) + tsGrpcMain(pkg, entities, config, prom, guarded.length > 0) });
  files.push({ path: "src/proto-loader.ts", content: tsGrpcProtoLoader(pkg) });
  if (config.rateLimit || config.audit || prom || guarded.length > 0) {
    files.push({ path: "src/interceptors.ts", content: tsGrpcInterceptors(config, prom, guarded) });
  }
  if (guarded.length > 0) {
    files.push({ path: "src/auth.ts", content: `${tsTokenVerifier(mode)}\nexport { unconfigured, verify };\n` });
  }

  if (entities.length > 0) {
    files.push({ path: "src/db.ts", content: prisma ? TS_PRISMA_DB : tsMemoryDb(config.database, entities) });
    files.push({ path: "src/services/grpc-util.ts", content: TS_GRPC_UTIL });
  }
  for (const entity of entities) {
    files.push({
      path: `src/services/${toKebab(entity.name)}.service.ts`,
      content: tsGrpcEntityService(entity),
    });
  }

  return files;
}

function tsGrpcPkgJson(name: string, prisma: boolean, withAuth: boolean, extraDeps: Record<string, string>): string {
  const deps: Record<string, string> = {
    "@grpc/grpc-js": "^1.12.3",
    "@grpc/proto-loader": "^0.7.13",
    "grpc-health-check": "^2.0.2",
    ...extraDeps,
  };
  // The prisma CLI runs at container start (see tsGrpcDockerfile), so it is a runtime dependency.
  if (prisma) Object.assign(deps, { "@prisma/client": "^5.22.0", prisma: "^5.22.0" });
  if (withAuth) deps["jose"] = "^5.9.6";

  const devDeps: Record<string, string> = {
    "@types/node": "^22.10.0",
    tsx: "^4.19.0",
    typescript: "^5.7.2",
  };

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

// Same shape as the REST image (tsDockerfile): the Prisma client is generated in the
// build stage; the api creates / updates the tables at start (the worker overrides CMD).
function tsGrpcDockerfile(prisma: boolean): string {
  const runtime = prisma
    ? `COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 8080
# Creates / updates tables to match prisma/schema.prisma, then starts the api. Idempotent,
# and it refuses changes that would drop data. For reviewed migrations use prisma migrate deploy.
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && exec node dist/main.js"]`
    : `USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]`;
  return `# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
${prisma ? "# Prisma's query engine needs OpenSSL; Alpine ships without it.\nRUN apk add --no-cache openssl\n" : ""}WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
# The generated repo ships no lockfile; npm ci needs one.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY src ./src
COPY proto ./proto
${prisma ? "COPY prisma ./prisma\nRUN npx prisma generate\n" : ""}RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
${prisma ? "RUN apk add --no-cache openssl\n" : ""}WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/proto ./proto
${runtime}
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

function tsGrpcMain(pkg: string, entities: Entity[], config: StackConfig, prom: boolean, withAuth: boolean): string {
  const intercepted = config.rateLimit || config.audit || prom || withAuth;
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

// Server interceptors for the cross-cutting flags (grpc-js >= 1.10). grpc-js
// runs these for every call kind (unary, client/server/bidi streaming), so
// user-added streaming methods are covered without per-handler wrapping.
function tsGrpcInterceptors(config: StackConfig, prom: boolean, guarded: string[]): string {
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
  if (guarded.length > 0) {
    names.push("auth");
    blocks.push(`// Entity RPCs whose REST routes require auth, checked with the same token
// verifier as the REST middleware. Innermost, like the REST route guard.
const protectedRpcs = new Set([
${guarded.map((m) => `  "${m}",`).join("\n")}
]);

const auth: grpc.ServerInterceptor = (method, call) =>
  new grpc.ServerInterceptingCall(call, {
    start: (next) => {
      next({
        onReceiveMetadata: (metadata, mdNext) => {
          if (!protectedRpcs.has(method.path)) return mdNext(metadata);
          if (unconfigured) return call.sendStatus({ code: grpc.status.INTERNAL, details: "auth_unconfigured" });
          const header = String(metadata.get("authorization")[0] ?? "");
          if (!header.startsWith("Bearer ")) {
            return call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: "missing_or_malformed_token" });
          }
          verify(header.slice("Bearer ".length).trim()).then(
            () => mdNext(metadata),
            () => call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: "invalid_token" })
          );
        },
      });
    },
  });`);
  }
  return `import * as grpc from "@grpc/grpc-js";
${prom ? `import { Counter, Histogram } from "prom-client";\n` : ""}${guarded.length > 0 ? `import { unconfigured, verify } from "./auth.js";\n` : ""}${peer}
${blocks.join("\n\n")}

// Same order as the REST middleware chain.
export const interceptors: grpc.ServerInterceptor[] = [${names.join(", ")}];
`;
}

const TS_PRISMA_DB = `import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
`;

// No Prisma support for this database: in-memory tables, like the REST
// repositories, exposing the slice of the Prisma client API the services use.
function tsMemoryDb(database: string, entities: Entity[]): string {
  return `/* eslint-disable @typescript-eslint/no-explicit-any -- rows mirror untyped proto messages */
import { randomUUID } from "node:crypto";

// ponytail: in-memory tables — no ${database || "database"} client is generated (same as
// the REST repositories), so data is lost on restart and not shared across
// replicas. Unique constraints are not enforced.
function table(pk: string) {
  const rows = new Map<string, any>();
  const notFound = () => Object.assign(new Error("not found"), { code: "P2025" });
  const get = (where: any) => rows.get(String(where[pk]));
  return {
    async findMany({ skip, take }: { skip: number; take: number; orderBy?: unknown }) {
      return [...rows.values()].slice(skip, skip + take);
    },
    async count() {
      return rows.size;
    },
    async findUnique({ where }: { where: any }) {
      return get(where) ?? null;
    },
    async create({ data }: { data: any }) {
      const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
      row[pk] ??= randomUUID();
      rows.set(String(row[pk]), row);
      return row;
    },
    async update({ where, data }: { where: any; data: any }) {
      const row = get(where);
      if (!row) throw notFound();
      return Object.assign(row, { updatedAt: new Date() }, data);
    },
    async delete({ where }: { where: any }) {
      const row = get(where);
      if (!row) throw notFound();
      rows.delete(String(where[pk]));
      return row;
    },
  };
}

export const prisma = {
${entities.map((e) => `  ${toCamel(e.name)}: table("${pkOf(e).name}"),`).join("\n")}
};
`;
}

const TS_GRPC_UTIL = `import * as grpc from "@grpc/grpc-js";

export type Timestamp = { seconds: string | number; nanos: number };

class RpcError extends Error {
  constructor(readonly code: grpc.status, message: string) {
    super(message);
  }
}

export const invalid = (message: string) => new RpcError(grpc.status.INVALID_ARGUMENT, message);

// Throws INVALID_ARGUMENT naming the first required field that is unset.
export function required(data: Record<string, unknown>, fields: string[]) {
  const missing = fields.find((f) => data[f] == null || data[f] === "");
  if (missing) throw invalid(\`\${missing} is required\`);
}

// List defaults: page 1, 20 items, at most 100 per page.
export function pageOf(req: { page?: number; pageSize?: number }) {
  const page = req.page || 1;
  const pageSize = Math.min(req.pageSize || 20, 100);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function toTs(d: Date | null | undefined): Timestamp | null {
  if (!d) return null;
  const ms = d.getTime();
  return { seconds: Math.floor(ms / 1000), nanos: (((ms % 1000) + 1000) % 1000) * 1e6 };
}

export const fromTs = (t: Timestamp | null | undefined): Date | null =>
  t ? new Date(Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6)) : null;

// JSON fields travel as bytes; empty means unset.
export function parseJson(b: Buffer | undefined, field: string): unknown {
  if (!b?.length) return undefined;
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    throw invalid(\`\${field} must be valid JSON\`);
  }
}

export const jsonBytes = (v: unknown) => (v == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(v)));

// Maps a thrown error to a gRPC status: validation errors, Prisma P2025
// (record not found) and P2002 (unique constraint); anything else is INTERNAL.
export function fail(cb: grpc.sendUnaryData<unknown>, err: unknown) {
  if (err instanceof RpcError) return cb({ code: err.code, details: err.message });
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2025") return cb({ code: grpc.status.NOT_FOUND, details: "not found" });
  if (code === "P2002") return cb({ code: grpc.status.ALREADY_EXISTS, details: "already exists" });
  console.error(err);
  cb({ code: grpc.status.INTERNAL, details: "internal error" });
}
`;

const isTextField = (f: EntityField) => f.type === "string" || f.type === "text" || f.type === "uuid";

function tsGrpcEntityService(entity: Entity): string {
  const name = entity.name;
  const model = toCamel(name);
  const pk = pkOf(entity);
  const pkReq = `req.${protoJsonName(pk)}`;
  const toProto = [...entity.fields, ...serverTimestamps(entity)].map((f) => {
    const v = `row.${f.name}`;
    const val = isTextField(f) ? `${v} ?? ""` : f.type === "number" ? `${v} ?? 0` : f.type === "boolean" ? `${v} ?? false`
      : f.type === "date" ? `toTs(${v})` : `jsonBytes(${v})`;
    return `    ${protoJsonName(f)}: ${val},`;
  }).join("\n");
  // Request → Prisma data. Unset optional text / dates are null, unset JSON is
  // left out (Prisma needs Prisma.DbNull, not null, for Json columns).
  const data = (fields: EntityField[]) => fields.map((f) => {
    const r = `req.${protoJsonName(f)}`;
    if (f === pk && f.type === "number") return `    ...(${r} ? { ${f.name}: Math.trunc(${r}) } : {}),`;
    const val = isTextField(f) ? `${r} || null` : f.type === "number" ? `Math.trunc(${r} ?? 0)` : f.type === "boolean" ? `Boolean(${r})`
      : f.type === "date" ? `fromTs(${r})` : `parseJson(${r}, "${protoJsonName(f)}")`;
    return `    ${f.name}: ${val},`;
  }).join("\n");
  const requiredOf = (fields: EntityField[]) =>
    `[${fields.filter((f) => f.required && f.type !== "number" && f.type !== "boolean").map((f) => `"${f.name}"`).join(", ")}]`;
  const createFields = creatableFields(entity);
  const updateFields = entity.fields.filter((f) => f !== pk);
  const usesJson = entity.fields.some((f) => f.type === "json");
  const usesDate = [...entity.fields, ...serverTimestamps(entity)].some((f) => f.type === "date");
  const utils = ["fail", "invalid", "pageOf", "required", ...(usesDate ? ["fromTs", "toTs"] : []), ...(usesJson ? ["jsonBytes", "parseJson"] : [])].sort();
  return `/* eslint-disable @typescript-eslint/no-explicit-any -- proto-loader messages are untyped */
import * as grpc from "@grpc/grpc-js";
import { prisma } from "../db.js";
import { ${utils.join(", ")} } from "./grpc-util.js";

// ${name}Service handlers on the same Prisma models as the REST repositories.
// Messages are untyped because the proto is loaded dynamically — switch to
// ts-proto or protoc-gen-es for compile-time message types.
type Call = grpc.ServerUnaryCall<any, any>;
type Callback = grpc.sendUnaryData<any>;

// Primary-key lookup; an empty key is INVALID_ARGUMENT.
function key(req: any) {
  if (!${pkReq}) throw invalid("${protoJsonName(pk)} is required");
  return { ${pk.name}: ${pk.type === "number" ? `Math.trunc(${pkReq})` : `String(${pkReq})`} };
}

function toProto(row: any) {
  return {
${toProto}
  };
}

function createData(req: any): any {
  const data = {
${data(createFields)}
  };
  required(data, ${requiredOf(createFields)});
  return data;
}

// Update${name} replaces every field (the proto has no field mask).
function updateData(req: any): any {
  const data = {
${data(updateFields)}
  };
  required(data, ${requiredOf(updateFields)});
  return data;
}

export const ${model}Service = {
  async list${name}(call: Call, cb: Callback) {
    try {
      const { page, pageSize, skip } = pageOf(call.request);
      const [rows, total] = await Promise.all([
        prisma.${model}.findMany({ skip, take: pageSize, orderBy: { ${pk.name}: "asc" } }),
        prisma.${model}.count(),
      ]);
      cb(null, { items: rows.map(toProto), total, page, pageSize });
    } catch (err) {
      fail(cb, err);
    }
  },
  async get${name}(call: Call, cb: Callback) {
    try {
      const row = await prisma.${model}.findUnique({ where: key(call.request) });
      if (!row) return cb({ code: grpc.status.NOT_FOUND, details: "not found" });
      cb(null, toProto(row));
    } catch (err) {
      fail(cb, err);
    }
  },
  async create${name}(call: Call, cb: Callback) {
    try {
      cb(null, toProto(await prisma.${model}.create({ data: createData(call.request) })));
    } catch (err) {
      fail(cb, err);
    }
  },
  async update${name}(call: Call, cb: Callback) {
    try {
      const where = key(call.request);
      cb(null, toProto(await prisma.${model}.update({ where, data: updateData(call.request) })));
    } catch (err) {
      fail(cb, err);
    }
  },
  async delete${name}(call: Call, cb: Callback) {
    try {
      await prisma.${model}.delete({ where: key(call.request) });
      cb(null, {});
    } catch (err) {
      fail(cb, err);
    }
  },
};
`;
}

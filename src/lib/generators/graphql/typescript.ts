import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toCamel, toKebab } from "../types";
import { primaryKey, pluralize } from "./schema";

/**
 * Emits a TypeScript GraphQL server using graphql-yoga. Yoga ships with
 * GraphiQL (easier first-run debugging than Apollo) and works as a plain
 * HTTP handler so we can mount it inside any of the four supported TS
 * frameworks without bringing in framework-specific GraphQL middleware.
 *
 * The generated server reads SDL at startup from `graphql/schema.graphql`
 * (emitted by `generateGraphqlSchema`) and binds in-memory resolvers per
 * entity. CRUD logic uses an in-memory Map keyed by primary key — same
 * trade-off as the gRPC TS generator, which keeps the server runnable on
 * `npm install && npm run dev` with no DB attached.
 */
export function tsGraphqlFiles(
  config: StackConfig,
  entities: Entity[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: tsGraphqlPkgJson(name, config.framework) });
  files.push({ path: "tsconfig.json", content: tsGraphqlTsconfig() });
  files.push({ path: "Dockerfile", content: tsGraphqlDockerfile() });
  files.push({ path: "src/main.ts", content: tsGraphqlMain(config.framework) });
  files.push({ path: "src/schema.ts", content: tsGraphqlSchema() });
  files.push({ path: "src/resolvers.ts", content: tsGraphqlResolvers(entities) });
  files.push({ path: "src/scalars.ts", content: tsGraphqlScalars() });

  for (const entity of entities) {
    files.push({
      path: `src/resolvers/${toKebab(entity.name)}.ts`,
      content: tsGraphqlEntityResolver(entity),
    });
  }

  return files;
}

function tsGraphqlPkgJson(name: string, framework: string): string {
  const deps: Record<string, string> = {
    "graphql-yoga": "^5.10.4",
    graphql: "^16.10.0",
    "graphql-scalars": "^1.24.0",
  };
  // Express stays the default mount target. Other frameworks get a yoga
  // adapter at the route level (see tsGraphqlMain).
  if (framework === "express" || framework === "nestjs") {
    deps.express = "^4.21.2";
  } else if (framework === "fastify") {
    deps.fastify = "^5.2.0";
  } else if (framework === "hono") {
    deps.hono = "^4.6.14";
    deps["@hono/node-server"] = "^1.13.7";
  }

  const devDeps: Record<string, string> = {
    "@types/node": "^22.10.0",
    tsx: "^4.19.0",
    typescript: "^5.7.2",
  };
  if (framework === "express" || framework === "nestjs") {
    devDeps["@types/express"] = "^5.0.0";
  }

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
        typecheck: "tsc --noEmit",
      },
      dependencies: deps,
      devDependencies: devDeps,
    },
    null,
    2
  );
}

function tsGraphqlTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        outDir: "dist",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ["src/**/*"],
    },
    null,
    2
  );
}

function tsGraphqlDockerfile(): string {
  return `# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/graphql ./graphql
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 4000
CMD ["node", "dist/main.js"]
`;
}

function tsGraphqlSchema(): string {
  return `import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// SDL is committed to the repo so the same schema drives the server, IDE
// tooling, and any client codegen. Loaded synchronously at startup — Yoga
// will throw with a clear error if the file is missing.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "graphql", "schema.graphql");

export const typeDefs = readFileSync(schemaPath, "utf-8");
`;
}

function tsGraphqlScalars(): string {
  return `import { GraphQLScalarType, Kind } from "graphql";

// Lightweight DateTime scalar — accepts ISO strings + Date objects, serializes
// to ISO. Avoids pulling in graphql-scalars at runtime for a single field.
export const DateTime = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 date-time string",
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return new Date(value).toISOString();
    throw new TypeError("DateTime must be Date or ISO string");
  },
  parseValue(value) {
    if (typeof value !== "string") throw new TypeError("DateTime literal must be string");
    return new Date(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new TypeError("DateTime must be string literal");
    return new Date(ast.value);
  },
});

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral(ast) {
    return parseLiteralValue(ast);
  },
});

function parseLiteralValue(ast: any): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((f: any) => [f.name.value, parseLiteralValue(f.value)]));
    case Kind.LIST:
      return ast.values.map(parseLiteralValue);
    case Kind.NULL:
      return null;
    default:
      return null;
  }
}
`;
}

function tsGraphqlResolvers(entities: Entity[]): string {
  const imports = entities
    .map((e) => `import { ${toCamel(e.name)}Resolvers } from "./resolvers/${toKebab(e.name)}.js";`)
    .join("\n");

  const queryEntries = entities
    .flatMap((e) => [
      `    list${pluralize(e.name)}: ${toCamel(e.name)}Resolvers.list,`,
      `    get${e.name}: ${toCamel(e.name)}Resolvers.get,`,
    ])
    .join("\n");

  const mutationEntries =
    entities.length > 0
      ? entities
          .flatMap((e) => [
            `    create${e.name}: ${toCamel(e.name)}Resolvers.create,`,
            `    update${e.name}: ${toCamel(e.name)}Resolvers.update,`,
            `    delete${e.name}: ${toCamel(e.name)}Resolvers.remove,`,
          ])
          .join("\n")
      : "";

  return `${imports}
import { DateTime, JSONScalar } from "./scalars.js";

// Top-level resolver map. Per-entity resolvers live in src/resolvers/<entity>.ts
// to keep this file as a thin index — easier to grep when an operation breaks.
export const resolvers = {
  DateTime,
  JSON: JSONScalar,
  Query: {
    health: () => "ok",
${queryEntries}
  },${
    mutationEntries
      ? `
  Mutation: {
${mutationEntries}
  },`
      : ""
  }
};
`;
}

function tsGraphqlEntityResolver(entity: Entity): string {
  const name = entity.name;
  const camel = toCamel(name);
  const pk = primaryKey(entity);

  return `// In-memory CRUD for ${name}. Replace with a real DB call (Prisma, Drizzle,
// raw pg, etc.) when you wire up persistence — the resolver signatures stay
// the same so the GraphQL schema does not change.

type ${name} = {
${entity.fields.map((f) => `  ${f.name}: ${tsFieldType(f.type)};`).join("\n")}
};

const store = new Map<string, ${name}>();

export const ${camel}Resolvers = {
  list: (_: unknown, args: { page?: number; pageSize?: number }) => {
    const page = Math.max(1, args.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, args.pageSize ?? 20));
    const all = Array.from(store.values());
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize),
      total: all.length,
      page,
      pageSize,
    };
  },
  get: (_: unknown, args: { ${pk.name}: string }) => store.get(String(args.${pk.name})) ?? null,
  create: (_: unknown, args: { input: ${name} }) => {
    const id = String(args.input.${pk.name} ?? crypto.randomUUID());
    const row = { ...args.input, ${pk.name}: id } as ${name};
    store.set(id, row);
    return row;
  },
  update: (_: unknown, args: { input: ${name} }) => {
    const id = String(args.input.${pk.name});
    const existing = store.get(id);
    if (!existing) throw new Error(\`${name} \${id} not found\`);
    const next = { ...existing, ...args.input };
    store.set(id, next);
    return next;
  },
  remove: (_: unknown, args: { ${pk.name}: string }) => {
    return store.delete(String(args.${pk.name}));
  },
};
`;
}

function tsFieldType(t: string): string {
  switch (t) {
    case "string":
    case "text":
    case "uuid":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "Date | string";
    case "json":
      return "unknown";
    default:
      return "unknown";
  }
}

function tsGraphqlMain(framework: string): string {
  // graphql-yoga's createYoga returns a plain fetch handler. We mount it on
  // whichever framework the user picked — the framework's existing graceful
  // shutdown / logging stays the source of truth, GraphQL is just a route.
  const port = "Number(process.env.PORT ?? 4000)";

  if (framework === "fastify") {
    return `import Fastify from "fastify";
import { createYoga } from "graphql-yoga";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";

const yoga = createYoga({ schema: { typeDefs, resolvers } });
const app = Fastify({ logger: true });

app.route({
  method: ["GET", "POST", "OPTIONS"],
  url: "/graphql",
  handler: async (req, reply) => {
    const response = await yoga.handle(
      new Request(\`http://localhost\${req.url}\`, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: req.method === "GET" ? undefined : JSON.stringify(req.body),
      })
    );
    reply.status(response.status);
    response.headers.forEach((v, k) => reply.header(k, v));
    reply.send(await response.text());
  },
});

app.get("/health", () => ({ status: "ok" }));

const port = ${port};
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(\`GraphQL ready at http://localhost:\${port}/graphql\`);
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
  }

  if (framework === "hono") {
    return `import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createYoga } from "graphql-yoga";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";

const yoga = createYoga({ schema: { typeDefs, resolvers } });
const app = new Hono();

app.all("/graphql", async (c) => {
  const res = await yoga.handle(c.req.raw);
  return res;
});

app.get("/health", (c) => c.json({ status: "ok" }));

const port = ${port};
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
console.log(\`GraphQL ready at http://localhost:\${port}/graphql\`);

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
  }

  // Default: Express. NestJS users get the same standalone Express bootstrap —
  // mounting Yoga inside a NestJS module requires @nestjs/graphql which has a
  // very different surface; the plain Express handler is more honest.
  return `import express from "express";
import { createYoga } from "graphql-yoga";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";

const app = express();
const yoga = createYoga({ schema: { typeDefs, resolvers } });

app.use("/graphql", yoga);
app.get("/health", (_req, res) => res.json({ status: "ok" }));

const port = ${port};
const server = app.listen(port, () => {
  console.log(\`GraphQL ready at http://localhost:\${port}/graphql\`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
`;
}

import type { Entity, GeneratedFile, StackConfig } from "../types";
import { toCamel, toKebab } from "../types";
import { primaryKey, pluralize } from "./schema";

/**
 * Emits a TypeScript GraphQL server using graphql-yoga. Yoga ships with
 * GraphiQL (easier first-run debugging than Apollo) and works as a plain
 * HTTP handler, so it is mounted as one more route on the REST server the
 * caller built with no routes of its own (`rest`). That keeps the REST
 * middleware — rate limit, audit, tracing, Sentry/Datadog, /metrics — in
 * front of /graphql without re-implementing any of it here.
 *
 * The generated server reads SDL at startup from `graphql/schema.graphql`
 * (emitted by `generateGraphqlSchema`) and binds in-memory resolvers per
 * entity. CRUD logic uses an in-memory Map keyed by primary key — same
 * trade-off as the gRPC TS generator, which keeps the server runnable on
 * `npm install && npm run dev` with no DB attached.
 */
export function tsGraphqlFiles(
  config: StackConfig,
  entities: Entity[],
  rest: GeneratedFile[]
): GeneratedFile[] {
  const files = mountOnTsRest(rest, {
    imports: `import { createSchema, createYoga } from "graphql-yoga";\nimport { typeDefs } from "./schema";\nimport { resolvers } from "./resolvers";`,
    mount: tsGraphqlMount(config.framework),
    deps: { "graphql-yoga": "^5.10.4", graphql: "^16.10.0" },
  }).map((f) =>
    // The SDL is read at runtime, so the image needs graphql/ next to dist/.
    f.path === "Dockerfile"
      ? { ...f, content: f.content.replace("COPY --from=build /app/dist ./dist\n", "COPY --from=build /app/dist ./dist\nCOPY --from=build /app/graphql ./graphql\n") }
      : f
  );

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

/**
 * Adds a route to the REST tree's src/main.ts (right before /health, i.e.
 * after every app-wide middleware) and merges runtime deps into package.json.
 * Shared by the GraphQL and tRPC generators.
 */
export function mountOnTsRest(
  rest: GeneratedFile[],
  o: { imports: string; mount: string; deps: Record<string, string>; anchor?: RegExp }
): GeneratedFile[] {
  return rest.map((f) => {
    if (f.path === "src/main.ts") {
      // NestJS main.ts has no /health route (it lives in a controller), so callers pass their own anchor.
      const health = o.anchor ?? /^( *)app\.get\("\/health"/m;
      const fwImport = /^import .* from "(express|fastify|hono|@nestjs\/core)";$/m;
      if (!health.test(f.content) || !fwImport.test(f.content)) {
        throw new Error("mountOnTsRest: REST main.ts has no /health route or framework import to anchor on");
      }
      const content = f.content
        .replace(fwImport, (m) => `${m}\n${o.imports}`)
        .replace(health, (m, indent: string) => `${o.mount.split("\n").map((l) => (l ? indent + l : l)).join("\n")}\n${m}`);
      return { ...f, content };
    }
    if (f.path === "package.json") {
      const pkg = JSON.parse(f.content);
      pkg.dependencies = { ...pkg.dependencies, ...o.deps };
      return { ...f, content: JSON.stringify(pkg, null, 2) + "\n" };
    }
    return f;
  });
}

function tsGraphqlSchema(): string {
  return `import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// SDL is committed to the repo so the same schema drives the server, IDE
// tooling, and any client codegen. Loaded synchronously at startup — Yoga
// will throw with a clear error if the file is missing. Resolved from the
// compiled file (dist/ or src/), so graphql/ must sit next to it.
const schemaPath = resolve(__dirname, "..", "graphql", "schema.graphql");

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
    .map((e) => `import { ${toCamel(e.name)}Resolvers } from "./resolvers/${toKebab(e.name)}";`)
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
import { DateTime, JSONScalar } from "./scalars";

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


function tsGraphqlMount(framework: string): string {
  const yoga = `const yoga = createYoga({ schema: createSchema({ typeDefs, resolvers }) });`;
  if (framework === "fastify") {
    return `${yoga}
app.route({
  url: yoga.graphqlEndpoint,
  method: ["GET", "POST", "OPTIONS"],
  handler: async (req, reply) => {
    const response = await yoga.handleNodeRequestAndResponse(req, reply);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });
    reply.status(response.status);
    reply.send(response.body);
    return reply;
  },
});`;
  }
  if (framework === "hono") {
    return `${yoga}
app.on(["GET", "POST", "OPTIONS"], yoga.graphqlEndpoint, (c) => yoga.fetch(c.req.raw));`;
  }
  // Express (NestJS is routed to the Express base by the caller: Nest's
  // ThrottlerGuard only guards controllers, not a raw app.use mount).
  return `${yoga}
app.use(yoga.graphqlEndpoint, yoga);`;
}

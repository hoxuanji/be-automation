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
 * (emitted by `generateGraphqlSchema`) and binds resolvers per entity that
 * go through the REST data layer: src/repositories/<entity>.repository.ts
 * (Prisma, or the REST in-memory repository on MongoDB) and the zod
 * validators, both taken from `restWithEntities` — the same REST tree built
 * with the entities, whose routes/services are not used.
 */
export function tsGraphqlFiles(
  config: StackConfig,
  entities: Entity[],
  rest: GeneratedFile[],
  restWithEntities: GeneratedFile[]
): GeneratedFile[] {
  const dataLayer = restWithEntities.filter((f) => /^(prisma\/schema\.prisma|src\/(repositories|validators)\/)/.test(f.path));
  const pkgWithDb = restWithEntities.find((f) => f.path === "package.json")!;
  const base = rest.map((f) => (f.path === "package.json" ? pkgWithDb : f)).concat(dataLayer);
  const files = mountOnTsRest(base, {
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
  const kebab = toKebab(name);
  const pk = primaryKey(entity);

  return `import { GraphQLError } from "graphql";
import { ZodError } from "zod";
import * as repo from "../repositories/${kebab}.repository";
import { validate${name}Body } from "../validators/${kebab}.validator";

// CRUD for ${name} through the same repository + validator as the REST routes.

const notFound = (id: string) =>
  new GraphQLError(\`${name} \${id} not found\`, { extensions: { code: "NOT_FOUND" } });

// The REST validator checks JSON bodies: round-trip the GraphQL input through
// JSON so DateTime values become ISO strings and explicit nulls become "unset".
function validate(input: unknown) {
  try {
    return validate${name}Body(JSON.parse(JSON.stringify(input, (_k, v) => (v === null ? undefined : v))));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new GraphQLError("Invalid ${name} input", { extensions: { code: "BAD_USER_INPUT", issues: err.issues } });
    }
    throw err;
  }
}

export const ${camel}Resolvers = {
  list: (_: unknown, args: { page?: number | null; pageSize?: number | null }) =>
    repo.findMany({
      page: Math.max(1, args.page ?? 1),
      pageSize: Math.max(1, Math.min(100, args.pageSize ?? 20)),
    }),
  get: (_: unknown, args: { ${pk.name}: string }) => repo.findById(String(args.${pk.name})),
  create: (_: unknown, args: { input: unknown }) => repo.create(validate(args.input)),
  update: async (_: unknown, args: { input: { ${pk.name}: string } }) => {
    const id = String(args.input.${pk.name});
    const data = validate(args.input);
    if (!(await repo.findById(id))) throw notFound(id);
    const row = await repo.update(id, data);
    if (!row) throw new GraphQLError(\`${name} \${id} could not be updated\`);
    return row;
  },
  remove: async (_: unknown, args: { ${pk.name}: string }) => {
    const id = String(args.${pk.name});
    if (!(await repo.findById(id))) throw notFound(id);
    await repo.remove(id);
    return true;
  },
};
`;
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

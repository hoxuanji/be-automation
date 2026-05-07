import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { safeName, toPascal, toKebab, toCamel } from "./types";

export function typescriptFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  const name = safeName(config.name);
  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: pkgJson(name, config.framework, entities.length > 0, config.database) });
  files.push({ path: "tsconfig.json", content: tsconfig() });
  files.push({ path: "Dockerfile", content: tsDockerfile() });

  if (entities.length > 0) {
    files.push(...prismaFiles(config, entities));
    files.push(...entityCrudFiles(config, entities));
  }

  if (config.framework === "nestjs") {
    files.push(...nestjsFiles(config, endpoints, entities));
  } else if (config.framework === "express") {
    files.push(...expressFiles(config, endpoints, entities));
  } else if (config.framework === "fastify") {
    files.push(...fastifyFiles(config, endpoints, entities));
  } else {
    files.push(...honoFiles(config, endpoints, entities));
  }

  return files;
}

function entityCrudFiles(config: StackConfig, entities: Entity[]): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const isMongo = /mongo/.test(config.database);

  for (const entity of entities) {
    const pascal = entity.name;
    const kebab = toKebab(entity.name);
    const camel = toCamel(entity.name);
    const nonPkFields = entity.fields.filter((f) => !f.primaryKey);

    files.push({
      path: `src/validators/${kebab}.validator.ts`,
      content: validatorFile(pascal, camel, kebab, nonPkFields),
    });

    files.push({
      path: `src/repositories/${kebab}.repository.ts`,
      content: repositoryFile(pascal, camel, kebab, nonPkFields, isMongo),
    });

    files.push({
      path: `src/services/${kebab}.service.ts`,
      content: serviceFile(pascal, camel, kebab),
    });

    if (config.framework === "nestjs") {
      files.push({
        path: `src/modules/${kebab}/${kebab}.controller.ts`,
        content: nestControllerFile(pascal, camel, kebab),
      });
      files.push({
        path: `src/modules/${kebab}/${kebab}.service.ts`,
        content: nestServiceFile(pascal, camel, kebab),
      });
      files.push({
        path: `src/modules/${kebab}/${kebab}.module.ts`,
        content: nestModuleFile(pascal, kebab),
      });
    } else if (config.framework === "express") {
      files.push({
        path: `src/routes/${kebab}.router.ts`,
        content: expressRouterFile(pascal, camel, kebab),
      });
    } else if (config.framework === "fastify") {
      files.push({
        path: `src/routes/${kebab}.route.ts`,
        content: fastifyRouteFile(pascal, camel, kebab),
      });
    } else {
      files.push({
        path: `src/routes/${kebab}.route.ts`,
        content: honoRouteFile(pascal, camel, kebab),
      });
    }
  }

  return files;
}

function zodType(t: FieldType, required: boolean): string {
  const base = (() => {
    switch (t) {
      case "uuid":    return "z.string().uuid()";
      case "string":  return "z.string().min(1)";
      case "text":    return "z.string()";
      case "number":  return "z.number()";
      case "boolean": return "z.boolean()";
      case "date":    return "z.string().datetime()";
      case "json":    return "z.record(z.unknown())";
    }
  })();
  return required ? base : `${base}.optional()`;
}

function validatorFile(pascal: string, _camel: string, _kebab: string, nonPkFields: EntityField[]): string {
  const fieldLines = nonPkFields
    .map((f) => `  ${f.name}: ${zodType(f.type, f.required)},`)
    .join("\n");

  return `import { z } from "zod";

const ${pascal}Schema = z.object({
${fieldLines}
});

export type ${pascal}Input = z.infer<typeof ${pascal}Schema>;

export function validate${pascal}Body(data: unknown): ${pascal}Input {
  return ${pascal}Schema.parse(data);
}

export function validate${pascal}Query(data: unknown) {
  return z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    search: z.string().optional(),
  }).parse(data);
}
`;
}

function repositoryFile(pascal: string, _camel: string, _kebab: string, nonPkFields: EntityField[], isMongo: boolean): string {
  if (isMongo) {
    const initLines = nonPkFields.map((f) => `    ${f.name}: data.${f.name},`).join("\n");
    return `import type { ${pascal}Input } from "../validators/${toKebab(pascal)}.validator";
import { randomUUID } from "crypto";

type ${pascal}Record = ${pascal}Input & { id: string; createdAt: Date; updatedAt: Date };

const store = new Map<string, ${pascal}Record>();

export async function findMany(opts: { page?: number; pageSize?: number; search?: string }) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 20;
  const items = Array.from(store.values());
  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page, pageSize };
}

export async function findById(id: string): Promise<${pascal}Record | null> {
  return store.get(id) ?? null;
}

export async function create(data: ${pascal}Input): Promise<${pascal}Record> {
  const record: ${pascal}Record = {
    id: randomUUID(),
${initLines}
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.set(record.id, record);
  return record;
}

export async function update(id: string, data: Partial<${pascal}Input>): Promise<${pascal}Record | null> {
  const existing = store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...data, updatedAt: new Date() };
  store.set(id, updated);
  return updated;
}

export async function remove(id: string): Promise<void> {
  store.delete(id);
}
`;
  }

  return `import { PrismaClient } from "@prisma/client";
import type { ${pascal}Input } from "../validators/${toKebab(pascal)}.validator";

const prisma = new PrismaClient();

export async function findMany(opts: { page?: number; pageSize?: number; search?: string }) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const [items, total] = await Promise.all([
    prisma.${toCamel(pascal)}.findMany({ skip, take: pageSize }),
    prisma.${toCamel(pascal)}.count(),
  ]);
  return { items, total, page, pageSize };
}

export async function findById(id: string) {
  return prisma.${toCamel(pascal)}.findUnique({ where: { id } });
}

export async function create(data: ${pascal}Input) {
  return prisma.${toCamel(pascal)}.create({ data });
}

export async function update(id: string, data: Partial<${pascal}Input>) {
  return prisma.${toCamel(pascal)}.update({ where: { id }, data }).catch(() => null);
}

export async function remove(id: string): Promise<void> {
  await prisma.${toCamel(pascal)}.delete({ where: { id } }).catch(() => null);
}
`;
}

function serviceFile(pascal: string, camel: string, kebab: string): string {
  return `import * as repo from "../repositories/${kebab}.repository";
import type { ${pascal}Input } from "../validators/${kebab}.validator";

export async function list${pascal}(q: { page?: number; pageSize?: number; search?: string }) {
  return repo.findMany(q);
}

export async function get${pascal}ById(id: string) {
  return repo.findById(id);
}

export async function create${pascal}(data: ${pascal}Input) {
  return repo.create(data);
}

export async function update${pascal}(id: string, data: Partial<${pascal}Input>) {
  return repo.update(id, data);
}

export async function delete${pascal}(id: string): Promise<void> {
  return repo.remove(id);
}
`;
}

function expressRouterFile(pascal: string, camel: string, kebab: string): string {
  return `import { Router } from "express";
import { validate${pascal}Body, validate${pascal}Query } from "../validators/${kebab}.validator";
import * as service from "../services/${kebab}.service";

export function create${pascal}Router(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const q = validate${pascal}Query(req.query);
      const result = await service.list${pascal}(q);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get("/:id", async (req, res) => {
    const item = await service.get${pascal}ById(req.params.id);
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  });

  router.post("/", async (req, res) => {
    try {
      const data = validate${pascal}Body(req.body);
      const item = await service.create${pascal}(data);
      res.status(201).json(item);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const data = validate${pascal}Body(req.body);
      const item = await service.update${pascal}(req.params.id, data);
      if (!item) return res.status(404).json({ error: "not found" });
      res.json(item);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/:id", async (req, res) => {
    await service.delete${pascal}(req.params.id);
    res.status(204).end();
  });

  return router;
}
`;
}

function fastifyRouteFile(pascal: string, _camel: string, kebab: string): string {
  return `import type { FastifyInstance } from "fastify";
import { validate${pascal}Body, validate${pascal}Query } from "../validators/${kebab}.validator";
import * as service from "../services/${kebab}.service";

export async function ${toCamel(pascal)}Routes(app: FastifyInstance) {
  app.get("/", async (req, reply) => {
    const q = validate${pascal}Query(req.query);
    return service.list${pascal}(q);
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const item = await service.get${pascal}ById(req.params.id);
    if (!item) return reply.status(404).send({ error: "not found" });
    return item;
  });

  app.post("/", async (req, reply) => {
    try {
      const data = validate${pascal}Body(req.body);
      const item = await service.create${pascal}(data);
      return reply.status(201).send(item);
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
  });

  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    try {
      const data = validate${pascal}Body(req.body);
      const item = await service.update${pascal}(req.params.id, data);
      if (!item) return reply.status(404).send({ error: "not found" });
      return item;
    } catch (err) {
      return reply.status(400).send({ error: String(err) });
    }
  });

  app.delete<{ Params: { id: string } }>("/:id", async (req, reply) => {
    await service.delete${pascal}(req.params.id);
    return reply.status(204).send();
  });
}
`;
}

function honoRouteFile(pascal: string, _camel: string, kebab: string): string {
  return `import { Hono } from "hono";
import { validate${pascal}Body, validate${pascal}Query } from "../validators/${kebab}.validator";
import * as service from "../services/${kebab}.service";

export const ${toCamel(pascal)}Routes = new Hono();

${toCamel(pascal)}Routes.get("/", async (c) => {
  const q = validate${pascal}Query(c.req.query());
  return c.json(await service.list${pascal}(q));
});

${toCamel(pascal)}Routes.get("/:id", async (c) => {
  const item = await service.get${pascal}ById(c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json(item);
});

${toCamel(pascal)}Routes.post("/", async (c) => {
  try {
    const data = validate${pascal}Body(await c.req.json());
    const item = await service.create${pascal}(data);
    return c.json(item, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

${toCamel(pascal)}Routes.patch("/:id", async (c) => {
  try {
    const data = validate${pascal}Body(await c.req.json());
    const item = await service.update${pascal}(c.req.param("id"), data);
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json(item);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

${toCamel(pascal)}Routes.delete("/:id", async (c) => {
  await service.delete${pascal}(c.req.param("id"));
  return c.body(null, 204);
});
`;
}

function nestControllerFile(pascal: string, _camel: string, kebab: string): string {
  return `import { Controller, Get, Post, Patch, Delete, Param, Body, Query, HttpCode } from "@nestjs/common";
import { ${pascal}NestService } from "./${kebab}.service";
import { validate${pascal}Body, validate${pascal}Query } from "../../validators/${kebab}.validator";

@Controller("${kebab}s")
export class ${pascal}Controller {
  constructor(private readonly svc: ${pascal}NestService) {}

  @Get()
  list(@Query() q: unknown) {
    return this.svc.list(validate${pascal}Query(q));
  }

  @Get(":id")
  getById(@Param("id") id: string) {
    return this.svc.getById(id);
  }

  @Post()
  create(@Body() body: unknown) {
    return this.svc.create(validate${pascal}Body(body));
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(id, validate${pascal}Body(body));
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }
}
`;
}

function nestServiceFile(pascal: string, _camel: string, kebab: string): string {
  return `import { Injectable } from "@nestjs/common";
import * as service from "../../services/${kebab}.service";
import type { ${pascal}Input } from "../../validators/${kebab}.validator";

@Injectable()
export class ${pascal}NestService {
  list(q: Parameters<typeof service.list${pascal}>[0]) { return service.list${pascal}(q); }
  getById(id: string) { return service.get${pascal}ById(id); }
  create(data: ${pascal}Input) { return service.create${pascal}(data); }
  update(id: string, data: Partial<${pascal}Input>) { return service.update${pascal}(id, data); }
  remove(id: string) { return service.delete${pascal}(id); }
}
`;
}

function nestModuleFile(pascal: string, kebab: string): string {
  return `import { Module } from "@nestjs/common";
import { ${pascal}Controller } from "./${kebab}.controller";
import { ${pascal}NestService } from "./${kebab}.service";

@Module({
  controllers: [${pascal}Controller],
  providers: [${pascal}NestService],
})
export class ${pascal}Module {}
`;
}

function prismaFiles(config: StackConfig, entities: Entity[]): GeneratedFile[] {
  const provider = /mongo/.test(config.database)
    ? "mongodb"
    : config.database === "mysql"
    ? "mysql"
    : config.database === "sqlite"
    ? "sqlite"
    : "postgresql";

  const models = entities
    .map((e) => {
      const lines: string[] = [];
      for (const f of e.fields) {
        const pk = f.primaryKey ? " @id" : "";
        const uniq = f.unique && !f.primaryKey ? " @unique" : "";
        const opt = !f.required ? "?" : "";
        const def = f.primaryKey
          ? f.type === "uuid"
            ? " @default(uuid())"
            : " @default(autoincrement())"
          : "";
        lines.push(`  ${f.name}  ${prismaType(f.type)}${opt}${pk}${def}${uniq}`);
      }
      if (!e.fields.some((f) => f.name === "createdAt"))
        lines.push("  createdAt DateTime @default(now())");
      if (!e.fields.some((f) => f.name === "updatedAt"))
        lines.push("  updatedAt DateTime @updatedAt");
      return `model ${e.name} {\n${lines.join("\n")}\n}`;
    })
    .join("\n\n");

  const schema = `// Auto-generated by Helios — edit freely
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}

${models}
`;
  return [{ path: "prisma/schema.prisma", content: schema }];
}

function prismaType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "String";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "Int";
    case "boolean": return "Boolean";
    case "date":    return "DateTime";
    case "json":    return "Json";
  }
}

function pkgJson(name: string, framework: string, withPrisma = false, _db = "") {
  const deps: Record<string, Record<string, string>> = {
    nestjs: {
      "@nestjs/common": "^10.4.0",
      "@nestjs/core": "^10.4.0",
      "@nestjs/platform-express": "^10.4.0",
      "reflect-metadata": "^0.2.2",
      "rxjs": "^7.8.1",
    },
    express: {
      express: "^4.21.0",
      pino: "^9.5.0",
      "pino-http": "^10.3.0",
      zod: "^3.24.1",
    },
    fastify: {
      fastify: "^5.0.0",
      "@fastify/helmet": "^12.0.0",
      zod: "^3.24.1",
    },
    hono: {
      hono: "^4.6.0",
      "@hono/node-server": "^1.13.0",
      zod: "^3.24.1",
    },
  };
  const dep = {
    ...(deps[framework] ?? deps.express),
    ...(withPrisma ? { "@prisma/client": "^5.22.0" } : {}),
  };
  return (
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: framework === "nestjs" ? "nest start --watch" : "tsx watch src/main.ts",
          start: framework === "nestjs" ? "node dist/main.js" : "node dist/main.js",
          build: "tsc -p tsconfig.json",
          test: "vitest run",
          ...(withPrisma ? { "db:generate": "prisma generate", "db:migrate": "prisma migrate dev" } : {}),
        },
        dependencies: dep,
        devDependencies: {
          "@types/node": "^22.10.5",
          tsx: "^4.19.0",
          typescript: "^5.7.2",
          vitest: "^2.1.0",
          ...(framework === "express" ? { "@types/express": "^4.17.21" } : {}),
          ...(withPrisma ? { prisma: "^5.22.0" } : {}),
        },
      },
      null,
      2
    ) + "\n"
  );
}

function tsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "commonjs",
        moduleResolution: "node",
        lib: ["ES2022"],
        outDir: "dist",
        rootDir: "src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      include: ["src/**/*"],
    },
    null,
    2
  ) + "\n";
}

function tsDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN npm install typescript --no-save && npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
`;
}

function nestjsFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) => `  @${capMethod(e.method)}(${JSON.stringify(nestPath(e.path))})
  ${handlerName(e)}() {
    return { ok: true, op: "${e.method} ${e.path}" };
  }`
    )
    .join("\n\n");

  const entityModuleImports = entities
    .map((e) => `import { ${e.name}Module } from "./modules/${toKebab(e.name)}/${toKebab(e.name)}.module";`)
    .join("\n");
  const entityModuleList = entities.map((e) => `${e.name}Module`).join(", ");

  return [
    {
      path: "src/main.ts",
      content: `import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  console.log(\`listening on \${port}\`);
}

bootstrap();
`,
    },
    {
      path: "src/app.module.ts",
      content: `import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
${entityModuleImports}

@Module({ controllers: [AppController]${entities.length > 0 ? `, imports: [${entityModuleList}]` : ""} })
export class AppModule {}
`,
    },
    {
      path: "src/app.controller.ts",
      content: `import { Controller, Get, Post, Put, Patch, Delete } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("/health")
  health() { return { ok: true }; }

${routes}
}
`,
    },
  ];
}

function expressFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, ${e.auth ? "authRequired, " : ""}(req, res) => res.json({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");

  const entityImports = entities
    .map((e) => `import { create${e.name}Router } from "./routes/${toKebab(e.name)}.router";`)
    .join("\n");
  const entityMounts = entities
    .map((e) => `app.use("/${toKebab(e.name)}s", create${e.name}Router());`)
    .join("\n");

  return [
    {
      path: "src/main.ts",
      content: `import express from "express";
import pinoHttp from "pino-http";
${config.rateLimit ? `import { rateLimit } from "./middleware/rate-limit";\n` : ""}import { authRequired } from "./middleware/auth";
${entityImports ? entityImports + "\n" : ""}
const app = express();
app.use(express.json());
app.use(pinoHttp());
${config.rateLimit ? "app.use(rateLimit);\n" : ""}
app.get("/health", (_, res) => res.json({ ok: true }));
${routes}
${entityMounts}
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(\`listening on \${port}\`));
`,
    },
    {
      path: "src/middleware/auth.ts",
      content: `import type { Request, Response, NextFunction } from "express";

export function authRequired(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return res.status(401).json({ error: "unauthorized" });
  // TODO: verify JWT
  next();
}
`,
    },
    ...(config.rateLimit
      ? [
          {
            path: "src/middleware/rate-limit.ts",
            content: `import type { Request, Response, NextFunction } from "express";

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW = 60_000;
const LIMIT = 60;

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? "anon";
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW });
    return next();
  }
  if (b.count >= LIMIT) return res.status(429).json({ error: "rate_limited" });
  b.count++;
  next();
}
`,
          },
        ]
      : []),
  ];
}

function fastifyFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, async () => ({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");

  const entityImports = entities
    .map((e) => `import { ${toCamel(e.name)}Routes } from "./routes/${toKebab(e.name)}.route";`)
    .join("\n");
  const entityRegistrations = entities
    .map((e) => `await app.register(${toCamel(e.name)}Routes, { prefix: "/${toKebab(e.name)}s" });`)
    .join("\n");

  return [
    {
      path: "src/main.ts",
      content: `import Fastify from "fastify";
import helmet from "@fastify/helmet";
${entityImports ? entityImports + "\n" : ""}
const app = Fastify({ logger: true });
await app.register(helmet);

app.get("/health", async () => ({ ok: true }));
${routes}
${entityRegistrations}
const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => { app.log.error(err); process.exit(1); });
`,
    },
  ];
}

function honoFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, (c) => c.json({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");

  const entityImports = entities
    .map((e) => `import { ${toCamel(e.name)}Routes } from "./routes/${toKebab(e.name)}.route";`)
    .join("\n");
  const entityMounts = entities
    .map((e) => `app.route("/${toKebab(e.name)}s", ${toCamel(e.name)}Routes);`)
    .join("\n");

  return [
    {
      path: "src/main.ts",
      content: `import { Hono } from "hono";
import { serve } from "@hono/node-server";
${entityImports ? entityImports + "\n" : ""}
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
${routes}
${entityMounts}
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
console.log(\`listening on \${port}\`);
`,
    },
  ];
}

function capMethod(m: string) {
  return m[0] + m.slice(1).toLowerCase();
}
function nestPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
}
function expressPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
}
function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p)));
  return e.method.toLowerCase() + parts.join("");
}
function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

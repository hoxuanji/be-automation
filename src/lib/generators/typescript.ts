import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { safeName, toKebab, toCamel } from "./types";
import { tsGrpcFiles } from "./grpc/typescript";
import { needsAuth } from "./auth/providers";
import { tsPatternRoute, tsPatternImports } from "./patterns/typescript";

function tsMockField(name: string, type: FieldType): string {
  switch (type) {
    case "string": return `${name}: "test-value"`;
    case "text": return `${name}: "test-value"`;
    case "number": return `${name}: 1`;
    case "boolean": return `${name}: true`;
    case "uuid": return `${name}: "00000000-0000-0000-0000-000000000001"`;
    case "date": return `${name}: new Date().toISOString()`;
    case "json": return `${name}: {}`;
  }
}

function tsSendBody(nonPkFields: EntityField[]): string {
  const required = nonPkFields.filter((f) => f.required).slice(0, 4);
  const fields = required.length ? required : nonPkFields.slice(0, 2);
  return `{ ${fields.map((f) => tsMockField(f.name, f.type)).join(", ")} }`;
}

export function typescriptFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  if (config.api === "trpc") {
    return tRPCFiles(config, endpoints, entities);
  }

  // gRPC mode replaces the framework-specific HTTP bootstrap with a @grpc/grpc-js
  // server. Prisma schema is still useful so we keep it — the generated
  // service stubs can plug into PrismaClient without further ceremony.
  if (config.api === "grpc") {
    const files: GeneratedFile[] = [];
    if (entities.length > 0) {
      files.push(...prismaFiles(config, entities));
    }
    files.push(...tsGrpcFiles(config, entities));
    return files;
  }

  const name = safeName(config.name);
  const files: GeneratedFile[] = [];
  const anyProtected = endpoints.some((e) => e.auth);
  const withAuth = needsAuth(config, anyProtected);

  files.push({ path: "package.json", content: pkgJson(name, config.framework, entities.length > 0, config.database, withAuth, config.monitoring) });
  files.push({ path: "tsconfig.json", content: tsconfig() });
  files.push({ path: "Dockerfile", content: tsDockerfile() });
  files.push({ path: "vitest.config.ts", content: vitestConfig() });

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

    files.push({
      path: config.framework === "nestjs"
        ? `src/modules/${kebab}/${kebab}.controller.spec.ts`
        : `src/routes/${kebab}.${config.framework === "express" ? "router" : "route"}.test.ts`,
      content: testFile(config.framework, pascal, camel, kebab, nonPkFields),
    });
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

function pkgJson(name: string, framework: string, withPrisma = false, _db = "", withAuth = false, monitoring = "") {
  const deps: Record<string, Record<string, string>> = {
    nestjs: {
      "@nestjs/common": "^10.4.0",
      "@nestjs/core": "^10.4.0",
      "@nestjs/platform-express": "^10.4.0",
      helmet: "^8.0.0",
      "reflect-metadata": "^0.2.2",
      "rxjs": "^7.8.1",
    },
    express: {
      express: "^4.21.0",
      helmet: "^8.0.0",
      cors: "^2.8.5",
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
    ...(deps[framework] ?? deps.hono),
    ...(withPrisma ? { "@prisma/client": "^5.22.0" } : {}),
    ...(withAuth ? { jose: "^5.9.6" } : {}),
    ...(/prometheus|grafana/.test(monitoring) && framework === "express" ? { "prom-client": "^15.1.3" } : {}),
    ...(/sentry/.test(monitoring) && framework === "express" ? { "@sentry/node": "^8.42.0" } : {}),
    ...(/datadog/.test(monitoring) && framework === "express" ? { "dd-trace": "^5.23.0" } : {}),
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
          "test:coverage": "vitest run --coverage",
          ...(withPrisma
            ? {
                "db:generate": "prisma generate",
                "db:migrate": "prisma migrate dev",
                "db:deploy": "prisma migrate deploy",
                "db:seed": "prisma db seed",
              }
            : {}),
        },
        // `prisma db seed` reads this to find the seed script.
        ...(withPrisma
          ? { prisma: { seed: "tsx prisma/seed.ts" } }
          : {}),
        dependencies: dep,
        devDependencies: {
          "@types/node": "^22.10.5",
          tsx: "^4.19.0",
          typescript: "^5.7.2",
          vitest: "^2.0.0",
          "@vitest/coverage-v8": "^2.0.0",
          supertest: "^7.0.0",
          "@types/supertest": "^6.0.0",
          ...(framework === "express" ? { "@types/express": "^4.17.21", "@types/cors": "^2.8.17" } : {}),
          ...(framework === "nestjs" ? { "@nestjs/testing": "^10.0.0" } : {}),
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
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "node_modules"],
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
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
`;
}

function vitestConfig(): string {
  return `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
`;
}

function testFile(
  framework: string,
  pascal: string,
  camel: string,
  kebab: string,
  nonPkFields: EntityField[]
): string {
  const mockFieldEntries = nonPkFields
    .slice(0, 4)
    .map((f) => tsMockField(f.name, f.type))
    .join(", ");
  const sendBody = tsSendBody(nonPkFields);

  if (framework === "express") {
    return `import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";
import { create${pascal}Router } from "./${kebab}.router";

const mockItem = { id: "test-id-1", ${mockFieldEntries}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

vi.mock("../services/${kebab}.service", () => ({
  list${pascal}: vi.fn().mockResolvedValue({ items: [mockItem], total: 1, page: 1, pageSize: 20 }),
  get${pascal}ById: vi.fn().mockImplementation((id: string) =>
    Promise.resolve(id === "test-id-1" ? mockItem : null)
  ),
  create${pascal}: vi.fn().mockResolvedValue(mockItem),
  update${pascal}: vi.fn().mockImplementation((id: string, data: unknown) =>
    Promise.resolve(id === "test-id-1" ? { ...mockItem, ...(data as object) } : null)
  ),
  delete${pascal}: vi.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use(express.json());
app.use("/${kebab}s", create${pascal}Router());

describe("${pascal} routes", () => {
  it("GET /${kebab}s → 200 with items", async () => {
    const res = await request(app).get("/${kebab}s");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("GET /${kebab}s/:id → 200 when found", async () => {
    const res = await request(app).get("/${kebab}s/test-id-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("test-id-1");
  });

  it("GET /${kebab}s/:id → 404 when not found", async () => {
    const res = await request(app).get("/${kebab}s/nonexistent");
    expect(res.status).toBe(404);
  });

  it("POST /${kebab}s → 201 with created item", async () => {
    const res = await request(app)
      .post("/${kebab}s")
      .send(${sendBody});
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("test-id-1");
  });

  it("PATCH /${kebab}s/:id → 200 when found", async () => {
    const res = await request(app)
      .patch("/${kebab}s/test-id-1")
      .send(${sendBody});
    expect(res.status).toBe(200);
  });

  it("PATCH /${kebab}s/:id → 404 when not found", async () => {
    const res = await request(app)
      .patch("/${kebab}s/nonexistent")
      .send(${sendBody});
    expect(res.status).toBe(404);
  });

  it("DELETE /${kebab}s/:id → 204", async () => {
    const res = await request(app).delete("/${kebab}s/test-id-1");
    expect(res.status).toBe(204);
  });
});
`;
  }

  if (framework === "fastify") {
    return `import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { ${camel}Routes } from "./${kebab}.route";

const mockItem = { id: "test-id-1", ${mockFieldEntries}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

vi.mock("../services/${kebab}.service", () => ({
  list${pascal}: vi.fn().mockResolvedValue({ items: [mockItem], total: 1, page: 1, pageSize: 20 }),
  get${pascal}ById: vi.fn().mockImplementation((id: string) =>
    Promise.resolve(id === "test-id-1" ? mockItem : null)
  ),
  create${pascal}: vi.fn().mockResolvedValue(mockItem),
  update${pascal}: vi.fn().mockImplementation((id: string, data: unknown) =>
    Promise.resolve(id === "test-id-1" ? { ...mockItem, ...(data as object) } : null)
  ),
  delete${pascal}: vi.fn().mockResolvedValue(undefined),
}));

async function buildApp() {
  const app = Fastify();
  await app.register(${camel}Routes, { prefix: "/${kebab}s" });
  return app;
}

describe("${pascal} routes", () => {
  it("GET /${kebab}s → 200 with items", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/${kebab}s" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toHaveLength(1);
  });

  it("GET /${kebab}s/:id → 200 when found", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/${kebab}s/test-id-1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe("test-id-1");
  });

  it("GET /${kebab}s/:id → 404 when not found", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/${kebab}s/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("POST /${kebab}s → 201 with created item", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/${kebab}s", payload: ${sendBody} });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe("test-id-1");
  });

  it("PATCH /${kebab}s/:id → 200 when found", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: "/${kebab}s/test-id-1", payload: ${sendBody} });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH /${kebab}s/:id → 404 when not found", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "PATCH", url: "/${kebab}s/nonexistent", payload: ${sendBody} });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /${kebab}s/:id → 204", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/${kebab}s/test-id-1" });
    expect(res.statusCode).toBe(204);
  });
});
`;
  }

  if (framework === "nestjs") {
    return `import { describe, it, expect, beforeEach, vi } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { ${pascal}Controller } from "./${kebab}.controller";
import { ${pascal}NestService } from "./${kebab}.service";

const mockItem = { id: "test-id-1", ${mockFieldEntries}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

describe("${pascal}Controller", () => {
  let controller: ${pascal}Controller;
  const mockService = {
    list: vi.fn().mockResolvedValue({ items: [mockItem], total: 1, page: 1, pageSize: 20 }),
    getById: vi.fn().mockImplementation((id: string) =>
      Promise.resolve(id === "test-id-1" ? mockItem : null)
    ),
    create: vi.fn().mockImplementation((dto: unknown) => Promise.resolve({ id: "test-id-1", ...(dto as object) })),
    update: vi.fn().mockImplementation((id: string, dto: unknown) => Promise.resolve({ id, ...(dto as object) })),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [${pascal}Controller],
      providers: [{ provide: ${pascal}NestService, useValue: mockService }],
    }).compile();
    controller = module.get<${pascal}Controller>(${pascal}Controller);
  });

  it("list returns paginated result", async () => {
    const result = await controller.list({});
    expect(result).toHaveProperty("items");
  });

  it("getById returns item", async () => {
    const result = await controller.getById("test-id-1");
    expect(result).toHaveProperty("id");
  });

  it("create returns new item", async () => {
    const result = await controller.create(${sendBody} as unknown);
    expect(result).toHaveProperty("id");
  });

  it("update returns updated item", async () => {
    const result = await controller.update("test-id-1", ${sendBody} as unknown);
    expect(result).toHaveProperty("id");
  });

  it("remove returns void", async () => {
    const result = await controller.remove("test-id-1");
    expect(result).toBeUndefined();
  });
});
`;
  }

  // Default: hono-style test (covers hono and any unrecognized framework)
  {
    return `import { describe, it, expect, vi } from "vitest";
import { ${camel}Routes } from "./${kebab}.route";

const mockItem = { id: "test-id-1", ${mockFieldEntries}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

vi.mock("../services/${kebab}.service", () => ({
  list${pascal}: vi.fn().mockResolvedValue({ items: [mockItem], total: 1, page: 1, pageSize: 20 }),
  get${pascal}ById: vi.fn().mockImplementation((id: string) =>
    Promise.resolve(id === "test-id-1" ? mockItem : null)
  ),
  create${pascal}: vi.fn().mockResolvedValue(mockItem),
  update${pascal}: vi.fn().mockImplementation((id: string, data: unknown) =>
    Promise.resolve(id === "test-id-1" ? { ...mockItem, ...(data as object) } : null)
  ),
  delete${pascal}: vi.fn().mockResolvedValue(undefined),
}));

describe("${pascal} routes", () => {
  it("GET / → 200 with items", async () => {
    const res = await ${camel}Routes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });

  it("GET /:id → 200 when found", async () => {
    const res = await ${camel}Routes.request("/test-id-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("test-id-1");
  });

  it("GET /:id → 404 when not found", async () => {
    const res = await ${camel}Routes.request("/nonexistent");
    expect(res.status).toBe(404);
  });

  it("POST / → 201 with created item", async () => {
    const res = await ${camel}Routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(${sendBody}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("test-id-1");
  });

  it("PATCH /:id → 200 when found", async () => {
    const res = await ${camel}Routes.request("/test-id-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(${sendBody}),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH /:id → 404 when not found", async () => {
    const res = await ${camel}Routes.request("/nonexistent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(${sendBody}),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id → 204", async () => {
    const res = await ${camel}Routes.request("/test-id-1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
`;
  }

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

  const anyProtected = endpoints.some((e) => e.auth);
  const withAuth = needsAuth(config, anyProtected);

  return [
    {
      path: "src/main.ts",
      content: `import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";

// Comma-separated list of origins, e.g. "https://app.example.com,https://admin.example.com".
// Omit to keep CORS locked down — the app defaults to same-origin only.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: allowedOrigins && allowedOrigins.length > 0
      ? { origin: allowedOrigins, credentials: true }
      : false,
  });
  app.use(helmet());
  // enableShutdownHooks wires Node's SIGTERM/SIGINT into the Nest application
  // lifecycle: controllers, providers, and the HTTP listener all receive
  // onModuleDestroy / onApplicationShutdown callbacks before the process exits.
  // Required for in-flight request draining during K8s rolling deploys.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  console.log(JSON.stringify({ level: "info", msg: "listening", port }));
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
    ...(withAuth
      ? [
          {
            path: "src/auth/jwt.guard.ts",
            content: `import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * NestJS guard that verifies an \`Authorization: Bearer <jwt>\` header against
 * the configured issuer + JWKS. Attaches the decoded payload to
 * \`request.user.claims\` so controllers can reach for \`req.user.sub\` etc.
 *
 * Apply per-route or globally:
 *   @UseGuards(JwtAuthGuard)
 *   @Get("/me")
 *   me(@Req() req: Request) { return req.user; }
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly log = new Logger(JwtAuthGuard.name);
  private readonly issuer = process.env.AUTH_ISSUER;
  private readonly audience = process.env.AUTH_AUDIENCE;
  private readonly jwks = process.env.AUTH_JWKS_URL
    ? createRemoteJWKSet(new URL(process.env.AUTH_JWKS_URL))
    : null;

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.jwks || !this.issuer) {
      this.log.error("AUTH_ISSUER or AUTH_JWKS_URL not set");
      throw new UnauthorizedException("auth_unconfigured");
    }
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string>; user?: { sub: string; claims: JWTPayload } }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("missing_or_malformed_token");
    try {
      const { payload } = await jwtVerify(header.slice(7).trim(), this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 30,
      });
      req.user = { sub: String(payload.sub ?? ""), claims: payload };
      return true;
    } catch {
      throw new UnauthorizedException("invalid_token");
    }
  }
}
`,
          },
        ]
      : []),
  ];
}

function expressFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const { needsBcrypt, needsJwt } = tsPatternImports(endpoints);
  const routes = endpoints
    .map((e) =>
      e.pattern
        ? tsPatternRoute(e, "express", config, entities)
        : `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, ${e.auth ? "authRequired, " : ""}(req, res) => res.json({ ok: true, op: "${e.method} ${e.path}" }));`
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
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";
${needsBcrypt ? 'import bcrypt from "bcrypt";\n' : ""}${needsJwt ? 'import jwt from "jsonwebtoken";\n' : ""}${config.rateLimit ? `import { rateLimit } from "./middleware/rate-limit";\n` : ""}${config.audit ? `import { auditLogger } from "./middleware/audit";\n` : ""}${/prometheus|grafana/.test(config.monitoring) ? `import { collectDefaultMetrics, register } from "prom-client";\ncollectDefaultMetrics();\n` : ""}${/sentry/.test(config.monitoring) ? `import * as Sentry from "@sentry/node";\nSentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });\n` : ""}${/datadog/.test(config.monitoring) ? `import tracer from "dd-trace";\ntracer.init();\n` : ""}import { authRequired } from "./middleware/auth";
${entityImports ? entityImports + "\n" : ""}
// Comma-separated list of origins in ALLOWED_ORIGINS, e.g.
// "https://app.example.com,https://admin.example.com". Omit to keep CORS
// locked to same-origin only.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(helmet());
if (allowedOrigins && allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins, credentials: true }));
}
// Explicit JSON size limit protects against resource-exhaustion payloads.
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({
  // JSON output (pino's default) is parseable by Loki / Datadog / CloudWatch
  // without a text-to-JSON transform.
  redact: ["req.headers.authorization", "req.headers.cookie"],
}));
${config.rateLimit ? "app.use(rateLimit);\n" : ""}${config.audit ? "app.use(auditLogger);\n" : ""}
app.get("/health", (_, res) => res.json({ ok: true }));
${/prometheus|grafana/.test(config.monitoring) ? `app.get("/metrics", async (_, res) => { res.set("Content-Type", register.contentType); res.end(await register.metrics()); });\n` : ""}${routes}
${entityMounts}
const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, () => console.log(JSON.stringify({ level: "info", msg: "listening", port })));

// Graceful shutdown on SIGTERM — Kubernetes sends this before killing the pod.
// We stop accepting new connections, wait for in-flight requests to finish
// (up to 25 s, within the default K8s terminationGracePeriodSeconds of 30 s),
// then exit.
function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", msg: "shutdown", signal }));
  server.close((err) => {
    if (err) {
      console.error(JSON.stringify({ level: "error", msg: "shutdown failed", err: String(err) }));
      process.exit(1);
    }
    process.exit(0);
  });
  // Belt-and-suspenders: force exit if close() hangs past the grace window.
  setTimeout(() => {
    console.error(JSON.stringify({ level: "error", msg: "shutdown timed out — forcing exit" }));
    process.exit(1);
  }, 25_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
`,
    },
    {
      path: "src/middleware/auth.ts",
      content: `import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// Lazy-initialized JWKS fetcher. \`jose\` caches keys internally and honors
// the \`Cache-Control\` header on the JWKS response — no hand-rolled key
// management. One JWKS instance is shared across all requests.
const issuer = process.env.AUTH_ISSUER;
const jwksUrl = process.env.AUTH_JWKS_URL;
const audience = process.env.AUTH_AUDIENCE;

const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { sub: string; claims: JWTPayload };
    }
  }
}

export async function authRequired(req: Request, res: Response, next: NextFunction) {
  if (!jwks || !issuer) {
    return res.status(500).json({ error: "auth_unconfigured", hint: "Set AUTH_ISSUER and AUTH_JWKS_URL." });
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_or_malformed_token" });
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience, // undefined → jose skips the check
      clockTolerance: 30,
    });
    req.user = { sub: String(payload.sub ?? ""), claims: payload };
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}
`,
    },
    ...(config.audit
      ? [
          {
            path: "src/middleware/audit.ts",
            content: `import type { Request, Response, NextFunction } from "express";

export function auditLogger(req: Request, res: Response, next: NextFunction) {
  res.on("finish", () => {
    process.stdout.write(
      JSON.stringify({
        level: "info",
        event: "audit",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        userId: (req as Record<string, unknown> & { user?: { sub?: string } }).user?.sub ?? "anonymous",
        ip: req.ip ?? req.socket.remoteAddress,
        time: new Date().toISOString(),
      }) + "\\n"
    );
  });
  next();
}
`,
          },
        ]
      : []),
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
    .map((e) =>
      e.pattern
        ? tsPatternRoute(e, "fastify", config, entities)
        : `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, async () => ({ ok: true, op: "${e.method} ${e.path}" }));`
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
async function main() {
  // Fastify's built-in logger (pino) already emits JSON, so no extra config needed.
  const app = Fastify({ logger: true });
  await app.register(helmet);

  app.get("/health", async () => ({ ok: true }));
${routes}
${entityRegistrations}
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "0.0.0.0" });

  // Graceful shutdown — Fastify's close() awaits in-flight requests and
  // triggers all registered onClose hooks.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      app.log.info({ signal }, "shutdown");
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, "shutdown failed");
        process.exit(1);
      }
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
    },
  ];
}

function honoFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const routes = endpoints
    .map((e) =>
      e.pattern
        ? tsPatternRoute(e, "hono", config, entities)
        : `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, (c) => c.json({ ok: true, op: "${e.method} ${e.path}" }));`
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
const server = serve({ fetch: app.fetch, port });
console.log(JSON.stringify({ level: "info", msg: "listening", port }));

// Graceful shutdown. @hono/node-server exposes the underlying Node server
// via the returned object — we call close() to stop accepting connections,
// then force-exit if in-flight requests overrun the grace window.
function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", msg: "shutdown", signal }));
  server.close((err) => {
    if (err) {
      console.error(JSON.stringify({ level: "error", msg: "shutdown failed", err: String(err) }));
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error(JSON.stringify({ level: "error", msg: "shutdown timed out — forcing exit" }));
    process.exit(1);
  }, 25_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
`,
    },
  ];
}

function tRPCFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const name = safeName(config.name);

  const procedures = endpoints.map((e) => {
    const key = handlerName(e);
    const isQuery = e.method === "GET";
    return `  ${key}: ${isQuery ? "publicProcedure.query" : "publicProcedure.mutation"}(() => ({ ok: true, op: "${e.method} ${e.path}" })),`;
  }).join("\n");

  const entityProcedures = entities.flatMap((en) => {
    const n = en.name.toLowerCase();
    return [
      `  ${n}List: publicProcedure.query(() => [] as ${en.name}[]),`,
      `  ${n}GetById: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => ({ id: input.id } as ${en.name})),`,
      `  ${n}Create: publicProcedure.input(z.object({ data: z.record(z.unknown()) })).mutation(({ input }) => ({ id: "new", ...input.data } as unknown as ${en.name})),`,
      `  ${n}Delete: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => ({ deleted: input.id })),`,
    ];
  }).join("\n");

  const entityTypes = entities.map((en) => {
    const fields = en.fields.map((f) => {
      const tsType = f.type === "number" ? "number" : f.type === "boolean" ? "boolean" : f.type === "date" ? "string" : f.type === "json" ? "Record<string, unknown>" : "string";
      return `  ${f.name}${f.required ? "" : "?"}: ${tsType};`;
    }).join("\n");
    return `export type ${en.name} = {\n${fields}\n};`;
  }).join("\n\n");

  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name,
        version: "0.1.0",
        private: true,
        scripts: {
          dev: "tsx watch src/server.ts",
          start: "node dist/server.js",
          build: "tsc -p tsconfig.json",
          test: "vitest run",
        },
        dependencies: {
          "@trpc/server": "^11.0.0",
          express: "^4.21.0",
          zod: "^3.24.1",
          "pino-http": "^10.3.0",
        },
        devDependencies: {
          "@types/express": "^4.17.21",
          "@types/node": "^22.10.5",
          tsx: "^4.19.0",
          typescript: "^5.7.2",
          vitest: "^2.0.0",
        },
      }, null, 2) + "\n",
    },
    { path: "tsconfig.json", content: tsconfig() },
    {
      path: "src/trpc.ts",
      content: `import { initTRPC } from "@trpc/server";
import { z } from "zod";

export { z };

const t = initTRPC.create();
export const router = t.router;
export const publicProcedure = t.procedure;
`,
    },
    {
      path: "src/types.ts",
      content: entityTypes || `// Add your shared types here.\nexport {};\n`,
    },
    {
      path: "src/router.ts",
      content: `import { router, publicProcedure, z } from "./trpc";
${entities.length > 0 ? `import type { ${entities.map((e) => e.name).join(", ")} } from "./types";` : ""}

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true })),
${procedures}
${entityProcedures}
});

export type AppRouter = typeof appRouter;
`,
    },
    {
      path: "src/server.ts",
      content: `import express from "express";
import pinoHttp from "pino-http";
import * as trpcExpress from "@trpc/server/adapters/express";
import { appRouter } from "./router";

const app = express();
app.use(pinoHttp());
app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({ router: appRouter })
);
app.get("/health", (_, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () =>
  console.log(JSON.stringify({ level: "info", msg: "listening", port }))
);
`,
    },
    {
      path: "src/client.ts",
      content: `import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "./router";

// Example client — import this in any consuming project.
export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: process.env.API_URL ?? "http://localhost:8080/trpc",
    }),
  ],
});
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

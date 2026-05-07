import type { Endpoint, GeneratedFile, StackConfig } from "./types";
import { safeName } from "./types";

export function typescriptFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const files: GeneratedFile[] = [];

  files.push({ path: "package.json", content: pkgJson(name, config.framework) });
  files.push({ path: "tsconfig.json", content: tsconfig() });
  files.push({ path: "Dockerfile", content: tsDockerfile() });

  if (config.framework === "nestjs") {
    files.push(...nestjsFiles(config, endpoints));
  } else if (config.framework === "express") {
    files.push(...expressFiles(config, endpoints));
  } else if (config.framework === "fastify") {
    files.push(...fastifyFiles(config, endpoints));
  } else {
    files.push(...honoFiles(config, endpoints));
  }

  return files;
}

function pkgJson(name: string, framework: string) {
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
    },
    hono: {
      hono: "^4.6.0",
      "@hono/node-server": "^1.13.0",
    },
  };
  const dep = deps[framework] ?? deps.express;
  return JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: framework === "nestjs" ? "nest start --watch" : "tsx watch src/main.ts",
        start: framework === "nestjs" ? "node dist/main.js" : "node dist/main.js",
        build: "tsc -p tsconfig.json",
        test: "vitest run",
      },
      dependencies: dep,
      devDependencies: {
        "@types/node": "^22.10.5",
        tsx: "^4.19.0",
        typescript: "^5.7.2",
        vitest: "^2.1.0",
        ...(framework === "express" ? { "@types/express": "^4.17.21" } : {}),
      },
    },
    null,
    2
  ) + "\n";
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

function nestjsFiles(config: StackConfig, endpoints: Endpoint[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) => `  @${capMethod(e.method)}(${JSON.stringify(nestPath(e.path))})
  ${handlerName(e)}() {
    return { ok: true, op: "${e.method} ${e.path}" };
  }`
    )
    .join("\n\n");
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

@Module({ controllers: [AppController] })
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

function expressFiles(config: StackConfig, endpoints: Endpoint[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, ${e.auth ? "authRequired, " : ""}(req, res) => res.json({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");
  return [
    {
      path: "src/main.ts",
      content: `import express from "express";
import pinoHttp from "pino-http";
${config.rateLimit ? `import { rateLimit } from "./middleware/rate-limit";\n` : ""}import { authRequired } from "./middleware/auth";

const app = express();
app.use(express.json());
app.use(pinoHttp());
${config.rateLimit ? "app.use(rateLimit);\n" : ""}
app.get("/health", (_, res) => res.json({ ok: true }));
${routes}

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

function fastifyFiles(config: StackConfig, endpoints: Endpoint[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, async () => ({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");
  return [
    {
      path: "src/main.ts",
      content: `import Fastify from "fastify";
import helmet from "@fastify/helmet";

const app = Fastify({ logger: true });
await app.register(helmet);

app.get("/health", async () => ({ ok: true }));
${routes}

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((err) => { app.log.error(err); process.exit(1); });
`,
    },
  ];
}

function honoFiles(config: StackConfig, endpoints: Endpoint[]): GeneratedFile[] {
  const routes = endpoints
    .map(
      (e) =>
        `app.${e.method.toLowerCase()}(${JSON.stringify(expressPath(e.path))}, (c) => c.json({ ok: true, op: "${e.method} ${e.path}" }));`
    )
    .join("\n");
  return [
    {
      path: "src/main.ts",
      content: `import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
${routes}

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

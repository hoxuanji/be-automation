import type { GeneratedFile } from "../types";
import { mountOnTsRest } from "../graphql/typescript";

const trpcDeps = { "@trpc/server": "^11.0.0", "@trpc/client": "^11.0.0" };
const routerImport = `import { appRouter } from "./router";`;

/**
 * Mounts the tRPC appRouter on the REST tree `buildRest` emits for the chosen
 * framework (with no routes), using that framework's own adapter so its rate
 * limit, audit, tracing and /metrics wiring stay in front of /trpc. Unknown
 * frameworks fall back to Express.
 */
export function mountTrpcOnTsRest(
  framework: string,
  buildRest: (framework: string) => GeneratedFile[]
): GeneratedFile[] {
  if (!["fastify", "hono", "nestjs"].includes(framework)) framework = "express";
  const rest = buildRest(framework);
  if (framework === "fastify") {
    // Registered on the root instance after rate-limit/audit hooks, so they apply.
    return mountOnTsRest(rest, {
      imports: `import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";\n${routerImport}`,
      mount: `await app.register(fastifyTRPCPlugin, { prefix: "/trpc", trpcOptions: { router: appRouter } });`,
      deps: trpcDeps,
    });
  }
  if (framework === "hono") {
    return mountOnTsRest(rest, {
      imports: `import { trpcServer } from "@hono/trpc-server";\n${routerImport}`,
      mount: `app.use("/trpc/*", trpcServer({ router: appRouter }));`,
      deps: { ...trpcDeps, "@hono/trpc-server": "^0.4.2" },
    });
  }
  if (framework === "nestjs") {
    // Nest runs on Express, so the Express adapter goes on the underlying
    // instance; app.use middleware (helmet, audit) runs before it. ThrottlerGuard
    // only guards controllers, so the Express rate limiter is mounted here too.
    const limiter = buildRest("express").find((f) => f.path === "src/middleware/rate-limit.ts");
    if (limiter) rest.push(limiter);
    const files = mountOnTsRest(rest, {
      imports: `import * as trpcExpress from "@trpc/server/adapters/express";\n${routerImport}${limiter ? `\nimport { rateLimit } from "./middleware/rate-limit";` : ""}`,
      mount: `app.use("/trpc", ${limiter ? "rateLimit, " : ""}trpcExpress.createExpressMiddleware({ router: appRouter }));`,
      deps: trpcDeps,
      anchor: /^( *)app\.enableShutdownHooks\(\);/m,
    });
    if (!limiter) return files;
    // rate-limit.ts imports express types.
    return files.map((f) => {
      if (f.path !== "package.json") return f;
      const pkg = JSON.parse(f.content);
      pkg.devDependencies = { ...pkg.devDependencies, "@types/express": "^4.17.21" };
      return { ...f, content: JSON.stringify(pkg, null, 2) + "\n" };
    });
  }
  return mountOnTsRest(rest, {
    imports: `import * as trpcExpress from "@trpc/server/adapters/express";\n${routerImport}`,
    mount: `app.use("/trpc", trpcExpress.createExpressMiddleware({ router: appRouter }));`,
    // src/client.ts imports @trpc/client.
    deps: trpcDeps,
  });
}

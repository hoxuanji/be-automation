import type { StackConfig } from "@/lib/store";

type Detection = Partial<StackConfig> & { confidence: "high" | "medium" | "low" };

const pathSet = (paths: string[]) => new Set(paths.map((p) => p.toLowerCase()));

export function detectStack(filePaths: string[]): Detection {
  const paths = pathSet(filePaths);
  const has = (p: string) => paths.has(p.toLowerCase());
  const hasAny = (...ps: string[]) => ps.some((p) => paths.has(p.toLowerCase()));
  const hasPattern = (pattern: RegExp) => filePaths.some((p) => pattern.test(p));

  // Language detection
  let language: StackConfig["language"] | undefined;
  let framework: string | undefined;
  let database: string | undefined;
  let api: StackConfig["api"] | undefined;
  let confidence: Detection["confidence"] = "low";

  if (has("go.mod")) {
    language = "go";
    confidence = "high";
    if (hasPattern(/gin\.go|gin\.Engine|github\.com\/gin-gonic\/gin/i) || hasPattern(/go\/gin/)) framework = "gin";
    else if (hasPattern(/fiber\.New|github\.com\/gofiber\/fiber/i)) framework = "fiber";
    else if (hasPattern(/echo\.New|github\.com\/labstack\/echo/i)) framework = "echo";
    else if (hasPattern(/chi\.NewRouter|github\.com\/go-chi\/chi/i)) framework = "chi";
  } else if (hasAny("package.json")) {
    // Distinguish TypeScript vs JS
    language = "typescript";
    confidence = "high";
    if (hasAny("nest-cli.json", ".nestrc") || hasPattern(/nestjs/i)) framework = "nestjs";
    else if (hasPattern(/fastify\.fastify|require\(['"]fastify['"]\)/i)) framework = "fastify";
    else if (hasPattern(/hono\.new|require\(['"]hono['"]\)/i)) framework = "hono";
    else framework = "express";
  } else if (hasAny("pyproject.toml", "requirements.txt", "setup.py", "setup.cfg")) {
    language = "python";
    confidence = "high";
    if (hasPattern(/fastapi/i)) framework = "fastapi";
    else if (hasPattern(/django/i)) framework = "django";
    else if (hasPattern(/litestar/i)) framework = "litestar";
  } else if (has("cargo.toml")) {
    language = "rust";
    confidence = "high";
    if (hasPattern(/axum/i)) framework = "axum";
    else if (hasPattern(/actix/i)) framework = "actix";
  } else if (hasAny("pom.xml", "gradlew", "build.gradle")) {
    if (hasPattern(/\.kt$/)) {
      language = "kotlin";
      framework = hasPattern(/ktor/i) ? "ktor" : "spring-kt";
    } else {
      language = "java";
      framework = hasPattern(/quarkus/i) ? "quarkus" : "spring";
    }
    confidence = "high";
  }

  // Database detection (from env files + compose)
  if (hasAny("docker-compose.yml", "docker-compose.yaml", ".env", ".env.example")) {
    if (hasPattern(/postgres|postgresql/i)) database = "postgres";
    else if (hasPattern(/mongodb|mongo/i)) database = "mongodb";
    else if (hasPattern(/mysql/i)) database = "mysql";
    else if (hasPattern(/sqlite/i)) database = "sqlite";
  }

  // API type detection
  if (hasPattern(/\.graphql$|\.gql$|graphql/i)) api = "graphql";
  else if (hasPattern(/\.proto$/)) api = "grpc";
  else api = "rest";

  return {
    ...(language ? { language } : {}),
    ...(framework ? { framework } : {}),
    ...(database ? { database } : {}),
    ...(api ? { api } : {}),
    docker: hasAny("dockerfile", "docker-compose.yml", "docker-compose.yaml"),
    kubernetes: hasPattern(/\.yaml$|\.yml$/) && hasPattern(/kind: Deployment|kind: Service/i),
    confidence,
  };
}

export function detectionSummary(det: Detection): string {
  const parts: string[] = [];
  if (det.language) parts.push(det.language);
  if (det.framework) parts.push(det.framework);
  if (det.database) parts.push(det.database);
  if (det.api && det.api !== "rest") parts.push(det.api);
  return parts.join(" · ") || "Unknown stack";
}

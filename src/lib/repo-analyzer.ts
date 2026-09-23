/**
 * Pure heuristics for detecting a project's stack from raw file contents.
 * No I/O, no LLM — takes a map of { filePath: content } and returns signals.
 */

import type { StackConfig } from "./store";

export type Confidence = "high" | "medium" | "low";

export type Signal = {
  field: keyof StackConfig;
  value: string;
  source: string;
  confidence: Confidence;
};

export type DetectedStack = {
  config: Partial<StackConfig>;
  signals: Signal[];
  confidence: Partial<Record<keyof StackConfig, Confidence>>;
};

type FileMap = Record<string, string>;

// ─── Language ────────────────────────────────────────────────────────────────

export function detectLanguage(files: FileMap): { value: StackConfig["language"]; confidence: Confidence; source: string } {
  if (files["go.mod"])          return { value: "go", confidence: "high", source: "go.mod" };
  if (files["Cargo.toml"])      return { value: "rust", confidence: "high", source: "Cargo.toml" };
  if (files["build.gradle.kts"]) return { value: "kotlin", confidence: "high", source: "build.gradle.kts" };
  if (files["pom.xml"])         return { value: "java", confidence: "high", source: "pom.xml" };
  if (files["build.gradle"])    return { value: "java", confidence: "high", source: "build.gradle" };
  if (files["pyproject.toml"] || files["requirements.txt"] || files["setup.py"]) {
    const src = files["pyproject.toml"] ? "pyproject.toml" : files["requirements.txt"] ? "requirements.txt" : "setup.py";
    return { value: "python", confidence: "high", source: src };
  }
  if (files["package.json"]) {
    try {
      const pkg = JSON.parse(files["package.json"]) as Record<string, unknown>;
      const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) };
      if ("typescript" in deps || "ts-node" in deps) {
        return { value: "typescript", confidence: "high", source: "package.json" };
      }
    } catch {}
    return { value: "typescript", confidence: "medium", source: "package.json" };
  }
  return { value: "typescript", confidence: "low", source: "unknown" };
}

// ─── Framework ───────────────────────────────────────────────────────────────

const GO_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["github.com/gin-gonic/gin", "gin"],
  ["github.com/gofiber/fiber", "fiber"],
  ["github.com/labstack/echo", "echo"],
  ["github.com/go-chi/chi", "chi"],
];

const TS_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["@nestjs/core", "nestjs"],
  ["fastify", "fastify"],
  ["@hono/", "hono"],
  ["hono", "hono"],
  ["express", "express"],
];

const PY_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["fastapi", "fastapi"],
  ["litestar", "litestar"],
  ["django", "django"],
];

const RUST_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["axum", "axum"],
  ["actix-web", "actix"],
];

const JAVA_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["spring-boot", "spring"],
  ["io.quarkus", "quarkus"],
  ["quarkus", "quarkus"],
];

const KOTLIN_FRAMEWORKS: [string, StackConfig["framework"]][] = [
  ["ktor", "ktor"],
  ["spring-boot", "spring-kt"],
];

function detectFrameworkByPatterns(content: string, patterns: [string, StackConfig["framework"]][]): StackConfig["framework"] | null {
  for (const [pattern, fw] of patterns) {
    if (content.includes(pattern)) return fw;
  }
  return null;
}

export function detectFramework(files: FileMap, language: StackConfig["language"]): { value: StackConfig["framework"]; confidence: Confidence; source: string } | null {
  switch (language) {
    case "go": {
      const goMod = files["go.mod"] ?? "";
      const fw = detectFrameworkByPatterns(goMod, GO_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: "go.mod" };
      break;
    }
    case "typescript": {
      const pkg = files["package.json"] ?? "";
      const fw = detectFrameworkByPatterns(pkg, TS_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: "package.json" };
      break;
    }
    case "python": {
      const reqs = (files["requirements.txt"] ?? "") + (files["pyproject.toml"] ?? "");
      const fw = detectFrameworkByPatterns(reqs, PY_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: files["requirements.txt"] ? "requirements.txt" : "pyproject.toml" };
      break;
    }
    case "rust": {
      const cargo = files["Cargo.toml"] ?? "";
      const fw = detectFrameworkByPatterns(cargo, RUST_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: "Cargo.toml" };
      break;
    }
    case "java": {
      const build = (files["pom.xml"] ?? "") + (files["build.gradle"] ?? "");
      const fw = detectFrameworkByPatterns(build, JAVA_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: files["pom.xml"] ? "pom.xml" : "build.gradle" };
      break;
    }
    case "kotlin": {
      const build = files["build.gradle.kts"] ?? "";
      const fw = detectFrameworkByPatterns(build, KOTLIN_FRAMEWORKS);
      if (fw) return { value: fw, confidence: "high", source: "build.gradle.kts" };
      break;
    }
  }
  return null;
}

// ─── Database ────────────────────────────────────────────────────────────────

const DB_PATTERNS: [RegExp | string, StackConfig["database"]][] = [
  ["postgres", "postgres"],
  ["postgresql", "postgres"],
  ["pgx", "postgres"],
  ["gorm", "postgres"],  // gorm defaults to postgres
  ["neon", "neon"],
  ["supabase", "supabase"],
  ["mongodb", "mongodb"],
  ["mongoose", "mongodb"],
  ["motor", "mongodb"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["sqlite", "sqlite"],
  ["redis", "redis"],
  ["dynamodb", "dynamodb"],
  ["firestore", "firestore"],
];

const COMPOSE_DB_IMAGES: [string, StackConfig["database"]][] = [
  ["postgres", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["mongo", "mongodb"],
  ["redis", "redis"],
  ["neon", "neon"],
];

const DEP_FILES = new Set(["package.json", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt", "pyproject.toml"]);

export function detectDatabase(files: FileMap): { value: StackConfig["database"]; confidence: Confidence; source: string } | null {
  const compose = files["docker-compose.yml"] ?? files["docker-compose.yaml"] ?? "";
  if (compose) {
    for (const [img, db] of COMPOSE_DB_IMAGES) {
      if (compose.includes(`image: ${img}`) || compose.includes(`image: "${img}`) || compose.toLowerCase().includes(`\n  image: ${img}`)) {
        return { value: db, confidence: "high", source: "docker-compose.yml" };
      }
    }
  }

  // Only scan dependency/manifest files — not README/docs to avoid false positives
  const depContent = Object.entries(files)
    .filter(([p]) => DEP_FILES.has(p))
    .map(([, c]) => c)
    .join("\n")
    .toLowerCase();

  for (const [pattern, db] of DB_PATTERNS) {
    const match = typeof pattern === "string" ? depContent.includes(pattern) : pattern.test(depContent);
    if (match) {
      return { value: db, confidence: "medium", source: "deps" };
    }
  }
  return null;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

export function detectCache(files: FileMap): { value: StackConfig["cache"]; confidence: Confidence; source: string } | null {
  const compose = files["docker-compose.yml"] ?? files["docker-compose.yaml"] ?? "";
  if (compose.includes("image: redis") || compose.includes("image: \"redis")) {
    return { value: "redis", confidence: "high", source: "docker-compose.yml" };
  }
  const depContent = Object.entries(files)
    .filter(([p]) => DEP_FILES.has(p))
    .map(([, c]) => c)
    .join("\n")
    .toLowerCase();
  if (depContent.includes("redis")) return { value: "redis", confidence: "medium", source: "deps" };
  if (depContent.includes("memcached")) return { value: "memcached", confidence: "medium", source: "deps" };
  return null;
}

// ─── Queue ───────────────────────────────────────────────────────────────────

const QUEUE_PATTERNS: [string, StackConfig["queue"]][] = [
  ["kafka", "kafka"],
  ["rabbitmq", "rabbitmq"],
  ["nats", "nats"],
  ["sqs", "sqs"],
  ["pubsub", "pubsub"],
  ["bullmq", "bullmq"],
  ["bull", "bullmq"],
];

export function detectQueue(files: FileMap): { value: StackConfig["queue"]; confidence: Confidence; source: string } | null {
  const compose = files["docker-compose.yml"] ?? files["docker-compose.yaml"] ?? "";
  const depContent = (
    Object.entries(files)
      .filter(([p]) => DEP_FILES.has(p))
      .map(([, c]) => c)
      .join("\n") + compose
  ).toLowerCase();
  for (const [pattern, queue] of QUEUE_PATTERNS) {
    if (depContent.includes(pattern)) {
      return { value: queue, confidence: "medium", source: "deps" };
    }
  }
  return null;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const AUTH_PATTERNS: [string, StackConfig["auth"]][] = [
  ["@clerk/", "clerk"],
  ["clerk", "clerk"],
  ["auth0", "auth0"],
  ["supabase", "supabase-auth"],
  ["@supabase/", "supabase-auth"],
  ["firebase", "firebase-auth"],
  ["cognito", "cognito"],
  ["keycloak", "keycloak"],
  ["passport", "passport"],
  ["next-auth", "nextauth"],
  ["@auth/", "nextauth"],
];

export function detectAuth(files: FileMap): { value: StackConfig["auth"]; confidence: Confidence; source: string } | null {
  const depContent = Object.entries(files)
    .filter(([p]) => DEP_FILES.has(p))
    .map(([, c]) => c)
    .join("\n")
    .toLowerCase();
  for (const [pattern, auth] of AUTH_PATTERNS) {
    if (depContent.includes(pattern)) {
      return { value: auth, confidence: "medium", source: "deps" };
    }
  }
  return null;
}

// ─── CI/CD ────────────────────────────────────────────────────────────────────

export function detectCICD(files: FileMap): { value: StackConfig["cicd"]; confidence: Confidence; source: string } | null {
  if (files[".github/workflows"]) return { value: "gh-actions", confidence: "high", source: ".github/workflows" };
  if (Object.keys(files).some((k) => k.startsWith(".github/workflows/"))) {
    return { value: "gh-actions", confidence: "high", source: ".github/workflows" };
  }
  if (files[".circleci/config.yml"]) return { value: "circleci", confidence: "high", source: ".circleci/config.yml" };
  if (files["Jenkinsfile"]) return { value: "gh-actions", confidence: "medium", source: "Jenkinsfile" }; // no jenkins in options
  if (files[".gitlab-ci.yml"]) return { value: "gitlab-ci", confidence: "high", source: ".gitlab-ci.yml" };
  return null;
}

// ─── Docker ───────────────────────────────────────────────────────────────────

export function detectDocker(files: FileMap): boolean {
  return "Dockerfile" in files || "docker-compose.yml" in files || "docker-compose.yaml" in files;
}

// ─── Kubernetes ───────────────────────────────────────────────────────────────

export function detectKubernetes(files: FileMap): boolean {
  return Object.keys(files).some(
    (k) => k.includes("k8s/") || k.includes("kubernetes/") || k.endsWith(".yaml") && (files[k].includes("kind: Deployment") || files[k].includes("kind: Service"))
  );
}

// ─── Project name ─────────────────────────────────────────────────────────────

export function detectName(files: FileMap, repoName: string): string {
  try {
    const pkg = JSON.parse(files["package.json"] ?? "{}") as { name?: string };
    if (pkg.name && /^[a-z0-9][a-z0-9-_]*$/.test(pkg.name)) return pkg.name;
  } catch {}
  // Sanitize repo name to match StackConfig name pattern
  return repoName.toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/^-+|-+$/g, "") || "imported-repo";
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function analyzeRepo(files: FileMap, repoName: string): DetectedStack {
  const signals: Signal[] = [];
  const config: Partial<StackConfig> = {};
  const confidence: Partial<Record<keyof StackConfig, Confidence>> = {};

  function record<K extends keyof StackConfig>(field: K, result: { value: StackConfig[K]; confidence: Confidence; source: string } | null) {
    if (!result) return;
    (config as Record<string, unknown>)[field] = result.value;
    confidence[field] = result.confidence;
    signals.push({ field, value: String(result.value), source: result.source, confidence: result.confidence });
  }

  const langResult = detectLanguage(files);
  record("language", langResult);

  const fwResult = detectFramework(files, langResult.value);
  record("framework", fwResult);

  record("database", detectDatabase(files));
  record("cache", detectCache(files));
  record("queue", detectQueue(files));
  record("auth", detectAuth(files));
  record("cicd", detectCICD(files));

  config.docker = detectDocker(files);
  config.kubernetes = detectKubernetes(files);
  config.name = detectName(files, repoName);

  if (config.docker) { confidence.docker = "high"; }
  if (config.kubernetes) { confidence.kubernetes = "high"; }

  return { config, signals, confidence };
}

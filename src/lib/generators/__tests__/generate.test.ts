import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../index.ts";
import { databases, caches, queues, monitoring as monitoringOptions } from "../../../data/stack-options.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = resolve(__dirname, "__snapshots__");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

// ─── Test fixtures ──────────────────────────────────────────────────────────

const BASE_CONFIG = {
  name: "test-app",
  database: "postgres",
  cache: "redis",
  queue: "rabbitmq",
  auth: "clerk",
  deployment: "k8s",
  scaling: "horizontal",
  monitoring: "prometheus",
  cicd: "github-actions",
  docker: true,
  kubernetes: true,
  helm: true,
  tracing: true,
  rateLimit: true,
  audit: true,
  autoscale: true,
  replicas: 2,
  region: "us-east-1",
  envVars: [],
};

const SAMPLE_ENDPOINTS = [
  { id: "1", method: "GET" as const, path: "/health", summary: "Health check", auth: false },
  { id: "2", method: "GET" as const, path: "/users", summary: "List users", auth: true },
  { id: "3", method: "POST" as const, path: "/users", summary: "Create user", auth: true,
    requestSchema: '{"name":"string","email":"string"}',
    responseSchema: '{"id":"string","name":"string"}',
  },
  { id: "4", method: "GET" as const, path: "/users/:id", summary: "Get user by ID", auth: true },
  { id: "5", method: "DELETE" as const, path: "/users/:id", summary: "Delete user", auth: true },
];

const SAMPLE_ENTITIES = [
  {
    id: "e1",
    name: "User",
    fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "name", type: "string" as const, required: true, unique: false },
      { id: "f3", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f4", name: "active", type: "boolean" as const, required: true, unique: false },
      { id: "f5", name: "createdAt", type: "date" as const, required: true, unique: false },
    ],
  },
  {
    id: "e2",
    name: "Post",
    fields: [
      { id: "f6", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f7", name: "title", type: "string" as const, required: true, unique: false },
      { id: "f8", name: "body", type: "text" as const, required: true, unique: false },
      { id: "f9", name: "published", type: "boolean" as const, required: true, unique: false },
    ],
  },
];

const FRAMEWORKS: Record<string, string[]> = {
  go: ["gin", "fiber", "echo", "chi"],
  typescript: ["nestjs", "express", "fastify", "hono"],
  python: ["fastapi", "django", "litestar"],
  rust: ["axum", "actix"],
  java: ["spring", "quarkus"],
  kotlin: ["ktor", "spring-kt"],
};

const API_MODES = ["rest", "grpc", "graphql"] as const;

type TestCombo = {
  language: string;
  framework: string;
  api: string;
  label: string;
};

function buildCombos(): TestCombo[] {
  const combos: TestCombo[] = [];
  for (const [lang, frameworks] of Object.entries(FRAMEWORKS)) {
    for (const fw of frameworks) {
      for (const api of API_MODES) {
        combos.push({
          language: lang,
          framework: fw,
          api,
          label: `${lang}-${fw}-${api}`,
        });
      }
    }
  }
  return combos;
}

// ─── Snapshot helpers ───────────────────────────────────────────────────────

type Manifest = { path: string; lines: number; size: number }[];

function buildManifest(files: { path: string; content: string }[]): Manifest {
  return files.map((f) => ({
    path: f.path,
    lines: f.content.split("\n").length,
    size: f.content.length,
  }));
}

function snapshotPath(label: string): string {
  return resolve(SNAPSHOT_DIR, `${label}.manifest.json`);
}

function contentSnapshotPath(label: string): string {
  return resolve(SNAPSHOT_DIR, `${label}.content.json`);
}

function readSnapshot(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeSnapshot(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, "utf-8");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

before(() => {
  if (UPDATE) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    console.log("  ⟳ UPDATE_SNAPSHOTS=1 — writing new snapshots\n");
  }
});

const combos = buildCombos();

describe("Generator snapshot tests", () => {
  for (const combo of combos) {
    describe(combo.label, () => {
      const config = {
        ...BASE_CONFIG,
        language: combo.language as "go",
        framework: combo.framework,
        api: combo.api as "rest",
      };

      let files: { path: string; content: string }[];

      it("generates without throwing", () => {
        files = generate(config, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
        assert.ok(files.length > 0, "should produce at least one file");
      });

      it("file manifest matches snapshot", () => {
        const manifest = buildManifest(files);
        const serialized = JSON.stringify(manifest, null, 2) + "\n";
        const snapFile = snapshotPath(combo.label);

        if (UPDATE) {
          writeSnapshot(snapFile, serialized);
          return;
        }

        const existing = readSnapshot(snapFile);
        if (existing === null) {
          writeSnapshot(snapFile, serialized);
          return;
        }

        assert.equal(
          serialized,
          existing,
          `Manifest mismatch for ${combo.label}. Run with UPDATE_SNAPSHOTS=1 to update.`
        );
      });

      it("content snapshot matches", () => {
        const contentMap: Record<string, string> = {};
        for (const f of files) {
          contentMap[f.path] = f.content;
        }
        const serialized = JSON.stringify(contentMap, null, 2) + "\n";
        const snapFile = contentSnapshotPath(combo.label);

        if (UPDATE) {
          writeSnapshot(snapFile, serialized);
          return;
        }

        const existing = readSnapshot(snapFile);
        if (existing === null) {
          writeSnapshot(snapFile, serialized);
          return;
        }

        assert.equal(
          serialized,
          existing,
          `Content mismatch for ${combo.label}. Run with UPDATE_SNAPSHOTS=1 to update.`
        );
      });

      it("all paths are POSIX (forward slashes)", () => {
        for (const f of files) {
          assert.ok(!f.path.includes("\\"), `path has backslash: ${f.path}`);
        }
      });

      it("no empty files (except __init__.py)", () => {
        for (const f of files) {
          if (f.path.endsWith("__init__.py")) continue;
          assert.ok(f.content.length > 0, `empty file: ${f.path}`);
        }
      });

      it("includes Dockerfile when docker=true", () => {
        const hasDf = files.some((f) => f.path === "Dockerfile");
        assert.ok(hasDf, "missing Dockerfile");
      });

      it("includes k8s manifests when kubernetes=true", () => {
        const hasK8s = files.some((f) => f.path.startsWith("deploy/k8s/"));
        assert.ok(hasK8s, "missing k8s manifests");
      });

      it("includes Helm chart when helm=true", () => {
        const hasHelm = files.some((f) => f.path.startsWith("deploy/helm/"));
        assert.ok(hasHelm, "missing Helm chart");
      });

      it("includes CI workflow", () => {
        const hasCi = files.some((f) => f.path.includes(".github/workflows/"));
        assert.ok(hasCi, "missing CI workflow");
      });

      it("README is present", () => {
        const hasReadme = files.some((f) => f.path === "README.md");
        assert.ok(hasReadme, "missing README.md");
      });

      it("no duplicate paths", () => {
        const paths = files.map((f) => f.path);
        const unique = new Set(paths);
        assert.equal(paths.length, unique.size, `duplicate paths: ${paths.filter((p, i) => paths.indexOf(p) !== i).join(", ")}`);
      });

      it("files are sorted by path", () => {
        const paths = files.map((f) => f.path);
        const sorted = [...paths].sort((a, b) => a.localeCompare(b));
        assert.deepStrictEqual(paths, sorted, "files not sorted by path");
      });
    });
  }
});

describe("Generator invariants", () => {
  it("minimal config (no k8s, no helm, no docker) generates", () => {
    const config = {
      ...BASE_CONFIG,
      language: "go" as const,
      framework: "gin",
      api: "rest" as const,
      docker: false,
      kubernetes: false,
      helm: false,
      tracing: false,
      rateLimit: false,
      audit: false,
      autoscale: false,
      replicas: 1,
      auth: "none",
      cache: "none",
      queue: "none",
      monitoring: "none",
      database: "none",
    };
    const files = generate(config, []);
    assert.ok(files.length > 0, "should produce files even with minimal config");
    assert.ok(!files.some((f) => f.path === "docker-compose.yml"), "should not have docker-compose.yml when docker=false");
  });

  // The Python SDK ships in every repo with endpoints; a syntax error there broke the
  // python smoke build, and a hyphenated filename makes it unimportable.
  it("Python client SDK is importable and has no duplicate `self`", () => {
    const config = { ...BASE_CONFIG, name: "my-app", language: "python" as const, framework: "fastapi", api: "rest" as const };
    const endpoints = [
      { id: "1", method: "GET" as const, path: "/health", summary: "Health", auth: false },
      { id: "2", method: "POST" as const, path: "/users/:id", summary: "Update", auth: true },
    ];
    const sdk = generate(config, endpoints).find((f) => f.path.startsWith("sdk/") && f.path.endsWith(".py"));
    assert.ok(sdk, "should emit a Python SDK");
    assert.match(sdk.path, /^sdk\/[A-Za-z_][A-Za-z0-9_]*\.py$/, "SDK filename must be a valid Python module name");
    assert.ok(!/\bself,\s*self\b/.test(sdk.content), "SDK methods must not declare `self` twice");
  });

  // Optional entity fields used to emit `val x: T?, = null` (a Kotlin syntax error) and a
  // non-nullable Exposed column, so every Kotlin repo with an optional field failed to build.
  it("Kotlin optional entity fields are `T? = null` with a nullable column", () => {
    const entities = [{
      id: "e1", name: "Item", fields: [
        { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
        { id: "f2", name: "score", type: "number" as const, required: false, unique: false },
      ],
    }];
    for (const framework of ["ktor", "spring-kt"]) {
      const config = { ...BASE_CONFIG, language: "kotlin" as const, framework, api: "rest" as const };
      const kt = generate(config, [], entities).filter((f) => f.path.endsWith(".kt")).map((f) => f.content).join("\n");
      assert.ok(!/\?,\s*=\s*null/.test(kt), `${framework}: default must precede the comma`);
      assert.match(kt, /val score: Double\? = null,/, `${framework}: optional number field`);
      if (framework === "ktor") assert.match(kt, /double\("score"\)\.nullable\(\)/, "ktor: optional column must be nullable");
    }
  });

  // gin/chi response helpers don't return, so a cache hit used to fall through to the DB
  // lookup and write a second response.
  it("Go cache_read stops after a cache hit on every framework", () => {
    const endpoints = [{ id: "1", method: "GET" as const, path: "/items/:id", summary: "Get", auth: false, pattern: "cache_read" }];
    for (const framework of ["gin", "fiber", "echo", "chi"]) {
      const config = { ...BASE_CONFIG, language: "go" as const, framework, api: "rest" as const, cache: "redis" };
      const go = generate(config, endpoints).filter((f) => f.path.endsWith(".go")).map((f) => f.content).join("\n");
      const hit = go.match(/jsonErr == nil \{\n\s*(.+)\n\s*(.+)/);
      assert.ok(hit, `${framework}: cache hit branch not found`);
      assert.ok(hit[1].startsWith("return") || hit[2].trim() === "return", `${framework}: cache hit must return`);
    }
  });

  it("generates with empty endpoints", () => {
    const config = { ...BASE_CONFIG, language: "typescript" as const, framework: "express", api: "rest" as const };
    const files = generate(config, []);
    assert.ok(files.length > 0);
  });

  it("generates with many endpoints", () => {
    const config = { ...BASE_CONFIG, language: "python" as const, framework: "fastapi", api: "rest" as const };
    const manyEps = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      method: (["GET", "POST", "PUT", "DELETE"] as const)[i % 4],
      path: `/resource-${i}`,
      summary: `Operation ${i}`,
      auth: i % 2 === 0,
    }));
    const files = generate(config, manyEps);
    assert.ok(files.length > 0);
  });

  it("generates with entities but no endpoints", () => {
    const config = { ...BASE_CONFIG, language: "java" as const, framework: "spring", api: "rest" as const };
    const files = generate(config, [], SAMPLE_ENTITIES);
    assert.ok(files.some((f) => f.path.includes("migration")), "should include migration files when entities are provided");
  });

  it("grpc on unsupported language falls back gracefully", () => {
    const config = { ...BASE_CONFIG, language: "rust" as const, framework: "axum", api: "grpc" as const };
    const files = generate(config, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(files.length > 0);
    assert.ok(!files.some((f) => f.path.endsWith(".proto")), "should not emit .proto for unsupported language");
  });

  it("grpc on supported language emits proto + buf", () => {
    const config = { ...BASE_CONFIG, language: "go" as const, framework: "gin", api: "grpc" as const };
    const files = generate(config, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(files.some((f) => f.path.endsWith(".proto")), "should emit .proto for supported language");
    assert.ok(files.some((f) => f.path.includes("buf")), "should emit buf config");
  });

  it("different auth providers don't crash", () => {
    for (const auth of ["clerk", "auth0", "cognito", "firebase", "keycloak", "supabase", "none"]) {
      const config = { ...BASE_CONFIG, language: "go" as const, framework: "gin", api: "rest" as const, auth };
      const files = generate(config, SAMPLE_ENDPOINTS);
      assert.ok(files.length > 0, `failed for auth=${auth}`);
    }
  });

  it("different databases don't crash", () => {
    for (const database of ["postgres", "mysql", "mongodb", "sqlite", "neon", "none"]) {
      const config = { ...BASE_CONFIG, language: "typescript" as const, framework: "express", api: "rest" as const, database };
      const files = generate(config, SAMPLE_ENDPOINTS);
      assert.ok(files.length > 0, `failed for database=${database}`);
    }
  });

  it("env vars with secrets are redacted in .env.example", () => {
    const config = {
      ...BASE_CONFIG,
      language: "go" as const,
      framework: "gin",
      api: "rest" as const,
      envVars: [
        { key: "API_KEY", value: "sk-1234567890abcdefghijklmnop", secret: true },
        { key: "APP_PORT", value: "8080" },
      ],
    };
    const files = generate(config, []);
    const envExample = files.find((f) => f.path === ".env.example");
    assert.ok(envExample, "missing .env.example");
    assert.ok(!envExample.content.includes("sk-1234567890"), "secret value leaked into .env.example");
  });
});

// ─── Stack-option wiring ────────────────────────────────────────────────────
// Principle: every builder option produces real config or isn't claimed.


function gen(overrides: Record<string, unknown>, endpoints = SAMPLE_ENDPOINTS, entities: typeof SAMPLE_ENTITIES = []) {
  const config = { ...BASE_CONFIG, language: "go", framework: "gin", api: "rest", ...overrides };
  const files = generate(config as never, endpoints, entities);
  const get = (p: string) => files.find((f) => f.path === p)?.content;
  return { files, get };
}

// Top-level service names in a compose file we emitted (2-space indented keys).
function composeServiceNames(compose: string): Set<string> {
  const body = compose.split("\nvolumes:")[0];
  return new Set([...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]));
}

function composeDependsOn(compose: string): string[] {
  const m = compose.match(/depends_on:\n((?: {6}.*\n| {8}.*\n)+)/);
  return m ? [...m[1].matchAll(/^ {6}([a-z0-9-]+):$/gm)].map((x) => x[1]) : [];
}

describe("Stack-option wiring", () => {
  it("docker-compose depends_on only references services that exist, for every db/cache/queue/monitoring option", () => {
    // A dangling depends_on makes `docker compose up` fail outright.
    for (const database of databases.map((o) => o.id)) {
      for (const cache of caches.map((o) => o.id)) {
        for (const queue of queues.map((o) => o.id)) {
          for (const monitoring of monitoringOptions.map((o) => o.id)) {
            const g = gen({ database, cache, queue, monitoring });
            const compose = g.get("docker-compose.yml")!;
            const services = composeServiceNames(compose);
            for (const dep of composeDependsOn(compose)) {
              assert.ok(services.has(dep), `${database}/${cache}/${queue}/${monitoring}: depends_on ${dep} has no service`);
            }
            for (const vol of compose.matchAll(/\.\/(deploy\/[^:]+):/g)) {
              assert.ok(g.get(vol[1]), `compose mounts missing file ${vol[1]}`);
            }
          }
        }
      }
    }
  });

  it("dynamodb, sqs and bullmq get local services the api can reach", () => {
    const compose = gen({ database: "dynamodb", queue: "sqs" }).get("docker-compose.yml")!;
    assert.ok(composeServiceNames(compose).has("dynamodb"));
    assert.ok(composeServiceNames(compose).has("sqs"));
    assert.match(compose, /AWS_ENDPOINT_URL_DYNAMODB: "http:\/\/dynamodb:8000"/);
    const bull = gen({ cache: "memcached", queue: "bullmq" }).get("docker-compose.yml")!;
    assert.ok(composeServiceNames(bull).has("redis"), "bullmq needs redis even when the cache isn't redis");
  });

  it("gitlab-ci / circleci replace GitHub Actions; argo adds an Application alongside it", () => {
    const gl = gen({ cicd: "gitlab-ci" });
    assert.ok(gl.get(".gitlab-ci.yml")?.includes("$CI_REGISTRY_IMAGE"));
    assert.ok(!gl.get(".github/workflows/ci.yml"), "gitlab stack should not ship a GitHub workflow");
    assert.ok(gen({ cicd: "circleci" }).get(".circleci/config.yml")?.includes("version: 2.1"));
    const argo = gen({ cicd: "argo" });
    assert.ok(argo.get("deploy/argocd/application.yaml")?.includes("kind: Application"));
    assert.ok(argo.get(".github/workflows/ci.yml"), "argo is CD only; CI still needs to build the image");
  });

  it("cloud deployments emit real IaC driven by region/replicas/scaling", () => {
    const aws = JSON.parse(gen({ deployment: "aws" }).get("deploy/aws/task-definition.json")!);
    assert.deepEqual(aws.requiresCompatibilities, ["FARGATE"]);
    const gcp = gen({ deployment: "gcp", scaling: "serverless" }).get("deploy/gcp/service.yaml")!;
    assert.match(gcp, /minScale: "0"/, "serverless should scale to zero");
    assert.ok(!/name: PORT\n/.test(gcp), "PORT is reserved on Cloud Run");
    assert.match(gen({ deployment: "azure", replicas: 3 }).get("deploy/azure/containerapp.yaml")!, /minReplicas: 3/);
    const vertical = gen({ scaling: "vertical" });
    assert.ok(vertical.get("deploy/k8s/vpa.yaml") && !vertical.get("deploy/k8s/hpa.yaml"), "HPA and VPA must not both target CPU");
  });

  it("README only claims tracing/rate limiting where the language implements it", () => {
    for (const [language, framework] of [["rust", "axum"], ["java", "quarkus"], ["kotlin", "ktor"]]) {
      const readme = gen({ language, framework }).get("README.md")!;
      assert.ok(!readme.includes("traces are exported via OTLP"), `${language} README over-claims tracing`);
      assert.ok(!readme.includes("rate limiting is enabled"), `${language} README over-claims rate limiting`);
    }
    assert.ok(gen({}).get("README.md")!.includes("traces are exported via OTLP"));
    assert.ok(gen({}).get(".env.example")!.includes("OTEL_EXPORTER_OTLP_ENDPOINT="));
    assert.ok(!gen({ language: "rust", framework: "axum" }).get(".env.example")!.includes("OTEL_EXPORTER_OTLP_ENDPOINT"));
  });

  it("otel monitoring ships a collector the api exports to", () => {
    const g = gen({ monitoring: "otel" });
    assert.ok(g.get("deploy/otel-collector.yaml")?.includes("otlp"));
    assert.match(g.get("docker-compose.yml")!, /OTEL_EXPORTER_OTLP_ENDPOINT: "http:\/\/otel-collector:4318"/);
  });

  it("auth:true endpoints are protected on Rust, Quarkus and Ktor", () => {
    const eps = [
      { id: "1", method: "GET" as const, path: "/me", summary: "Me", auth: true },
      { id: "2", method: "GET" as const, path: "/ping", summary: "Ping", auth: false },
    ];
    const axum = gen({ language: "rust", framework: "axum" }, eps);
    assert.ok(axum.get("src/auth.rs")?.includes("jwk::JwkSet"));
    assert.match(axum.get("src/main.rs")!, /let protected = Router::new\(\)\n\s+\.route\("\/me"[\s\S]*route_layer/);
    const actix = gen({ language: "rust", framework: "actix" }, eps);
    assert.match(actix.get("src/main.rs")!, /from_fn\(auth::require_auth\)\)\n\s+\.route\("\/me"/);
    const quarkus = gen({ language: "java", framework: "quarkus" }, eps);
    assert.match(quarkus.get("src/main/java/dev/helios/app/ApiResource.java")!, /@Path\("\/me"\)\n\s+@Authenticated/);
    assert.ok(!/@Path\("\/ping"\)\n\s+@Authenticated/.test(quarkus.get("src/main/java/dev/helios/app/ApiResource.java")!));
    assert.ok(quarkus.get("pom.xml")!.includes("quarkus-smallrye-jwt"));
    const ktor = gen({ language: "kotlin", framework: "ktor" }, eps);
    assert.match(ktor.get("src/main/kotlin/Application.kt")!, /authenticate\("auth-jwt"\) \{\n\s+get\("\/me"\)/);
    assert.ok(ktor.get("src/main/kotlin/Auth.kt")?.includes("JwkProviderBuilder"));
  });

  it("mysql/planetscale use MySQL drivers on Rust, Java and Kotlin", () => {
    for (const database of ["mysql", "planetscale"]) {
      assert.ok(gen({ database, language: "rust", framework: "axum" }).get("Cargo.toml")!.includes(`"mysql"`));
      const spring = gen({ database, language: "java", framework: "spring" });
      assert.ok(spring.get("pom.xml")!.includes("mysql-connector-j") && !spring.get("pom.xml")!.includes("org.postgresql"));
      assert.ok(gen({ database, language: "java", framework: "quarkus" }).get("pom.xml")!.includes("quarkus-jdbc-mysql"));
      assert.ok(gen({ database, language: "kotlin", framework: "ktor" }).get("build.gradle.kts")!.includes("mysql-connector-j"));
      assert.ok(gen({ database, language: "kotlin", framework: "spring-kt" }).get("build.gradle.kts")!.includes("flyway-mysql"));
    }
    // MySQL has no RETURNING — the sqlx handlers must not use it.
    const handler = gen({ database: "mysql", language: "rust", framework: "axum" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("src/handlers/user.rs")!;
    assert.ok(!handler.includes("RETURNING") && !handler.includes("$1"));
  });

  it("grafana monitoring exposes Prometheus metrics on Rust/Java/Kotlin at the scraped path", () => {
    const cases: [string, string, string, string][] = [
      ["java", "spring", "pom.xml", "/actuator/prometheus"],
      ["java", "quarkus", "pom.xml", "/q/metrics"],
      ["kotlin", "ktor", "build.gradle.kts", "/metrics"],
      ["rust", "axum", "Cargo.toml", "/metrics"],
    ];
    for (const [language, framework, build, path] of cases) {
      const g = gen({ language, framework, monitoring: "grafana" });
      assert.match(g.get(build)!, /prometheus/, `${framework} build file lacks a Prometheus registry`);
      assert.ok(g.get("deploy/prometheus.yml")!.includes(`metrics_path: '${path}'`), `${framework} scrape path`);
    }
  });

  it("Quarkus, Ktor and Spring-kt emit stubs for custom endpoints", () => {
    const eps = [{ id: "1", method: "POST" as const, path: "/orders", summary: "Create", auth: false }];
    assert.ok(gen({ language: "java", framework: "quarkus" }, eps).get("src/main/java/dev/helios/app/ApiResource.java")?.includes('@Path("/orders")'));
    assert.ok(gen({ language: "kotlin", framework: "ktor" }, eps).get("src/main/kotlin/Application.kt")?.includes('post("/orders")'));
    assert.ok(gen({ language: "kotlin", framework: "spring-kt" }, eps).files.some((f) => f.path.endsWith("/ApiController.kt") && f.content.includes('@PostMapping("/orders")')));
  });

  it("Go auth patterns stay consistent with the token verifier authRequired uses", () => {
    const eps = [
      { id: "1", method: "POST" as const, path: "/auth/login", summary: "Login", auth: false, pattern: "auth_login" },
      { id: "2", method: "GET" as const, path: "/auth/me", summary: "Me", auth: true, pattern: "auth_me" },
    ];
    // Self-managed: login mints HS256 tokens, so the verifier must be HS256 with the same secret.
    const self = gen({ auth: "none" }, eps, SAMPLE_ENTITIES);
    assert.match(self.get("internal/auth/jwt.go")!, /WithValidMethods\(\[\]string\{"HS256"\}\)/);
    assert.match(self.get("internal/handlers/api.go")!, /SigningMethodHS256/);
    assert.match(self.get(".env.example")!, /^JWT_SECRET=/m);
    // External provider: tokens come from the provider (JWKS); the service must not mint its own.
    const clerk = gen({ auth: "clerk" }, eps, SAMPLE_ENTITIES);
    assert.match(clerk.get("internal/auth/jwt.go")!, /jwk\.NewCache/);
    const api = clerk.get("internal/handlers/api.go")!;
    assert.ok(!api.includes("SigningMethodHS256") && api.includes("handled_by_clerk"));
    assert.match(api, /auth\.FromContext/);
  });

  it("Ktor tests load the application module (otherwise every route 404s)", () => {
    const ktor = gen({ language: "kotlin", framework: "ktor" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const app = ktor.get("src/main/kotlin/Application.kt")!;
    assert.match(app, /fun Application\.module\((jwtVerifier: JWTVerifier\? = null)?\)[\s\S]*routing \{/);
    assert.match(app, /embeddedServer\(Netty, .*module = Application::module\)/);
    const test = ktor.get("src/test/kotlin/UserRouteTest.kt")!;
    assert.equal(test.match(/application \{ testModule\(\) \}/g)?.length, test.match(/testApplication \{/g)?.length);
    assert.match(ktor.get("src/test/kotlin/TestSupport.kt")!, /fun Application\.testModule\(\) \{[\s\S]*module\(/);
  });

  it("Spring tests authenticate with jwt() when routes are protected, and not otherwise", () => {
    const cases: [string, string, string, string][] = [
      ["java", "spring", "pom.xml", "src/test/java/dev/helios/app/UserControllerTest.java"],
      ["kotlin", "spring-kt", "build.gradle.kts", "src/test/kotlin/dev/helios/test_app/UserControllerTest.kt"],
    ];
    for (const [language, framework, build, testPath] of cases) {
      const secured = gen({ language, framework, auth: "clerk" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const test = secured.get(testPath)!;
      // Every request must carry a JWT, or anyRequest().authenticated() answers 401.
      assert.equal(test.match(/\.with\(jwt\(\)\)/g)?.length, test.match(/mvc\.perform/g)?.length, framework);
      assert.ok(test.includes("JwtDecoder"), `${framework}: decoder must be mocked (no live JWKS in tests)`);
      assert.ok(secured.get(build)!.includes("spring-security-test"), framework);
      const open = gen({ language, framework, auth: "none" }, SAMPLE_ENDPOINTS.map((e) => ({ ...e, auth: false })), SAMPLE_ENTITIES);
      assert.ok(!open.get(testPath)!.includes("jwt()"), `${framework}: no security on classpath without auth`);
    }
  });

  it("Rust number fields decode the DOUBLE columns the migrations create", () => {
    const ents = [{ id: "e", name: "Item", fields: [
      { id: "1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "2", name: "price", type: "number" as const, required: true, unique: false },
    ] }];
    const rust = gen({ language: "rust", framework: "axum" }, SAMPLE_ENDPOINTS, ents);
    const migration = rust.files.find((f) => f.path.includes("migrations/") && f.content.includes("price"))!;
    assert.match(migration.content, /price DOUBLE PRECISION/);
    const model = rust.files.find((f) => f.path.endsWith(".rs") && /pub price: /.test(f.content))!;
    assert.match(model.content, /pub price: f64/);
    assert.ok(!rust.files.some((f) => /price: (Option<)?i64/.test(f.content)), "i64 cannot decode DOUBLE PRECISION");
  });

  it("Python auth patterns match the token verifier auth_required uses, and every name they use is defined", () => {
    const eps = ["auth_login", "auth_register", "auth_me", "auth_logout", "auth_refresh", "auth_change_password"].map((pattern, i) => ({
      id: String(i), method: (pattern === "auth_me" ? "GET" : "POST") as "GET" | "POST", path: `/auth/${pattern.slice(5)}`, summary: pattern, auth: false, pattern,
    }));
    const users = [{ id: "u", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f3", name: "password_hash", type: "string" as const, required: false, unique: false },
    ] }];
    const py = (auth: string) => gen({ auth, language: "python", framework: "fastapi" }, eps, users);
    // Self-managed: handlers mint HS256 tokens with JWT_SECRET, so auth_required must verify HS256 with the same secret.
    const self = py("none");
    assert.match(self.get("app/auth.py")!, /algorithms=\["HS256"\]/);
    assert.match(self.get("app/auth.py")!, /JWT_SECRET/);
    const main = self.get("app/main.py")!;
    assert.ok(main.includes("create_access_token(") && !/passlib|from jose/.test(main));
    // A name used in a handler signature/body but never imported or defined is a NameError at import time.
    for (const name of ["Credentials", "RefreshRequest", "ChangePasswordRequest", "bcrypt", "verify_token", "auth_required", "get_db", "Session", "User", "_DUMMY_HASH"]) {
      assert.match(main, new RegExp(`^(from \\S+ import .*\\b${name}\\b|import ${name}\\b|class ${name}\\b|${name} = )`, "m"), `${name} used but not defined`);
    }
    assert.match(self.get("pyproject.toml")!, /^bcrypt = /m);
    // External provider: tokens come from the provider (JWKS); the service must not mint its own.
    const clerk = py("clerk");
    assert.match(clerk.get("app/auth.py")!, /PyJWKClient/);
    const cmain = clerk.get("app/main.py")!;
    assert.ok(cmain.includes('detail="handled_by_clerk"') && !cmain.includes("create_access_token"));
    assert.match(cmain, /claims: dict = Depends\(auth_required\)/);
  });

  it("Python CRUD pattern handlers take the path parameter the route declares", () => {
    // FastAPI binds {id} only to a parameter named id — anything else becomes a required query param (422).
    const eps = (["GET", "PATCH", "DELETE"] as const).map((method, i) => ({
      id: String(i), method, path: "/users/:id", summary: "x", auth: false, pattern: ({ GET: "crud_get", PATCH: "crud_update", DELETE: "crud_delete" } as const)[method],
    }));
    const main = gen({ language: "python", framework: "fastapi" }, eps, [SAMPLE_ENTITIES.find((e) => e.name === "User")!]).get("app/main.py")!;
    for (const method of ["get", "patch", "delete"]) {
      assert.match(main, new RegExp(`@app\\.${method}\\("/users/\\{id\\}"[^\\n]*\\)\\nasync def \\w+\\(id: str`), `${method} handler param`);
    }
    assert.ok(!main.includes("item_id"));
  });

  it("NestJS renders endpoint patterns with the same handler bodies as Express", () => {
    const eps = [{ id: "1", method: "GET" as const, path: "/users/:id", summary: "Get", auth: true, pattern: "crud_get" }];
    const users = [SAMPLE_ENTITIES.find((e) => e.name === "User")!];
    const ctrl = gen({ language: "typescript", framework: "nestjs" }, eps, users).get("src/app.controller.ts")!;
    const express = gen({ language: "typescript", framework: "express" }, eps, users).get("src/main.ts")!;
    // A pattern must not degrade to the { ok: true } stub on Nest.
    assert.ok(!ctrl.includes('op: "GET /users/:id"'));
    assert.match(ctrl, /async getUsersById\(@Req\(\) req: Request, @Res\(\) res: Response\)/);
    assert.ok(ctrl.includes("prisma.user.findUnique") && express.includes("prisma.user.findUnique"));
    assert.ok(ctrl.includes('import { prisma } from "./db";'));
    // Protected pattern routes are guarded just like Express mounts authRequired.
    assert.match(ctrl, /@UseGuards\(JwtAuthGuard\)\n\s+async getUsersById/);
  });

  it("Go migrate command matches the database driver and handles config errors", () => {
    const main = (database: string) => gen({ database }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("cmd/migrate/main.go")!;
    assert.match(main("postgres"), /migrate\/v4\/database\/postgres"/);
    assert.match(main("cockroach"), /migrate\/v4\/database\/cockroachdb"/);
    assert.match(main("mysql"), /migrate\/v4\/database\/mysql"/);
    assert.match(main("sqlite"), /migrate\/v4\/database\/sqlite"/);
    assert.match(main("postgres"), /cfg, err := config\.Load\(\)/);
    // Pure-Go sqlite so CGO_ENABLED=0 Docker builds work.
    assert.ok(gen({ database: "sqlite" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/db/gorm.go")!.includes("github.com/glebarez/sqlite"));
  });
});

// ─── gRPC / GraphQL / tRPC honor the cross-cutting flags ────────────────────
// These trees used to ignore rateLimit / audit / tracing / monitoring while
// REST honored them, so the same builder toggles silently meant nothing.

describe("Non-REST APIs honor rateLimit / audit / tracing / monitoring", () => {
  const OFF = { rateLimit: false, audit: false, tracing: false, monitoring: "none" };

  it("Go go.mod requires every external module the grpc/graphql code imports (else `go build` fails)", () => {
    for (const api of ["grpc", "graphql"]) {
      for (const framework of ["gin", "fiber", "echo", "chi"]) {
        for (const monitoring of ["grafana", "sentry", "datadog"]) {
          const { files, get } = gen({ api, framework, monitoring }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
          const required = [...get("go.mod")!.matchAll(/^\t(\S+) v/gm)].map((m) => m[1]);
          for (const f of files.filter((x) => x.path.endsWith(".go"))) {
            for (const [, path] of f.content.matchAll(/^\s*(?:[\w.]+\s+)?"([a-z0-9.-]+\.[a-z]{2,}\/[^"]+)"$/gm)) {
              if (path.startsWith("github.com/your-username/")) continue;
              assert.ok(required.some((m) => path === m || path.startsWith(m + "/")),
                `${api}/${framework}/${monitoring}: ${f.path} imports ${path} but go.mod does not require it`);
            }
          }
          assert.ok(required.includes("github.com/caarlos0/env/v11"), "internal/config imports caarlos0/env");
          assert.ok(required.includes("github.com/golang-migrate/migrate/v4"), "cmd/migrate imports golang-migrate");
        }
      }
    }
  });

  it("Go gRPC chains rate-limit + audit interceptors and otelgrpc only when the flags are on", () => {
    const on = gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const main = on.get("cmd/api/main.go")!;
    assert.match(main, /grpc\.ChainUnaryInterceptor\([\s\S]*grpcserver\.Metrics\(\)[\s\S]*grpcserver\.RateLimit\(\)[\s\S]*grpcserver\.Audit\(log\)/);
    assert.match(main, /grpc\.StatsHandler\(otelgrpc\.NewServerHandler\(\)\)/);
    assert.match(main, /tracing\.Init\(/);
    assert.match(main, /promhttp\.Handler\(\)/, "Prometheus needs an HTTP listener; the gRPC port can't serve /metrics");
    assert.match(on.get("internal/grpcserver/interceptors.go")!, /codes\.ResourceExhausted/);
    assert.ok(on.get("internal/grpcserver/ratelimit_test.go"), "the limiter keeps its unit test");

    const off = gen({ api: "grpc", ...OFF }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(!off.get("internal/grpcserver/interceptors.go"));
    assert.ok(!off.get("internal/tracing/tracing.go"));
    assert.match(off.get("cmd/api/main.go")!, /grpcSrv := grpc\.NewServer\(\)/);
  });

  it("Go GraphQL is mounted on the REST router after its middleware chain", () => {
    for (const framework of ["gin", "fiber", "echo", "chi"]) {
      const server = gen({ api: "graphql", framework }).get("internal/server/server.go")!;
      const use = server.indexOf("\tr.Use(");
      assert.ok(use >= 0 && server.indexOf("mountGraphQL(r)") > use, `${framework}: GraphQL must be mounted after r.Use`);
      assert.match(server.slice(use), /^\tr\.Use\([^\n]*tracing\.Middleware[^\n]*rateLimit\(\)[^\n]*auditLog\(log\)/);
      assert.match(server, /monitoring\.MountMetrics\(r\)/);
    }
  });

  it("TypeScript GraphQL and tRPC mount after the REST middleware, with tracing imported first", () => {
    const cases: [string, string, string][] = [
      ["graphql", "express", "app.use(yoga.graphqlEndpoint, yoga)"],
      ["graphql", "nestjs", "app.use(yoga.graphqlEndpoint, yoga)"],
      ["graphql", "fastify", "url: yoga.graphqlEndpoint"],
      ["graphql", "hono", "yoga.fetch(c.req.raw)"],
      ["trpc", "express", `app.use("/trpc"`],
    ];
    for (const [api, framework, mount] of cases) {
      const g = gen({ language: "typescript", framework, api });
      const main = g.get("src/main.ts")!;
      const at = main.indexOf(mount);
      assert.ok(main.startsWith(`import "./tracing";`), `${api}/${framework}: tracing must load before the framework`);
      assert.ok(g.get("src/tracing.ts"));
      assert.ok(at > 0, `${api}/${framework}: missing mount`);
      const limiter = ["app.use(rateLimit)", "app.register(rateLimit", "rate_limited"].map((s) => main.indexOf(s)).find((i) => i >= 0);
      assert.ok(limiter !== undefined && limiter < at, `${api}/${framework}: rate limit must run before the mount`);
      assert.match(main.slice(0, at), /audit/, `${api}/${framework}: audit must run before the mount`);
      assert.match(main, /\/metrics/);
      assert.ok(JSON.parse(g.get("package.json")!).dependencies["@opentelemetry/sdk-node"]);
    }
  });

  it("TypeScript gRPC installs interceptors and the REST instrumentation preamble", () => {
    const g = gen({ language: "typescript", framework: "express", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const main = g.get("src/main.ts")!;
    assert.ok(main.startsWith(`import "./tracing.js";`), "ESM needs the .js suffix and tracing must load first");
    assert.match(main, /new grpc\.Server\(\{ interceptors \}\)/);
    assert.match(main, /METRICS_PORT/);
    assert.match(g.get("src/interceptors.ts")!, /\[metrics, rateLimit, audit\]/);
    const deps = JSON.parse(g.get("package.json")!).dependencies;
    assert.ok(deps["prom-client"] && deps["@opentelemetry/sdk-node"]);

    const off = gen({ language: "typescript", framework: "express", api: "grpc", ...OFF }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(!off.get("src/interceptors.ts") && !off.get("src/tracing.ts"));
    assert.match(off.get("src/main.ts")!, /new grpc\.Server\(\)/);
  });

  it("Python GraphQL mounts Strawberry after the FastAPI middleware; Python gRPC wires interceptors", () => {
    const main = gen({ language: "python", framework: "fastapi", api: "graphql" }).get("app/main.py")!;
    const at = main.indexOf(`app.include_router(GraphQLRouter(schema)`);
    for (const mw of ["SlowAPIMiddleware", "AuditMiddleware", "FastAPIInstrumentor.instrument_app", "Instrumentator().instrument(app)"]) {
      const i = main.indexOf(mw);
      assert.ok(i >= 0 && i < at, `${mw} must be wired before the GraphQL router`);
    }

    const g = gen({ language: "python", framework: "fastapi", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const grpcMain = g.get("app/main.py")!;
    assert.match(grpcMain, /interceptors=\[server_interceptor\(\), MetricsInterceptor\(\), RateLimitInterceptor\(\), AuditInterceptor\(\)\]/);
    assert.match(grpcMain, /start_http_server\(/);
    assert.match(grpcMain, /from test_app\.v1 import service_pb2_grpc/, "stubs are importable from gen/python on PYTHONPATH");
    assert.match(grpcMain, /service_pb2_grpc\.add_UserServiceServicer_to_server/);
    assert.ok(g.get("app/tracing.py") && g.get("app/interceptors.py")!.includes("RESOURCE_EXHAUSTED"));
    assert.match(g.get("pyproject.toml")!, /opentelemetry-instrumentation-grpc/);

    const off = gen({ language: "python", framework: "fastapi", api: "grpc", ...OFF }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(!off.get("app/interceptors.py") && !off.get("app/tracing.py"));
  });

  // The generated proto is all unary, but interceptors exist to protect
  // user-added RPCs too: a streaming method must not bypass rate limit / audit / metrics.
  it("gRPC servers apply the cross-cutting interceptors to streaming RPCs as well as unary", () => {
    const go = gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const main = go.get("cmd/api/main.go")!;
    assert.match(main, /grpc\.ChainStreamInterceptor\([\s\S]*grpcserver\.MetricsStream\(\)[\s\S]*grpcserver\.RateLimitStream\(\)[\s\S]*grpcserver\.AuditStream\(log\)/);
    const ic = go.get("internal/grpcserver/interceptors.go")!;
    assert.match(ic, /var limiter = newIPLimiter\(\)/, "unary and stream share one bucket per IP, else streams double a client's budget");
    assert.equal((ic.match(/limiter\.allow\(/g) ?? []).length, 2);
    const sentry = gen({ api: "grpc", monitoring: "sentry" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("cmd/api/main.go")!;
    assert.match(sentry, /ChainStreamInterceptor\(\s*grpcserver\.SentryRecoverStream\(\)/, "a panicking stream must not crash the process");
    const dd = gen({ api: "grpc", monitoring: "datadog" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("cmd/api/main.go")!;
    assert.match(dd, /grpctrace\.StreamServerInterceptor\(/);
    assert.ok(!gen({ api: "grpc", ...OFF }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("cmd/api/main.go")!.includes("ChainStreamInterceptor"));

    // Python: every handler kind is wrapped; response streams as generators so
    // audit/metrics see the final status instead of firing when the generator is created.
    const py = gen({ language: "python", framework: "fastapi", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("app/interceptors.py")!;
    for (const kind of ["unary_unary", "stream_unary", "unary_stream", "stream_stream"]) {
      assert.match(py, new RegExp(`${kind}=handler\\.${kind} and `), `${kind} handlers must be intercepted`);
    }
    assert.match(py, /with around\(context\):\n\s+yield from inner\(request, context\)/);
  });

  // Picking Fastify/Hono/NestJS with tRPC used to silently ship an Express app
  // while the README claimed the chosen framework.
  it("tRPC is served by the chosen TS framework's own adapter, behind its middleware", () => {
    const cases: [string, string, string, string][] = [
      ["fastify", "fastify", "await app.register(fastifyTRPCPlugin", "app.register(rateLimit"],
      ["hono", "hono", `app.use("/trpc/*", trpcServer({ router: appRouter }))`, "rate_limited"],
      ["nestjs", "@nestjs/core", `app.use("/trpc", rateLimit, trpcExpress.createExpressMiddleware(`, "import { rateLimit }"],
    ];
    for (const [framework, fwModule, mount, limiter] of cases) {
      const g = gen({ language: "typescript", framework, api: "trpc" });
      const main = g.get("src/main.ts")!;
      const at = main.indexOf(mount);
      assert.ok(main.includes(`from "${fwModule}"`), `${framework}: must bootstrap ${framework}, not Express`);
      assert.ok(!/from "express"/.test(main), `${framework}: must not fall back to an Express server`);
      assert.ok(at > 0, `${framework}: missing tRPC mount`);
      assert.ok(main.startsWith(`import "./tracing";`), `${framework}: tracing must load first`);
      const lim = main.indexOf(limiter);
      assert.ok(lim >= 0 && lim < at, `${framework}: rate limit must run before /trpc`);
      assert.match(main.slice(0, at), /audit/i, `${framework}: audit must run before /trpc`);
      const pkg = JSON.parse(g.get("package.json")!);
      assert.ok(pkg.dependencies["@trpc/server"].startsWith("^11"), `${framework}: tRPC v11`);
      assert.ok(pkg.dependencies[framework === "nestjs" ? "@nestjs/core" : framework]);
      assert.ok(!pkg.dependencies.express, `${framework}: no stray Express dependency`);
      assert.ok(!/express/i.test(g.get("README.md")!), `${framework}: README must not describe an Express app`);
    }
    assert.ok(JSON.parse(gen({ language: "typescript", framework: "hono", api: "trpc" }).get("package.json")!).dependencies["@hono/trpc-server"]);

    // Flags off: NestJS gets no Express limiter, and the mount still anchors.
    const off = gen({ language: "typescript", framework: "nestjs", api: "trpc", ...OFF });
    assert.ok(!off.get("src/middleware/rate-limit.ts"));
    assert.match(off.get("src/main.ts")!, /app\.use\("\/trpc", trpcExpress\.createExpressMiddleware\(/);
  });

  it("TS auth patterns stay consistent with the token verifier authRequired uses", () => {
    const eps = [
      { id: "1", method: "POST" as const, path: "/auth/login", summary: "Login", auth: false, pattern: "auth_login" },
      { id: "2", method: "GET" as const, path: "/auth/me", summary: "Me", auth: false, pattern: "auth_me" },
    ];
    const verifierPath = (fw: string) => (fw === "nestjs" ? "src/auth/jwt.guard.ts" : "src/middleware/auth.ts");
    const code = (g: ReturnType<typeof gen>) => (g.get("src/app.controller.ts") ?? "") + g.get("src/main.ts");
    for (const fw of ["express", "fastify", "hono", "nestjs"]) {
      const ts = (auth: string) => gen({ language: "typescript", framework: fw, auth }, eps);
      // Self-managed: login mints HS256 tokens with JWT_SECRET, so authRequired must verify exactly those.
      const self = ts("none");
      const selfVerifier = self.get(verifierPath(fw))!;
      assert.ok(selfVerifier, `${fw}: auth "none" + auth patterns must emit a verifier`);
      assert.match(selfVerifier, /algorithms: \["HS256"\]/, fw);
      assert.match(selfVerifier, /process\.env\.JWT_SECRET/, fw);
      assert.match(code(self), /jwt\.sign\(\{ sub: user!\.id \}, process\.env\.JWT_SECRET!/, fw);
      // auth_me reads the caller from authRequired, so it must run behind it even without e.auth.
      assert.match(code(self), fw === "nestjs" ? /@UseGuards\(JwtAuthGuard\)\n\s+async getAuthMe/ : fw === "fastify" ? /"\/auth\/me", \{ preHandler: authRequired \}/ : /"\/auth\/me", authRequired,/, fw);
      assert.match(self.get("package.json")!, /"jsonwebtoken"/, fw);
      // External provider: authRequired verifies provider JWKS tokens, so the service must not mint its own.
      const clerk = ts("clerk");
      assert.match(clerk.get(verifierPath(fw))!, /createRemoteJWKSet/, fw);
      const c = code(clerk);
      assert.ok(c.includes('error: "handled_by_clerk"') && !c.includes("jwt.sign") && !c.includes("JWT_SECRET"), fw);
      assert.match(c, /\.claims/, `${fw}: auth_me must return the provider's verified claims`);
      assert.ok(!/"(bcrypt|jsonwebtoken)"/.test(clerk.get("package.json")!), `${fw}: unused bcrypt/jsonwebtoken deps`);
    }
  });

  it("Litestar and Django serve the user's endpoints, protected by the same verifier as FastAPI", () => {
    // Before, both ignored the endpoint list: users picking them got an app with only /health.
    const eps = [
      ...SAMPLE_ENDPOINTS,
      { id: "p1", method: "GET" as const, path: "/users/search", summary: "Search", auth: false, pattern: "paginated_search" },
      { id: "p2", method: "GET" as const, path: "/auth/me", summary: "Me", auth: true, pattern: "auth_me" },
    ];
    const ls = gen({ language: "python", framework: "litestar" }, eps, SAMPLE_ENTITIES);
    const lsMain = ls.get("app/main.py")!;
    assert.match(lsMain, /@get\("\/users\/\{id:str\}", guards=\[auth_guard\]\)\nasync def get_users_by_id\(id: str\)/);
    assert.match(lsMain, /@delete\("\/users\/\{id:str\}", status_code=200, guards=\[auth_guard\]\)/);
    assert.match(lsMain, /async def get_users_search\(db: Session, q: Optional\[str\] = Parameter\(default=None\)/, "pattern body reused, db injected");
    assert.match(lsMain, /route_handlers=\[health, get_users, post_users, get_users_by_id, delete_users_by_id, get_users_search, get_auth_me,/);
    assert.equal(lsMain.match(/@get\("\/health"\)/g)!.length, 1, "the app's own /health is not re-registered");
    assert.match(ls.get("app/auth.py")!, /raise NotAuthorizedException\(detail="missing_or_malformed_token"\)/);
    assert.doesNotMatch(ls.get("app/auth.py")!, /fastapi/, "fastapi isn't a Litestar dependency");
    assert.ok(ls.get("app/db.py"), "pattern handlers need the SQLAlchemy session");

    const dj = gen({ language: "python", framework: "django" }, eps, SAMPLE_ENTITIES);
    const djMain = dj.get("app/main.py")!;
    assert.match(djMain, /path\("users\/<str:id>", _route\(GET=get_users_by_id, DELETE=delete_users_by_id\)\)/);
    assert.ok(djMain.indexOf(`path("users/search"`) < djMain.indexOf(`path("users/<str:id>"`), "static path must precede the converter that would swallow it");
    assert.match(djMain, /@_endpoint\(auth=True\)\nasync def get_users_by_id\(request, id\):/);
    assert.match(djMain, /@_endpoint\(claims=True\)\nasync def get_auth_me\(request, claims\):/);
    assert.match(djMain, /except PermissionError as exc:\n\s+return JsonResponse\(\{"detail": str\(exc\)\}, status=401\)/);
    assert.doesNotMatch(dj.get("app/auth.py")!, /fastapi/);

    // Self-issued auth (auth "none" + auth_* patterns) now reaches these frameworks too.
    assert.match(gen({ language: "python", framework: "django", auth: "none" }, eps, SAMPLE_ENTITIES).get("app/auth.py")!, /def create_access_token/);
  });

  it("Ktor tests run without Postgres: in-memory H2 with the production schema", () => {
    // Before, tests never connected a database, so every entity route threw inside transaction {}.
    for (const [database, mode] of [["postgres", "PostgreSQL"], ["mysql", "MySQL"]]) {
      const ktor = gen({ language: "kotlin", framework: "ktor", database }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      assert.match(ktor.get("build.gradle.kts")!, /testImplementation\("com\.h2database:h2:\d+\.\d+\.\d+"\)/);
      const support = ktor.get("src/test/kotlin/TestSupport.kt")!;
      assert.ok(support.includes(`jdbc:h2:mem:test;MODE=${mode};DB_CLOSE_DELAY=-1`), database);
      // Same createSchema() as production, so tests can't drift from the real tables.
      assert.match(support, /createSchema\(\)/);
      assert.match(ktor.get("src/main/kotlin/Database.kt")!, /Database\.connect\(ds\)\n\s+createSchema\(\)/);
      // H2 has no INSERT ... RETURNING; the create route must not depend on it.
      assert.ok(!ktor.get("src/main/kotlin/routes/userRoutes.kt")!.includes("insertReturning"));
    }
  });

  it("Ktor tests authenticate with a locally signed JWT instead of the provider's JWKS", () => {
    const ktor = gen({ language: "kotlin", framework: "ktor", auth: "clerk" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    // Production still verifies against the env-configured JWKS when no verifier is injected.
    const auth = ktor.get("src/main/kotlin/Auth.kt")!;
    assert.match(auth, /fun Application\.configureAuth\(jwtVerifier: JWTVerifier\? = null\)/);
    assert.match(auth, /if \(jwtVerifier != null\) \{\n\s+verifier\(jwtVerifier\)\n\s+\} else \{[\s\S]*AUTH_JWKS_URL[\s\S]*verifier\(jwkProvider, issuer\)/);
    const support = ktor.get("src/test/kotlin/TestSupport.kt")!;
    assert.match(support, /Algorithm\.RSA256\(/);
    assert.match(support, /module\(jwtVerifier = TestAuth\.verifier\)/);
    // Protected route: 401 without a token, 200 with the signed one.
    const appTest = ktor.get("src/test/kotlin/ApplicationTest.kt")!;
    assert.match(appTest, /client\.request\("\/users"\) \{ method = HttpMethod\.Get \}\n\s+assertEquals\(HttpStatusCode\.Unauthorized/);
    assert.match(appTest, /Bearer \$\{TestAuth\.token\(\)\}"\)\n\s+\}\n\s+assertEquals\(HttpStatusCode\.OK/);
    const routeTest = ktor.get("src/test/kotlin/UserRouteTest.kt")!;
    assert.equal(routeTest.match(/TestAuth\.token\(\)/g)?.length, routeTest.match(/testApplication \{/g)?.length, "entity routes sit behind auth");
    // A JSON body in a Kotlin raw string must not carry backslash escapes.
    assert.ok(!routeTest.includes('\\"'));

    const open = gen({ language: "kotlin", framework: "ktor", auth: "none" }, SAMPLE_ENDPOINTS.map((e) => ({ ...e, auth: false })), SAMPLE_ENTITIES);
    assert.ok(!open.get("src/test/kotlin/TestSupport.kt")!.includes("TestAuth"), "no JWT code without ktor-server-auth-jwt on the classpath");
    assert.ok(!open.get("src/test/kotlin/UserRouteTest.kt")!.includes("Authorization"));
  });

  it("Kotlin contract tests are native per framework, compile on the JVM, and assert auth both ways", () => {
    const contract = (framework: string, endpoints = SAMPLE_ENDPOINTS, entities: typeof SAMPLE_ENTITIES = SAMPLE_ENTITIES) =>
      gen({ language: "kotlin", framework, auth: "clerk" }, endpoints, entities).files.find((f) => f.path.endsWith("ApiContractTest.kt"))?.content;
    const ktor = contract("ktor")!;
    const spring = contract("spring-kt")!;
    assert.ok(ktor && spring, "both frameworks emit ApiContractTest.kt");
    // Each framework's own harness: Ktor's test module with a locally signed token, Spring's MockMvc + jwt().
    assert.match(ktor, /application \{ testModule\(\) \}/);
    assert.ok(!ktor.includes("MockMvc") && spring.includes("MockMvc"), "no Ktor code in Spring projects (or vice versa)");
    assert.match(spring, /@ActiveProfiles\("test"\)/);
    for (const kt of [ktor, spring]) {
      const names = [...kt.matchAll(/fun `([^`]+)`/g)].map((m) => m[1]);
      assert.ok(names.length > 0);
      // The previous file never compiled: JVM method names can't contain / . ; [ ] < > :
      for (const n of names) assert.doesNotMatch(n, /[/.;[\]<>:]/, n);
      assert.equal(new Set(names).size, names.length, "test names must be unique");
      // Every protected route is checked without a token (401) and with one (not 401).
      const without = names.filter((n) => n.endsWith(" returns 401 without token")).map((n) => n.replace(/ returns 401 without token$/, ""));
      const withToken = names.filter((n) => n.endsWith(" with token") && !n.includes("401"));
      assert.ok(without.includes("GET users") && without.includes("POST users"), "entity CRUD sits behind auth");
      for (const w of without) assert.ok(withToken.some((n) => n.startsWith(w + " ")), `${w}: missing authenticated case`);
    }
    // Create response shape: primary key + required fields.
    assert.match(ktor, /listOf\("id", "name", "email", "active", "createdAt"\)/);
    assert.ok(spring.includes('jsonPath("\\$.email").exists()'));
    assert.match(gen({ language: "kotlin", framework: "spring-kt" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("src/test/resources/application-test.properties")!,
      /jdbc:h2:mem:test;MODE=PostgreSQL[\s\S]*spring\.flyway\.enabled=false/);

    // Without entities the stubs are tested. A public stub stays public in Spring
    // unless its URL pattern would also open a protected route (fail closed).
    const eps = [
      { id: "1", method: "GET" as const, path: "/users", summary: "", auth: false },
      { id: "2", method: "GET" as const, path: "/users/:id", summary: "", auth: true },
      { id: "3", method: "GET" as const, path: "/users/search", summary: "", auth: false },
    ];
    const sec = gen({ language: "kotlin", framework: "spring-kt" }, eps, []).files.find((f) => f.path.endsWith("/SecurityConfig.kt"))!.content;
    assert.match(sec, /requestMatchers\(HttpMethod\.GET, "\/users"\)\.permitAll\(\)/);
    assert.ok(!sec.includes('"/users/search"'), "public /users/search is shadowed by protected /users/{id}: keep it protected");
    const stubs = contract("spring-kt", eps, [])!;
    assert.match(stubs, /fun `GET users returns 200`/);
    assert.match(stubs, /fun `GET users by id returns 401 without token`/);
    assert.match(contract("ktor", eps, [])!, /fun `GET users search returns 200`/);
  });

  // The Queue tab must produce a working broker client in TS repos — not a TODO.
  const TS_QUEUE_CLIENT: Record<string, { dep: string; env: string | null }> = {
    kafka: { dep: "kafkajs", env: "KAFKA_BROKERS" },
    rabbitmq: { dep: "amqplib", env: "RABBITMQ_URL" },
    nats: { dep: "nats", env: "NATS_URL" },
    sqs: { dep: "@aws-sdk/client-sqs", env: null }, // endpoint override via AWS_ENDPOINT_URL_SQS, read by the SDK itself
    bullmq: { dep: "bullmq", env: "REDIS_URL" },
  };
  const QUEUE_ENDPOINTS = [
    { id: "n", method: "POST" as const, path: "/notifications", summary: "", auth: false, pattern: "send_notification" },
    { id: "w", method: "POST" as const, path: "/webhooks/stripe", summary: "", auth: false, pattern: "webhook_receive" },
    { id: "h", method: "GET" as const, path: "/healthz", summary: "", auth: false, pattern: "health_check" },
  ];
  const TS_FRAMEWORKS = ["express", "fastify", "hono", "nestjs"];
  const tsRouteFile = (fw: string) => (fw === "nestjs" ? "src/app.controller.ts" : "src/main.ts");

  it("TS queue: each queue id ships its real client, a worker entrypoint, and reads the env var the repo documents", () => {
    assert.deepEqual(Object.keys(TS_QUEUE_CLIENT).sort(), queues.map((q) => q.id).sort(), "every catalog queue is covered");
    const allClients = Object.values(TS_QUEUE_CLIENT).map((c) => c.dep);
    for (const [queue, { dep, env }] of Object.entries(TS_QUEUE_CLIENT)) {
      for (const framework of TS_FRAMEWORKS) {
        const r = gen({ language: "typescript", framework, queue, auth: "none" }, QUEUE_ENDPOINTS);
        const label = `${framework}/${queue}`;
        const pkg = JSON.parse(r.get("package.json")!);
        assert.ok(pkg.dependencies[dep], `${label}: ${dep} in dependencies`);
        for (const other of allClients.filter((d) => d !== dep)) assert.ok(!pkg.dependencies[other], `${label}: no unused ${other}`);
        const queueTs = r.get("src/queue.ts");
        assert.ok(queueTs?.includes(`from "${dep}"`), `${label}: src/queue.ts uses ${dep}`);
        // docker compose runs the worker via this script / dist/worker.js.
        assert.ok(r.get("src/worker.ts")?.includes("subscribe(TOPICS.notifications"), `${label}: worker consumes notifications`);
        assert.equal(pkg.scripts.worker, "node dist/worker.js");
        if (env) {
          assert.ok(queueTs!.includes(`process.env.${env}`), `${label}: reads ${env}`);
          assert.match(r.get(".env.example")!, new RegExp(`^${env}=`, "m"), `${label}: ${env} is the name .env.example documents`);
        }
      }
    }
  });

  it("TS queue: send_notification and webhook_receive publish for real, readiness pings the broker, shutdown closes it", () => {
    for (const framework of TS_FRAMEWORKS) {
      const r = gen({ language: "typescript", framework, queue: "rabbitmq", auth: "none" }, QUEUE_ENDPOINTS);
      const routes = r.get(tsRouteFile(framework))!;
      assert.match(routes, /await publish\(TOPICS\.notifications, \{ recipient, channel, template, payload \}\)/, framework);
      assert.match(routes, /await publish\(TOPICS\.webhooks,/, framework);
      assert.ok(!/TODO: (enqueue|publish)/.test(routes), `${framework}: no queue TODOs left`);
      // A broker outage is a 503 (retryable), not a fake success.
      assert.match(routes, /queue_unavailable/, framework);
      assert.match(routes, /checks\.queue = "ok"/, `${framework}: health_check pattern includes the queue`);
      assert.match(routes, /await queuePing\(\)/, `${framework}: /health?ready=1 pings the queue`);
      const shutdownFile = framework === "nestjs" ? routes : r.get("src/main.ts")!;
      assert.match(shutdownFile, /closeQueue\(\)/, `${framework}: queue closed on shutdown`);
    }
  });

  it("TS queue: without a queue, publishing patterns answer 503 instead of pretending to enqueue", () => {
    for (const framework of TS_FRAMEWORKS) {
      const r = gen({ language: "typescript", framework, queue: "none", auth: "none" }, QUEUE_ENDPOINTS);
      const routes = r.get(tsRouteFile(framework))!;
      assert.ok(!r.get("src/queue.ts") && !r.get("src/worker.ts"), `${framework}: no queue files`);
      assert.ok(!routes.includes("./queue"), `${framework}: no queue import`);
      assert.equal(routes.match(/503[^\n]*queue_not_configured|queue_not_configured[^\n]*503/g)?.length, 2, `${framework}: both publishing patterns 503`);
      assert.ok(!JSON.parse(r.get("package.json")!).scripts.worker);
    }
  });
});

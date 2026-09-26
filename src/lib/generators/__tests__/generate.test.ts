import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../index.ts";
import { databases, caches, queues, monitoring as monitoringOptions } from "../../../data/stack-options.ts";
import { DEPLOY_SECRETS } from "../deploy.ts";

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
    // Every language implements both, so the README says so and .env.example documents the endpoint.
    for (const [language, framework] of [["go", "gin"], ["typescript", "express"], ["python", "fastapi"], ["rust", "axum"], ["kotlin", "ktor"], ["java", "spring"], ["java", "quarkus"]]) {
      const g = gen({ language, framework });
      assert.ok(g.get("README.md")!.includes("traces are exported via OTLP"), `${language} README should claim tracing`);
      assert.ok(g.get("README.md")!.includes("rate limiting is enabled"), `${language} README should claim rate limiting`);
      assert.ok(g.get(".env.example")!.includes("OTEL_EXPORTER_OTLP_ENDPOINT="), `${language}: OTEL endpoint documented`);
    }
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
    assert.match(app, /fun Application\.module\((jwtVerifier: JWTVerifier\? = null)?.*\) \{[\s\S]*routing \{/);
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
    const runner = (database: string) => gen({ database }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/db/migrate.go")!;
    // pgx (not lib/pq): lib/pq defaults to sslmode=require and a local Postgres has no TLS.
    assert.match(runner("postgres"), /migrate\/v4\/database\/pgx\/v5"/);
    assert.match(runner("cockroach"), /migrate\/v4\/database\/cockroachdb"/);
    assert.match(runner("mysql"), /migrate\/v4\/database\/mysql"/);
    // golang-migrate's sqlite driver registers "sqlite" like glebarez does -> init panic.
    assert.doesNotMatch(runner("sqlite"), /golang-migrate/);
    assert.match(main("postgres"), /cfg, err := config\.Load\(\)/);
    // Pure-Go sqlite so CGO_ENABLED=0 Docker builds work.
    assert.ok(gen({ database: "sqlite" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/db/gorm.go")!.includes("github.com/glebarez/sqlite"));
  });
});

// ─── gRPC / GraphQL / tRPC honor the cross-cutting flags ────────────────────
// These trees used to ignore rateLimit / audit / tracing / monitoring while
// REST honored them, so the same builder toggles silently meant nothing.

describe("Non-REST APIs honor rateLimit / audit / tracing / monitoring", () => {
  // auth "none" too: with a provider, protected entity RPCs add an auth interceptor.
  const OFF = { rateLimit: false, audit: false, tracing: false, monitoring: "none", auth: "none" };

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
    assert.match(g.get("src/interceptors.ts")!, /\[metrics, rateLimit, audit, auth\]/);
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
    assert.match(grpcMain, /interceptors=\[server_interceptor\(\), MetricsInterceptor\(\), RateLimitInterceptor\(\), AuditInterceptor\(\), AuthInterceptor\(\)\]/);
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
      const ts = (auth: string) => gen({ language: "typescript", framework: fw, auth }, eps, [{ id: "e1", name: "User", fields: [{ id: "f1", name: "id", type: "uuid", required: true, unique: true, primaryKey: true }, { id: "f2", name: "email", type: "string", required: true, unique: true }] }]);
      // Self-managed: login mints HS256 tokens with JWT_SECRET, so authRequired must verify exactly those.
      const self = ts("none");
      const selfVerifier = self.get(verifierPath(fw))!;
      assert.ok(selfVerifier, `${fw}: auth "none" + auth patterns must emit a verifier`);
      assert.match(selfVerifier, /algorithms: \["HS256"\]/, fw);
      assert.match(selfVerifier, /process\.env\.JWT_SECRET/, fw);
      assert.match(code(self), /jwt\.sign\(\{ sub: user\.id \}, process\.env\.JWT_SECRET!/, fw);
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
    assert.match(support, /module\(jwtVerifier = TestAuth\.verifier[,)]/);
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

  it("Go queue option is really wired: client, publisher, readiness, worker, go.mod", () => {
    // Why: a queue picked in the builder used to produce "TODO: publish" stubs, so
    // send_notification claimed success while nothing was ever sent.
    const clients: Record<string, string> = {
      kafka: "github.com/segmentio/kafka-go",
      rabbitmq: "github.com/rabbitmq/amqp091-go",
      nats: "github.com/nats-io/nats.go",
      sqs: "github.com/aws/aws-sdk-go-v2/service/sqs",
      bullmq: "github.com/redis/go-redis/v9",
    };
    assert.deepEqual(Object.keys(clients).sort(), queues.map((q) => q.id).sort(), "every catalog queue has a Go client");
    const eps = [
      { id: "n", method: "POST" as const, path: "/notifications", summary: "", auth: false, pattern: "send_notification" },
      { id: "w", method: "POST" as const, path: "/webhooks/stripe", summary: "", auth: false, pattern: "webhook_receive" },
    ];
    for (const framework of FRAMEWORKS.go) {
      for (const [queue, mod] of Object.entries(clients)) {
        const { get } = gen({ framework, queue }, eps);
        const q = get("internal/queue/queue.go")!;
        assert.ok(q.includes(`"${mod}"`), `${framework}/${queue}: imports ${mod}`);
        assert.match(q, /Publish\(ctx context\.Context, topic string, msg \[\]byte\) error/);
        assert.ok(get("go.mod")!.includes(`\t${mod} v`), `${framework}/${queue}: go.mod requires ${mod}`);
        const api = get("internal/handlers/api.go")!;
        assert.ok(api.includes("h.mq.Publish(") && api.includes("queue.TopicNotifications") && api.includes("queue.TopicWebhooks"), `${framework}/${queue}: handlers publish`);
        assert.ok(!/TODO: (enqueue|publish)/.test(api), `${framework}/${queue}: no queue TODOs left`);
        const server = get("internal/server/server.go")!;
        assert.match(server, /queue\.Open\(/);
        assert.match(server, /s\.checks\["queue"\] = q\.Ping/, "queue is part of /health?ready=1");
        assert.match(server, /return q\.Close\(\)/, "queue closes on shutdown");
        assert.match(server, /handlers\.NewAPIHandlers\([^)]*\bq\)/);
        const worker = get("cmd/worker/main.go")!;
        assert.match(worker, /q\.Subscribe\(ctx, topic,/);
        assert.match(worker, /signal\.NotifyContext/, "worker shuts down gracefully");
        assert.ok(get("Dockerfile")!.includes("./cmd/worker"), "the image ships the worker binary");
      }
    }
    // Env names are the ones .env.example already documents.
    assert.ok(gen({ queue: "kafka" }).get("internal/config/config.go")!.includes('env:"KAFKA_BROKERS"'));
    assert.ok(gen({ queue: "rabbitmq" }).get("internal/config/config.go")!.includes('env:"RABBITMQ_URL"'));
    assert.ok(gen({ queue: "nats" }).get("internal/config/config.go")!.includes('env:"NATS_URL"'));
    // BullMQ is Node-only: the Go side must say so rather than pretend interop.
    assert.match(gen({ queue: "bullmq" }).get("internal/queue/queue.go")!, /does NOT produce or consume BullMQ jobs/);

    // No queue: nothing emitted, and send_notification refuses instead of lying.
    const none = gen({ queue: "none" }, eps);
    assert.equal(none.get("internal/queue/queue.go"), undefined);
    assert.equal(none.get("cmd/worker/main.go"), undefined);
    const api = none.get("internal/handlers/api.go")!;
    assert.ok(api.includes('"queue_not_configured"') && !api.includes(`"queued": true`));
    assert.ok(!none.get("go.mod")!.includes("kafka-go") && !none.get("Dockerfile")!.includes("worker"));
  });

  // ─── Rust parity: tracing / rateLimit / audit / monitoring / cache / queues ───

  const RUST_QUEUES = ["rabbitmq", "kafka", "nats", "sqs", "bullmq"];

  it("Rust Cargo.toml declares every external crate the generated src/ references (else `cargo check` fails)", () => {
    const local = new Set(["std", "core", "alloc", "crate", "self", "super"]);
    for (const framework of ["axum", "actix"]) {
      for (const queue of RUST_QUEUES) {
        for (const monitoring of ["grafana", "sentry", "datadog", "otel"]) {
          for (const database of ["postgres", "mysql"]) {
            const { files, get } = gen({ language: "rust", framework, queue, monitoring, database }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
            const deps = new Set([...get("Cargo.toml")!.split("[dev-dependencies]")[0].matchAll(/^([\w-]+) = /gm)].map((m) => m[1].replace(/-/g, "_")));
            const rs = files.filter((f) => f.path.startsWith("src/") && f.path.endsWith(".rs"));
            const code = rs.map((f) => f.content.replace(/\/\/.*$/gm, "")).join("\n");
            const mods = new Set([...code.matchAll(/^mod (\w+);/gm)].map((m) => m[1]));
            const imported = new Set([...code.matchAll(/^\s*use [^;]+;/gm)].flatMap((m) => m[0].match(/\w+/g)!));
            for (const [, root] of code.matchAll(/(?<![\w:.])([a-z_][a-z0-9_]*)::(?!<)/g)) {
              if (local.has(root) || mods.has(root) || imported.has(root)) continue;
              assert.ok(deps.has(root), `${framework}/${queue}/${monitoring}/${database}: src uses ${root}:: but Cargo.toml lacks it`);
            }
            for (const [, root] of code.matchAll(/^use (\w+)::/gm)) {
              assert.ok(local.has(root) || mods.has(root) || deps.has(root), `${framework}/${queue}: use ${root}:: without a Cargo dependency`);
            }
          }
        }
      }
    }
  });

  it("Rust wires tracing, rate limiting, audit and Sentry only when chosen", () => {
    for (const framework of ["axum", "actix"]) {
      const on = gen({ language: "rust", framework, monitoring: "sentry" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const main = on.get("src/main.rs")!;
      const cargo = on.get("Cargo.toml")!;
      // OTLP exporter only when the endpoint env var is set, so a bare `cargo run` doesn't spam export errors.
      assert.match(on.get("src/telemetry.rs")!, /env::var\("OTEL_EXPORTER_OTLP_ENDPOINT"\)[\s\S]*SpanExporter::builder\(\)\s*\.with_http\(\)/);
      assert.match(main, /telemetry::init\(\)[\s\S]*provider\.shutdown\(\)/, `${framework}: spans must be flushed on exit`);
      assert.match(main, framework === "axum" ? /TraceLayer::new_for_http\(\)/ : /tracing_actix_web::TracingLogger/);
      assert.match(main, framework === "axum" ? /GovernorLayer/ : /actix_governor::Governor::new/);
      assert.match(main, framework === "axum" ? /sentry_tower::NewSentryLayer/ : /sentry_actix::Sentry::new\(\)/);
      assert.match(main, /env::var\("SENTRY_DSN"\)/);
      assert.match(main, /target: "audit", method = %method, path = %path, status = [^,]+, ip = %ip/);
      for (const crate of ["opentelemetry-otlp", "tracing-opentelemetry", "sentry"]) assert.ok(cargo.includes(`\n${crate} = `), `${framework}: ${crate}`);

      const off = gen({ language: "rust", framework, ...OFF, cache: "none", queue: "none" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const offMain = off.get("src/main.rs")!;
      assert.ok(!off.get("src/telemetry.rs") && !off.get("src/cache.rs") && !off.get("src/queue.rs") && !off.get("src/bin/worker.rs"));
      assert.doesNotMatch(offMain, /governor|audit|sentry|telemetry|cache::|queue::/i);
      assert.doesNotMatch(off.get("Cargo.toml")!, /opentelemetry|governor|sentry|redis|lapin|default-run/);
    }
  });

  it("Rust axum serves with ConnectInfo whenever the rate limiter or audit log needs the client IP", () => {
    // Without it the ConnectInfo extractor / peer-IP key extractor fail every request at runtime.
    for (const [rateLimit, audit] of [[true, false], [false, true], [true, true]]) {
      const main = gen({ language: "rust", framework: "axum", rateLimit, audit }).get("src/main.rs")!;
      assert.match(main, /axum::serve\(listener, app\.into_make_service_with_connect_info::<std::net::SocketAddr>\(\)\)/);
    }
    assert.match(gen({ language: "rust", framework: "axum", rateLimit: false, audit: false }).get("src/main.rs")!, /axum::serve\(listener, app\)/);
  });

  it("Rust datadog / otel monitoring export traces over OTLP even with the tracing flag off", () => {
    const dd = gen({ language: "rust", framework: "axum", tracing: false, monitoring: "datadog" });
    assert.match(dd.get("src/telemetry.rs")!, /Datadog Agent[\s\S]*OTEL_EXPORTER_OTLP_ENDPOINT/, "the Datadog route must be documented");
    assert.ok(gen({ language: "rust", framework: "actix", tracing: false, monitoring: "otel" }).get("src/telemetry.rs"));
    assert.ok(!gen({ language: "rust", framework: "axum", tracing: false, monitoring: "grafana" }).get("src/telemetry.rs"));
  });

  it("Rust Redis cache: cache-aside entity reads, invalidation on writes, readiness pings Redis", () => {
    for (const framework of ["axum", "actix"]) {
      for (const database of ["postgres", "mysql"]) {
        const g = gen({ language: "rust", framework, database, cache: "redis" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
        assert.match(g.get("src/cache.rs")!, /env::var\("REDIS_URL"\)[\s\S]*get_connection_manager/);
        const handler = g.get("src/handlers/user.rs")!;
        const getById = handler.slice(handler.indexOf("async fn get_by_id"), handler.indexOf("async fn create"));
        // The cache is consulted before the database and populated after a miss.
        assert.ok(getById.indexOf("cache::get::<User>") < getById.indexOf("SELECT") && getById.indexOf("SELECT") < getById.indexOf("cache::set"), `${framework}/${database}: cache-aside order`);
        // Stale reads after a write are a correctness bug: update and delete must drop the key.
        for (const fn of ["async fn update", "async fn delete"]) {
          const body = handler.slice(handler.indexOf(fn));
          assert.match(body.slice(0, body.indexOf("\n}\n")), /cache::del\(&cache_key\)/, `${framework}/${database}: ${fn} invalidates`);
        }
        assert.match(g.get("src/main.rs")!, /ready=1[\s\S]*cache::ping\(\)/);
      }
      // No database → in-memory store; caching it would only add a network hop.
      const mem = gen({ language: "rust", framework, database: "mongodb", cache: "redis" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      assert.doesNotMatch(mem.get("src/handlers/user.rs")!, /cache::/);
      assert.ok(!gen({ language: "rust", framework, cache: "memcached" }).get("src/cache.rs"));
    }
  });

  it("Rust queues: a worker binary consumes the env var the repo configures, and send_notification publishes", () => {
    const envVar: Record<string, string> = { rabbitmq: "RABBITMQ_URL", kafka: "KAFKA_BROKERS", nats: "NATS_URL", sqs: "AWS_ENDPOINT_URL_SQS", bullmq: "REDIS_URL" };
    const eps = [...SAMPLE_ENDPOINTS, { id: "n", method: "POST" as const, path: "/notifications", summary: "", auth: true, pattern: "send_notification" }];
    for (const framework of ["axum", "actix"]) {
      for (const queue of RUST_QUEUES) {
        const g = gen({ language: "rust", framework, queue, cache: "none" }, eps, SAMPLE_ENTITIES);
        const q = g.get("src/queue.rs")!;
        assert.ok(q.includes(`env::var("${envVar[queue]}")`), `${framework}/${queue}: queue.rs must read ${envVar[queue]}`);
        assert.ok(g.get(".env.example")!.includes(`${envVar[queue]}=`), `${queue}: .env.example must define ${envVar[queue]}`);
        assert.match(q, /pub async fn publish\(/);
        assert.match(q, /pub async fn consume<F: Fn\(&\[u8\]\)>\(handle: F, shutdown: impl Future<Output = \(\)>\)/);
        const worker = g.get("src/bin/worker.rs")!;
        assert.match(worker, /#\[path = "\.\.\/queue\.rs"\]\s*mod queue;/);
        assert.match(worker, /queue::consume\(handle, shutdown_signal\(\)\)/, "worker must stop on SIGTERM");
        // Two binaries: `cargo run` must still start the API, and the image must ship the worker.
        assert.match(g.get("Cargo.toml")!, /default-run = "test_app"/);
        assert.match(g.get("Dockerfile")!, /target\/release\/worker \/worker/);
        // Entities exist, yet the publishing endpoint is still served (stubs are skipped with entities).
        const main = g.get("src/main.rs")!;
        assert.match(main, /"\/notifications", (axum::routing::post|web::post\(\)\.to)\(send_notification\)/);
        assert.match(main, /queue::publish\(/);
      }
    }
    assert.match(gen({ language: "rust", framework: "axum", queue: "bullmq" }).get("src/queue.rs")!, /does NOT speak\s*\/\/! BullMQ's format/, "the BullMQ limitation must be stated");
    const none = gen({ language: "rust", framework: "axum", queue: "none" }, eps, SAMPLE_ENTITIES).get("src/main.rs")!;
    assert.doesNotMatch(none, /send_notification|\/notifications/);
  });
});

// One-click deploy sets DEPLOY_SECRETS as repo secrets and dispatches
// .github/workflows/deploy.yml, so each target must ship a live (not
// commented-out) deploy job that reads exactly those secrets.
describe("Every deployment target gets a real CI deploy job", () => {
  const ACTION: Record<string, RegExp> = {
    fly: /flyctl deploy --remote-only --app test-app --image-label "\$GITHUB_SHA"/,
    railway: /railway up --ci --service "\$RAILWAY_SERVICE_ID"/,
    render: /api\.render\.com\/v1\/services\/\$RENDER_SERVICE_ID\/deploys/,
    vercel: /vercel deploy --prebuilt --prod/,
    aws: /uses: aws-actions\/amazon-ecs-deploy-task-definition@v2/,
    gcp: /uses: google-github-actions\/deploy-cloudrun@v2/,
    azure: /uses: azure\/container-apps-deploy-action@v2/,
    k8s: /kubectl rollout status deployment\/test-app/,
  };
  const uncommented = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  for (const [deployment, action] of Object.entries(ACTION)) {
    it(`${deployment}: deploy.yml runs after tests on push + dispatch, with the documented secrets`, () => {
      const lang = deployment === "vercel" ? { language: "typescript", framework: "express" } : {};
      const { get } = gen({ deployment, ...lang });
      const wf = get(".github/workflows/deploy.yml");
      assert.ok(wf, "deploy.yml is the fixed path one-click deploy dispatches");
      const live = uncommented(wf);
      assert.match(live, /workflow_dispatch:/);
      assert.match(live, /push:\n    branches: \[main\]/);
      assert.match(live, /\n  deploy:\n    name: .*\n    needs: test\n/);
      assert.match(live, action, "deploy step must be live, not a comment");
      const guide = get("DEPLOY.md")!;
      for (const s of DEPLOY_SECRETS[deployment as keyof typeof DEPLOY_SECRETS]) {
        assert.ok(live.includes(`secrets.${s.name} }}`), `${s.name} referenced by the workflow`);
        assert.ok(guide.includes(`\`${s.name}\``), `${s.name} documented in DEPLOY.md`);
      }
      assert.ok(!/(docker (build|push)|IMAGE=|imageToDeploy|image\.tag)[^\n]*:latest/.test(live), "deployed images are tagged with the git SHA, never :latest");
      // Railway and Vercel build from uploaded source, so there is no image tag to pin.
      if (deployment !== "railway" && deployment !== "vercel") assert.match(live, /GITHUB_SHA|github\.sha/);
    });
  }

  it("ci.yml no longer carries a placeholder deploy job", () => {
    for (const deployment of Object.keys(ACTION)) {
      const ci = gen({ deployment }).get(".github/workflows/ci.yml")!;
      assert.ok(!/\n  deploy:/.test(ci) && !/Add your deployment step/.test(ci), deployment);
    }
  });

  it("GitLab and CircleCI get a live deploy job for every target", () => {
    for (const deployment of Object.keys(ACTION)) {
      const ts = { deployment, language: "typescript", framework: "express" };
      const gl = gen({ ...ts, cicd: "gitlab-ci" }).get(".gitlab-ci.yml")!;
      assert.match(gl, /\ndeploy:\n  stage: deploy\n/, `${deployment} gitlab`);
      assert.match(gl, /stages: \[.*deploy\]/);
      const cc = gen({ ...ts, cicd: "circleci" }).get(".circleci/config.yml")!;
      assert.match(cc, /\n  deploy:\n    docker:/, `${deployment} circleci`);
      assert.match(cc, /- deploy:\n          requires: \[test\]/);
    }
  });

  it("Vercel fails fast (and DEPLOY.md warns) for stacks Vercel can't run", () => {
    const { get } = gen({ deployment: "vercel", language: "go", framework: "gin" });
    assert.match(get(".github/workflows/deploy.yml")!, /Vercel cannot run a go\/gin server[^\n]*exit 1/);
    assert.ok(!get(".github/workflows/deploy.yml")!.includes("vercel deploy"));
    assert.match(get("DEPLOY.md")!, /cannot run on Vercel/);
  });

  it("provider regions are translated from the AWS-style picker ids", () => {
    assert.match(gen({ deployment: "gcp", region: "eu-west-2" }).get("deploy/gcp/service.yaml")!, /location: europe-west2/);
    assert.match(gen({ deployment: "azure", region: "eu-west-2" }).get("deploy/azure/containerapp.yaml")!, /^location: uksouth$/m);
    assert.match(gen({ deployment: "fly", region: "eu-west-2" }).get("fly.toml")!, /primary_region = "lhr"/);
  });

  it("k8s target ships something to apply even with the Kubernetes toggle off", () => {
    assert.ok(gen({ deployment: "k8s", kubernetes: false, helm: false }).get("deploy/k8s/deployment.yaml"));
    const helmOnly = gen({ deployment: "k8s", kubernetes: false, helm: true }).get(".github/workflows/deploy.yml")!;
    assert.match(helmOnly, /helm upgrade --install test-app \.\/deploy\/helm[^\n]*--set image\.tag="\$SHA"/);
  });

  // The Queue tab must produce a working broker client in TS repos — not a TODO.
  const TS_QUEUE_CLIENT: Record<string, { dep: string; env: string | null }> = {
    kafka: { dep: "kafkajs", env: "KAFKA_BROKERS" },
    rabbitmq: { dep: "amqplib", env: "RABBITMQ_URL" },
    nats: { dep: "@nats-io/transport-node", env: "NATS_URL" },
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

  // ─── Kotlin parity: tracing / rate limit / audit / monitoring / cache / queues ──

  const kt = (framework: string, overrides: Record<string, unknown> = {}, entities: typeof SAMPLE_ENTITIES = SAMPLE_ENTITIES) => {
    const g = gen({ language: "kotlin", framework, ...overrides }, SAMPLE_ENDPOINTS, entities);
    const find = (suffix: string) => g.files.find((f) => f.path.endsWith(suffix))?.content;
    return { ...g, find };
  };

  it("Kotlin wires tracing, rate limiting and audit into the running app, and emits nothing when the flags are off", () => {
    const ktor = kt("ktor");
    const app = ktor.get("src/main/kotlin/Application.kt")!;
    for (const call of ["configureTracing()", "configureRateLimit()", "configureAudit()"]) assert.ok(app.includes(call), `ktor module() must call ${call}`);
    const obs = ktor.get("src/main/kotlin/Observability.kt")!;
    // No collector configured must mean no exporter (and no startup failure), not a crash.
    assert.match(obs, /OTEL_EXPORTER_OTLP_ENDPOINT"\)\?\.takeIf \{ it\.isNotBlank\(\) \} \?: return/);
    assert.match(obs, /install\(KtorServerTracing\)/);
    assert.match(obs, /install\(RateLimit\)[\s\S]*requestKey \{ call -> call\.request\.origin\.remoteHost \}/);
    assert.match(obs, /call\.principal<JWTPrincipal>\(\)\?\.subject/, "audit lines name the caller when auth is on");
    const gradle = ktor.get("build.gradle.kts")!;
    assert.ok(gradle.includes("opentelemetry-ktor-2.0") && gradle.includes("ktor-server-rate-limit"));

    const spring = kt("spring-kt");
    assert.ok(spring.find("/Observability.kt")!.includes("class RateLimitFilter") && spring.find("/Observability.kt")!.includes("class AuditFilter"));
    assert.match(spring.find("/Observability.kt")!, /@ConditionalOnExpression\("'\\\$\{OTEL_EXPORTER_OTLP_ENDPOINT:\}' != ''"\)/);
    assert.ok(spring.get("build.gradle.kts")!.includes("micrometer-tracing-bridge-otel") && spring.get("build.gradle.kts")!.includes("bucket4j-core"));
    // A shared MockMvc context would otherwise trip the limiter across test classes.
    assert.match(spring.get("src/test/resources/application-test.properties")!, /rate-limit\.requests-per-minute=100000/);

    const off = { tracing: false, rateLimit: false, audit: false };
    assert.ok(!kt("ktor", off).get("src/main/kotlin/Observability.kt"), "no plugin code without the flags");
    assert.ok(!kt("ktor", off).get("build.gradle.kts")!.includes("opentelemetry"));
    assert.ok(!kt("spring-kt", off).find("/Observability.kt"));
  });

  it("Kotlin Sentry / Datadog get their SDK wired, disabled when the key is unset", () => {
    const ktSentry = kt("ktor", { monitoring: "sentry" });
    assert.ok(ktSentry.get("build.gradle.kts")!.includes('"io.sentry:sentry:'));
    assert.match(ktSentry.get("src/main/kotlin/Observability.kt")!, /SENTRY_DSN[\s\S]*Sentry\.captureException\(e\)/);
    assert.ok(ktSentry.get("src/main/kotlin/Application.kt")!.includes("configureSentry()"));
    const ktDd = kt("ktor", { monitoring: "datadog" });
    assert.ok(ktDd.get("build.gradle.kts")!.includes("micrometer-registry-datadog"));
    assert.match(ktDd.get("src/main/kotlin/Observability.kt")!, /DD_API_KEY[\s\S]*DatadogMeterRegistry/);

    const spSentry = kt("spring-kt", { monitoring: "sentry" });
    assert.ok(spSentry.get("build.gradle.kts")!.includes("sentry-spring-boot-starter-jakarta"));
    assert.match(spSentry.get("src/main/resources/application.properties")!, /sentry\.dsn=\$\{SENTRY_DSN:\}/);
    const spDd = kt("spring-kt", { monitoring: "datadog" });
    assert.match(spDd.get("src/main/resources/application.properties")!, /management\.datadog\.metrics\.export\.api-key=\$\{DD_API_KEY:\}/);
    assert.match(spDd.get("src/test/resources/application-test.properties")!, /management\.datadog\.metrics\.export\.enabled=false/);
  });

  it("Kotlin queues use the broker's real client, read the env var .env.example documents, and tests never connect", () => {
    const cases: [string, string, string, string][] = [
      ["kafka", "org.apache.kafka:kafka-clients", "org.springframework.kafka:spring-kafka", "KAFKA_BROKERS"],
      ["rabbitmq", "com.rabbitmq:amqp-client", "spring-boot-starter-amqp", "RABBITMQ_URL"],
      ["nats", "io.nats:jnats", "io.nats:jnats", "NATS_URL"],
      ["sqs", "software.amazon.awssdk:sqs", "spring-cloud-aws-starter-sqs", "AWS_ENDPOINT_URL_SQS"],
      ["bullmq", "io.lettuce:lettuce-core", "spring-boot-starter-data-redis", "REDIS_URL"],
    ];
    for (const [queue, ktorDep, springDep, env] of cases) {
      const ktor = kt("ktor", { queue, cache: "memcached" });
      assert.ok(ktor.get("build.gradle.kts")!.includes(ktorDep), `${queue}: ktor dep`);
      const q = ktor.get("src/main/kotlin/Queue.kt")!;
      assert.ok(q.includes(`System.getenv("${env}")`), `${queue}: ktor reads ${env}`);
      assert.ok(ktor.get(".env.example")!.includes(`${env}=`), `${queue}: ${env} is documented in .env.example`);
      // Consumer runs in the API process and as a standalone worker.
      assert.match(ktor.get("src/main/kotlin/Application.kt")!, /launchConsumer\(queue\)/);
      assert.match(ktor.get("src/main/kotlin/Worker.kt")!, /object Worker \{[\s\S]*@JvmStatic\s+fun main/);
      assert.ok(ktor.get("build.gradle.kts")!.includes('tasks.register<JavaExec>("worker")'));
      assert.match(ktor.get("src/test/kotlin/TestSupport.kt")!, /module\([^)]*queue = TestQueue\)/, `${queue}: ktor tests inject the fake`);
      // Entity writes are events.
      assert.match(ktor.get("src/main/kotlin/routes/userRoutes.kt")!, /queue\.publish\("""\{"event":"user\.created"/);

      const spring = kt("spring-kt", { queue, cache: "memcached" });
      assert.ok(spring.get("build.gradle.kts")!.includes(springDep), `${queue}: spring dep`);
      const sq = spring.find("/Queue.kt")!;
      assert.match(sq, /@Component\n@Profile\("!test"\)\nclass \w+Jobs/, `${queue}: real broker bean is off in the test profile`);
      assert.ok(spring.find("/InMemoryJobPublisher.kt")!.includes('@Profile("test")'));
      assert.ok(spring.get("src/main/resources/application.properties")!.includes(`\${${env}:`), `${queue}: spring reads ${env}`);
      assert.ok(spring.find("/UserController.kt")!.includes("jobs.publish("));
    }
    // BullMQ has no JVM client: say so instead of pretending.
    assert.match(kt("ktor", { queue: "bullmq" }).get("src/main/kotlin/Queue.kt")!, /NOT wire-compatible with BullMQ/);
    assert.match(kt("spring-kt", { queue: "sqs" }).get("src/test/resources/application-test.properties")!, /spring\.cloud\.aws\.sqs\.enabled=false/);
    assert.ok(!kt("ktor", { queue: "none" }).get("src/main/kotlin/Queue.kt"));
  });

  it("Kotlin Redis cache is cache-aside on get-by-id and evicted on writes; memcached emits no Redis code", () => {
    const routes = kt("ktor").get("src/main/kotlin/routes/userRoutes.kt")!;
    assert.match(routes, /cache\.get\("users:\$id"\)\?\.let \{ return@get call\.respondText/, "a hit returns before the DB read");
    assert.match(routes, /cache\.set\("users:\$id", Json\.encodeToString\(item\)\)/);
    assert.equal(routes.match(/cache\.delete\("users:\$id"\)/g)?.length, 2, "update and delete evict");
    assert.ok(kt("ktor").get("src/main/kotlin/Cache.kt")!.includes('System.getenv("REDIS_URL")'));
    assert.match(kt("ktor").get("src/test/kotlin/TestSupport.kt")!, /cache = TestCache/);

    const spring = kt("spring-kt");
    const repo = spring.find("/UserRepository.kt")!;
    assert.match(repo, /@Cacheable\("users", key = "#p0", unless = "#result == null"\)\n\s+override fun findById/);
    assert.match(repo, /@CacheEvict\("users", key = "#p0\.id", condition = "#p0\.id != null"\)\n\s+override fun <S : User> save/);
    assert.match(spring.find("/User.kt")!, /\) : java\.io\.Serializable/, "the Redis cache serializes entities");
    const testProps = spring.get("src/test/resources/application-test.properties")!;
    assert.match(testProps, /spring\.cache\.type=simple/);
    assert.match(testProps, /spring\.autoconfigure\.exclude=.*RedisAutoConfiguration/);

    for (const framework of ["ktor", "spring-kt"]) {
      const g = kt(framework, { cache: "memcached", queue: "none" });
      assert.ok(!g.get("build.gradle.kts")!.includes("lettuce") && !g.get("build.gradle.kts")!.includes("data-redis"), framework);
    }
  });

  it("Kotlin /health?ready=1 checks every dependency; Ktor tests prove limits, events and caching", () => {
    const app = kt("ktor").get("src/main/kotlin/Application.kt")!;
    assert.match(app, /mapOf\("db" to dbReady\(\), "cache" to cache\.ping\(\), "queue" to queue\.ping\(\)\)/);
    assert.match(app, /HttpStatusCode\.ServiceUnavailable/);
    // spring-kt permitted /health in SecurityConfig but nothing served it.
    const health = kt("spring-kt").find("/HealthController.kt")!;
    assert.match(health, /@GetMapping\("\/health"\)/);
    assert.match(health, /"queue" to jobs\.ping\(\)/);
    assert.ok(kt("spring-kt").find("/HealthTest.kt")!.includes('param("ready", "1")'));

    const test = kt("ktor").get("src/test/kotlin/ApplicationTest.kt")!;
    assert.match(test, /repeat\(60\)[\s\S]*HttpStatusCode\.TooManyRequests/);
    assert.match(test, /TestQueue\.published\.any/);
    assert.match(test, /assertNotNull\(TestCache\.get\("users:\$id"\)/);
  });

  // gRPC entity RPCs used to answer UNIMPLEMENTED: a "working" server that
  // stored nothing. They must run on the same data layer as the REST routes.
  it("gRPC entity RPCs are backed by the REST data layer, never UNIMPLEMENTED", () => {
    const cases: [string, string, string, string, RegExp][] = [
      ["go", "gin", "postgres", "internal/grpcserver/user_service.go", /s\.db\.WithContext\(ctx\)\.First\(&m, "id = \?"/],
      ["go", "chi", "mongodb", "internal/grpcserver/user_service.go", /s\.store\.Create\(ctx, userCollection/],
      ["typescript", "fastify", "postgres", "src/services/user.service.ts", /prisma\.user\.create\(\{ data: createData/],
      ["typescript", "express", "mongodb", "src/services/user.service.ts", /prisma\.user\.findMany/],
      ["python", "fastapi", "postgres", "app/services/user.py", /with SessionLocal\(\) as db:/],
      ["python", "fastapi", "mongodb", "app/services/user.py", /_rows\[str\(item\.id\)\] = item/],
    ];
    for (const [language, framework, database, path, dbCall] of cases) {
      const g = gen({ language, framework, database, api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const svc = g.get(path)!;
      const label = `${language}/${database}`;
      assert.ok(svc, `${label}: missing ${path}`);
      assert.doesNotMatch(svc, /not implemented|codes\.Unimplemented|status\.UNIMPLEMENTED|StatusCode\.UNIMPLEMENTED/i, `${label}: entity RPCs must not be stubs`);
      assert.match(svc, dbCall, `${label}: RPCs must hit the data layer`);
      for (const code of [/NotFound|NOT_FOUND|"P2025"/, /InvalidArgument|INVALID_ARGUMENT|invalid\(/]) {
        assert.match(svc + (g.get("internal/grpcserver/server.go") ?? "") + (g.get("src/services/grpc-util.ts") ?? ""), code, `${label}: ${code}`);
      }
    }
    // Unique violations are ALREADY_EXISTS wherever the database enforces them.
    assert.match(gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/grpcserver/server.go")!, /codes\.AlreadyExists/);
    assert.match(gen({ language: "typescript", framework: "fastify", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("src/services/grpc-util.ts")!, /"P2002"[\s\S]*ALREADY_EXISTS/);
    assert.match(gen({ language: "python", framework: "fastapi", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("app/services/user.py")!, /except IntegrityError:[\s\S]*ALREADY_EXISTS/);
  });

  it("gRPC reuses the REST models / db / auth files verbatim, so both protocols share one schema", () => {
    const rest = gen({ api: "rest" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const grpc = gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    for (const p of ["internal/models/models.go", "internal/db/gorm.go", "internal/auth/jwt.go", "internal/config/config.go"]) {
      assert.equal(grpc.get(p), rest.get(p), p);
    }
    assert.match(grpc.get("cmd/api/main.go")!, /db\.OpenGorm\(cfg\.DatabaseURL\)[\s\S]*grpcserver\.NewUserService\(gormDB\)/);
    const py = gen({ language: "python", framework: "fastapi", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const pyRest = gen({ language: "python", framework: "fastapi", api: "rest" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.equal(py.get("app/models.py"), pyRest.get("app/models.py"));
    assert.equal(py.get("app/db.py"), pyRest.get("app/db.py"));
    assert.match(py.get("pyproject.toml")!, /psycopg2-binary/, "app/db.py's sync engine needs the sync driver");
    assert.ok(!py.get("app/auth.py")!.includes("def auth_required"), "gRPC keeps only the token verifier");
  });

  it("gRPC auth interceptor guards exactly the RPCs whose REST routes require auth", () => {
    // SAMPLE_ENDPOINTS protect GET/POST /users and GET/DELETE /users/:id; no PUT/PATCH, nothing on /posts.
    const want = ["ListUser", "GetUser", "CreateUser", "DeleteUser"];
    const go = gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/grpcserver/interceptors.go")!;
    const ts = gen({ language: "typescript", framework: "fastify", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("src/interceptors.ts")!;
    const py = gen({ language: "python", framework: "fastapi", api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("app/interceptors.py")!;
    for (const [lang, src] of [["go", go], ["ts", ts], ["py", py]]) {
      const guarded = [...src.matchAll(/"\/test_app\.v1\.(\w+)Service\/(\w+)"/g)].map((m) => m[2]);
      assert.deepEqual(guarded, want, `${lang}: guarded RPCs`);
      assert.match(src, /authorization/i, `${lang}: reads the authorization metadata`);
      assert.match(src, /UNAUTHENTICATED|Unauthenticated/, `${lang}: rejects with UNAUTHENTICATED`);
    }
    assert.match(go, /auth\.ExtractBearer\(h\)[\s\S]*auth\.Default\(\)[\s\S]*v\.Verify\(ctx, raw\)/, "same verifier as REST");
    assert.match(ts, /import \{ unconfigured, verify \} from "\.\/auth\.js"/);
    assert.match(py, /from app\.auth import _verify/);

    // No provider and no auth_* patterns: REST verifies nothing, so neither does gRPC.
    const open = gen({ api: "grpc", auth: "none" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.ok(!open.get("internal/grpcserver/interceptors.go")?.includes("func Auth()"));
    assert.ok(!open.get("internal/auth/jwt.go"));
  });

  it("gRPC proto declares each field once, so buf / protoc accept it", () => {
    // An entity that models createdAt itself used to get a second created_at = 90.
    const proto = gen({ api: "grpc" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).files.find((f) => f.path.endsWith("service.proto"))!.content;
    for (const [, name, body] of proto.matchAll(/message (\w+) \{\n([\s\S]*?)\n\}/g)) {
      const fields = [...body.matchAll(/^\s+[\w.]+ (\w+) = \d+;/gm)].map((m) => m[1]);
      assert.equal(new Set(fields).size, fields.length, `${name}: duplicate field in ${fields}`);
    }
    assert.match(proto, /message Post \{[\s\S]*created_at = 90;[\s\S]*updated_at = 91;/, "entities without timestamps still get the server-managed ones");
    assert.match(proto, /uint32 page = 1;[^\n]*\n\s+uint32 page_size = 2;/);
  });

  // GraphQL resolvers used to keep entities in sync.Map / Map / dict, so data
  // vanished on restart even with Postgres configured. They must go through
  // the same DB layer as the REST handlers.
  it("GraphQL resolvers persist through the REST DB layer, not an in-memory store", () => {
    for (const framework of ["gin", "fiber", "echo", "chi"]) {
      const { files, get } = gen({ api: "graphql", framework }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const graph = files.filter((f) => f.path.startsWith("graph/"));
      for (const f of graph) assert.doesNotMatch(f.content, /sync\.Map|NewMemoryStore/, `${framework}: ${f.path}`);
      const resolvers = get("graph/schema.resolvers.go")!;
      assert.match(resolvers, /r\.db\.WithContext\(ctx\)\.Create\(&row\)/);
      assert.match(resolvers, /\.Limit\(ps\)\.Offset\(\(p - 1\) \* ps\)/, "listUsers pages in SQL, as the SDL declares");
      assert.match(get("graph/user.go")!, /func userToGQL\(m \*models\.User\) \*User/, "gqlgen and GORM models are mapped explicitly");
      assert.ok(get("internal/models/models.go") && get("internal/db/gorm.go"), `${framework}: REST GORM layer is shipped`);
      const server = get("internal/server/server.go")!;
      assert.match(server, /gormDB, err := db\.OpenGorm[\s\S]*mountGraphQL\(r, gormDB\)/, `${framework}: GraphQL gets the server's DB handle`);
      assert.doesNotMatch(server, /handlers\.|userH/, `${framework}: REST entity routes are not mounted in GraphQL mode`);
      assert.ok(!files.some((f) => f.path.startsWith("internal/handlers/")));
    }
    const mongo = gen({ api: "graphql", database: "mongodb" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.match(mongo.get("graph/schema.resolvers.go")!, /r\.store\.Create\(ctx, userCollection, doc\)/);
    assert.match(mongo.get("internal/server/server.go")!, /db\.OpenMongo[\s\S]*mountGraphQL\(r, store\)/);

    for (const framework of ["express", "fastify", "hono", "nestjs"]) {
      const { get } = gen({ language: "typescript", framework, api: "graphql" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const r = get("src/resolvers/user.ts")!;
      assert.doesNotMatch(r, /new Map/, framework);
      assert.match(r, /import \* as repo from "\.\.\/repositories\/user\.repository"/);
      assert.match(r, /validateUserBody/, "same zod validator as REST");
      assert.match(get("src/repositories/user.repository.ts")!, /prisma\.user\.findMany\(\{ skip, take: pageSize \}\)/);
      assert.ok(get("prisma/schema.prisma"));
      assert.ok(JSON.parse(get("package.json")!).dependencies["@prisma/client"], "Prisma client is a dependency");
    }

    const py = gen({ language: "python", framework: "fastapi", api: "graphql" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const schema = py.get("app/schema.py")!;
    assert.ok(!py.get("app/graphql_store.py") && !schema.includes("store["), "no dict store on SQL databases");
    assert.match(schema, /with SessionLocal\(\) as db:/);
    assert.match(schema, /\.offset\(\(page - 1\) \* page_size\)/);
    assert.match(schema, /row = models\.User\(\*\*data\)/);
    assert.ok(py.get("app/db.py") && py.get("app/models.py"));
    assert.match(py.get("pyproject.toml")!, /^sqlalchemy = /m);
  });

  it("GraphQL resolvers return coded GraphQL errors for missing rows and invalid input", () => {
    const go = gen({ api: "graphql" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.match(go.get("graph/resolver.go")!, /gqlerror\.Error\{Message: msg, Extensions: map\[string\]any\{"code": code\}\}/);
    const goRes = go.get("graph/schema.resolvers.go")!;
    assert.match(goRes, /return nil, lookupErr\(err, "User", input\.ID\)/, "update of a missing row is NOT_FOUND");
    assert.match(goRes, /RowsAffected == 0 \{\n\t\treturn false, notFound\("User", id\)/);
    assert.match(go.get("graph/user.go")!, /badInput\("email must not be empty"\)/);

    const ts = gen({ language: "typescript", framework: "express", api: "graphql" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("src/resolvers/user.ts")!;
    assert.match(ts, /code: "NOT_FOUND"/);
    assert.match(ts, /err instanceof ZodError[\s\S]*code: "BAD_USER_INPUT"/);

    const py = gen({ language: "python", framework: "fastapi", api: "graphql" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("app/schema.py")!;
    assert.match(py, /extensions=\{"code": "NOT_FOUND"\}/);
    assert.match(py, /except \(IntegrityError, DataError\)[\s\S]*"BAD_USER_INPUT"/, "unique violations are input errors, not 500s");
  });

  it("Go GraphQL resolvers match gqlgen's generated names and live only in graph/schema.resolvers.go", async () => {
    const { gqlgenName } = await import("../graphql/go.ts");
    // gqlgen's templates.ToGo — resolver methods and model fields must use these exact names.
    const cases: [string, string][] = [["id", "ID"], ["userId", "UserID"], ["createdAt", "CreatedAt"], ["listApiKeys", "ListAPIKeys"], ["avatarUrl", "AvatarURL"], ["UsersPage", "UsersPage"], ["getUser", "GetUser"]];
    for (const [input, want] of cases) assert.equal(gqlgenName(input), want, input);

    // follow-schema layout: `make gql` copies every resolver body into
    // graph/schema.resolvers.go, so a resolver defined in any other file is a
    // duplicate method and the build breaks.
    const { files } = gen({ api: "graphql", framework: "chi" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const graph = files.filter((f) => f.path.startsWith("graph/") && f.path.endsWith(".go"));
    const want = ["Health", "ListUsers", "GetUser", "ListPosts", "GetPost", "CreateUser", "UpdateUser", "DeleteUser", "CreatePost", "UpdatePost", "DeletePost"];
    for (const m of want) {
      const defs = graph.filter((f) => new RegExp(`^func \\(r \\*(query|mutation)Resolver\\) ${m}\\(`, "m").test(f.content)).map((f) => f.path);
      assert.deepEqual(defs, ["graph/schema.resolvers.go"], m);
    }
    for (const f of graph.filter((x) => x.path !== "graph/schema.resolvers.go")) {
      assert.doesNotMatch(f.content, /^func \(r \*(query|mutation)Resolver\)/m, `${f.path} would be merged by gqlgen`);
    }
  });

  // The builder's queue choice must produce a working broker client in Python
  // repos — not a TODO — reading the env var the repo's .env / compose set.
  const PY_QUEUES: Record<string, { client: RegExp; dep: RegExp; env: string }> = {
    kafka:    { client: /from aiokafka import/, dep: /^aiokafka = /m, env: "KAFKA_BROKERS" },
    rabbitmq: { client: /import aio_pika/, dep: /^aio-pika = /m, env: "RABBITMQ_URL" },
    nats:     { client: /import nats\n/, dep: /^nats-py = /m, env: "NATS_URL" },
    sqs:      { client: /from aiobotocore\.session import get_session/, dep: /^aiobotocore = /m, env: "AWS_REGION" },
    bullmq:   { client: /from bullmq import Queue, Worker/, dep: /^bullmq = /m, env: "REDIS_URL" },
  };
  const QUEUE_EPS = [
    { id: "1", method: "POST" as const, path: "/notifications", summary: "Notify", auth: false, pattern: "send_notification" },
    { id: "2", method: "POST" as const, path: "/webhooks/stripe", summary: "Hook", auth: false, pattern: "webhook_receive" },
    { id: "3", method: "GET" as const, path: "/healthz", summary: "Health", auth: false, pattern: "health_check" },
  ];

  it("Python queue option emits a real client + worker, connected at startup and probed for readiness", () => {
    assert.deepEqual(queues.map((o) => o.id).sort(), Object.keys(PY_QUEUES).sort(), "every catalog queue has a Python client");
    for (const framework of FRAMEWORKS.python) {
      for (const [queue, want] of Object.entries(PY_QUEUES)) {
        const g = gen({ language: "python", framework, queue, auth: "none" }, QUEUE_EPS, []);
        const label = `${framework}/${queue}`;
        const q = g.get("app/queue.py");
        assert.ok(q, `${label}: app/queue.py`);
        assert.match(q!, want.client, label);
        assert.ok(q!.includes(want.env), `${label}: reads ${want.env}`);
        // The env var the client reads is the one the generated .env sets.
        assert.ok(g.get(".env.example")!.includes(want.env + "="), `${label}: .env.example sets ${want.env}`);
        for (const fn of ["connect", "close", "ping", "publish", "consume"]) assert.match(q!, new RegExp(`^async def ${fn}\\(`, "m"), `${label}: ${fn}()`);
        assert.match(g.get("pyproject.toml")!, want.dep, `${label}: client is a declared dependency`);
        // `python -m app.worker` consumes with graceful SIGTERM handling.
        const w = g.get("app/worker.py")!;
        assert.match(w, /broker\.consume\(handle\)/);
        assert.match(w, /signal\.SIGTERM/);
        assert.match(w, /finally:\n\s+await broker\.close\(\)/);

        const main = g.get("app/main.py")!;
        assert.match(main, /from \. import queue as broker/);
        // Startup connects, shutdown closes — FastAPI/Litestar lifespan, Django via an ASGI lifespan wrapper.
        assert.match(main, /await broker\.connect\(\)[\s\S]*await broker\.close\(\)/, `${label}: lifespan`);
        if (framework === "django") assert.match(main, /lifespan\.startup\.complete/);
        // Readiness (/health?ready=1) and the health_check pattern fail when the broker is down.
        assert.match(main, /ready[\s\S]{0,40}not await broker\.ping\(\)/, `${label}: readiness probe`);
        assert.match(main, /checks\["queue"\] = "degraded"/);
        // Patterns publish for real; no placeholder survives.
        assert.match(main, /await broker\.publish\("notifications", payload\.model_dump\(\)\)/, `${label}: send_notification`);
        assert.match(main, /await broker\.publish\("webhooks", /, `${label}: webhook_receive`);
        assert.match(main, /status_code=503, detail="queue_unavailable"/);
        assert.doesNotMatch(main, /TODO: (publish|enqueue)/, label);
      }
    }
  });

  it("Python without a queue answers 503 instead of pretending to publish", () => {
    for (const framework of FRAMEWORKS.python) {
      const g = gen({ language: "python", framework, queue: "none", auth: "none" }, QUEUE_EPS, []);
      assert.ok(!g.get("app/queue.py") && !g.get("app/worker.py"), `${framework}: no broker module`);
      const main = g.get("app/main.py")!;
      assert.doesNotMatch(main, /\bbroker\b/, `${framework}: nothing references the missing broker`);
      // Both queue-backed patterns refuse rather than silently dropping the event.
      assert.equal(main.match(/status_code=503, detail="no_queue_configured"/g)?.length, 2, framework);
    }
  });

  it("Python bullmq keeps the redis pin resolvable next to a Redis cache", () => {
    // bullmq pins redis==7.4.x; a direct redis ^5 dependency would make `poetry install` fail.
    const deps = gen({ language: "python", framework: "fastapi", queue: "bullmq", cache: "redis" }).get("pyproject.toml")!;
    assert.match(deps, /^redis = "\^7\.4\.1"$/m);
    assert.match(gen({ language: "python", framework: "fastapi", queue: "kafka", cache: "redis" }).get("pyproject.toml")!, /^redis = "\^5\.2\.0"$/m);
  });
  // A queue is only useful if something consumes it: docker compose must run the worker
  // each language generates, from the api image with the api's env — and no worker without one.
  it("docker compose runs the generated queue worker next to the api", () => {
    const cases: [string, string, RegExp][] = [
      ["go", "gin", /entrypoint: \["\/worker"\]/],
      ["typescript", "express", /command: \["node", "dist\/worker\.js"\]/],
      ["python", "fastapi", /command: \["python", "-m", "app\.worker"\]/],
      ["rust", "axum", /entrypoint: \["\/worker"\]/],
      ["kotlin", "ktor", /entrypoint: \["java", "-cp", "app\.jar", "Worker"\]/],
    ];
    for (const [language, framework, start] of cases) {
      const compose = gen({ language, framework, queue: "kafka" }).get("docker-compose.yml")!;
      const worker = compose.match(/^  worker:\n[\s\S]*?^    restart: unless-stopped$/m)?.[0];
      assert.ok(worker, `${language}: compose has a worker service`);
      assert.match(worker!, start, `${language}: worker starts the generated consumer`);
      assert.match(worker!, /KAFKA_BROKERS: "kafka:29092"/, `${language}: worker gets the broker address`);
      assert.doesNotMatch(worker!, /ports:/, `${language}: worker publishes no ports`);
    }
    assert.doesNotMatch(gen({ language: "go", framework: "gin", api: "grpc", queue: "kafka" }).get("docker-compose.yml")!, /^  worker:/m);
  });

  // CI's e2e round trip (scripts/e2e-roundtrip.sh) publishes through the app and greps the
  // logs for a `consumed` line carrying the message id: every consumer must log one with the body.
  it("every language's consumer logs a greppable `consumed` line with the message body", () => {
    const cases: [string, string, string, RegExp][] = [
      ["go", "gin", "cmd/worker/main.go", /log\.Info\("consumed", "topic", topic, "body", string\(msg\[:min\(len\(msg\), 200\)\]\)\)/],
      ["typescript", "express", "src/worker.ts", /msg: "consumed", topic: TOPICS\.notifications, body: excerpt\(message\)/],
      ["python", "fastapi", "app/worker.py", /log\.info\("consumed", extra=\{"topic": topic, "body": json\.dumps\(payload\)\[:200\]\}\)/],
      ["rust", "axum", "src/bin/worker.rs", /tracing::info!\(topic = queue::QUEUE, body = [^;]*"consumed"\)/],
      ["java", "spring", "src/main/java/dev/helios/app/messaging/NotificationConsumer.java", /log\.info\("consumed topic=\{\} body=\{\}", NotificationPublisher\.DESTINATION, payload/],
      ["java", "quarkus", "src/main/java/dev/helios/app/messaging/NotificationConsumer.java", /LOG\.infof\("consumed topic=%s body=%s", "notifications", payload/], // Quarkus publisher has no DESTINATION constant
      ["kotlin", "ktor", "src/main/kotlin/Queue.kt", /info\("consumed topic=\{\} body=\{\}", JOBS, message\.take\(200\)\)/],
    ];
    for (const [language, framework, path, re] of cases) {
      for (const queue of ["kafka", "rabbitmq"]) {
        assert.match(gen({ language, framework, queue }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get(path) ?? "", re, `${language}-${framework}/${queue}: ${path}`);
      }
    }
  });

  // JVM stacks have no send_notification route once entities own the API, so the round trip
  // goes through entity create — which must publish the id the e2e job then looks for.
  it("Java entity create publishes <entity>.created with the new id; tests mock the publisher", () => {
    const spring = gen({ language: "java", framework: "spring", queue: "rabbitmq" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const quarkus = gen({ language: "java", framework: "quarkus", queue: "kafka" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    const pascal = SAMPLE_ENTITIES[0].name.replace(/^./, (c) => c.toUpperCase());
    const springCtl = spring.get(`src/main/java/dev/helios/app/controller/${pascal}Controller.java`)!;
    assert.match(springCtl, /saved = service\.create\([\s\S]*publisher\.publish\("\{\\"event\\":\\"[a-z-]+\.created\\",\\"id\\":\\"" \+ saved\.get\w+\(\) \+ "\\"\}"\);/);
    const qRes = quarkus.get(`src/main/java/dev/helios/app/${pascal}Resource.java`)!;
    assert.match(qRes, /entity\.persist\(\);\s*publisher\.publish\("\{\\"event\\":\\"[a-z-]+\.created\\",\\"id\\":\\"" \+ entity\.\w+ \+ "\\"\}"\);/);
    // Unit tests run without a broker: every test that creates entities mocks the publisher.
    for (const f of spring.files.filter((f) => f.path.startsWith("src/test/java/") && f.content.includes("@SpringBootTest"))) {
      assert.match(f.content, /@MockBean\s+dev\.helios\.app\.messaging\.NotificationPublisher publisher;/, f.path);
    }
    for (const f of quarkus.files.filter((f) => f.path.startsWith("src/test/java/") && f.content.includes("@QuarkusTest"))) {
      assert.match(f.content, /@io\.quarkus\.test\.InjectMock\s+dev\.helios\.app\.messaging\.NotificationPublisher publisher;/, f.path);
    }
    assert.match(quarkus.get("pom.xml")!, /quarkus-junit5-mockito/);
    // No queue: no publisher to call or mock.
    const none = gen({ language: "java", framework: "spring", queue: "none" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
    assert.doesNotMatch(none.files.map((f) => f.content).join("\n"), /NotificationPublisher/);
  });

  // ─── Java parity: tracing / rate limit / audit / monitoring / cache / queues ──

  const JAVA = ["spring", "quarkus"] as const;
  const javaGen = (framework: string, overrides: Record<string, unknown> = {}, endpoints = SAMPLE_ENDPOINTS, entities = SAMPLE_ENTITIES) =>
    gen({ language: "java", framework, ...overrides }, endpoints, entities);
  const javaSources = (g: ReturnType<typeof gen>) => g.files.filter((f) => f.path.startsWith("src/main/java/")).map((f) => f.content).join("\n");
  const appProps = (g: ReturnType<typeof gen>) => g.get("src/main/resources/application.properties")!;

  it("Java: each observability toggle adds its library AND the code/config that uses it; off removes both", () => {
    // A dependency without wiring (or wiring without the dependency) is the
    // "claimed but not generated" gap the README used to warn about.
    const wiring: Record<string, Record<string, [RegExp, RegExp]>> = {
      spring: {
        tracing: [/micrometer-tracing-bridge-otel/, /management\.otlp\.tracing\.endpoint=\$\{OTEL_EXPORTER_OTLP_ENDPOINT:/],
        rateLimit: [/bucket4j_jdk17-core/, /class RateLimitFilter extends OncePerRequestFilter[\s\S]*response\.setStatus\(429\)/],
        audit: [/<artifactId>logstash-logback-encoder</, /class AuditFilter extends OncePerRequestFilter[\s\S]*MUTATING\.contains/],
      },
      quarkus: {
        tracing: [/quarkus-opentelemetry/, /quarkus\.otel\.exporter\.otlp\.traces\.endpoint=\$\{OTEL_EXPORTER_OTLP_ENDPOINT:/],
        rateLimit: [/bucket4j_jdk17-core/, /@ServerRequestFilter\(preMatching = true\)[\s\S]*status\(429\)/],
        audit: [/<artifactId>quarkus-resteasy-reactive-jackson</, /@ServerResponseFilter[\s\S]*MUTATING\.contains/],
      },
    };
    for (const framework of JAVA) {
      for (const [flag, [depRe, codeRe]] of Object.entries(wiring[framework])) {
        const on = javaGen(framework, { [flag]: true });
        const off = javaGen(framework, { [flag]: false });
        assert.match(on.get("pom.xml")!, depRe, `${framework} ${flag}: dependency`);
        assert.match(javaSources(on) + appProps(on), codeRe, `${framework} ${flag}: wiring`);
        assert.doesNotMatch(javaSources(off) + appProps(off), codeRe, `${framework} ${flag}=false must not emit the wiring`);
      }
      // Sentry / Datadog: SDK in the pom, DSN / API key read from the env names .env.example documents.
      const sentry = javaGen(framework, { monitoring: "sentry" });
      assert.match(sentry.get("pom.xml")!, framework === "spring" ? /sentry-spring-boot-starter-jakarta/ : /quarkus-logging-sentry/);
      assert.match(appProps(sentry), /dsn=\$\{SENTRY_DSN:\}/);
      assert.ok(sentry.get(".env.example")!.includes("SENTRY_DSN="));
      const dd = javaGen(framework, { monitoring: "datadog" });
      assert.match(dd.get("pom.xml")!, /micrometer-registry-datadog/);
      assert.match(appProps(dd), /datadog[\w.]*\.api-key=\$\{DD_API_KEY:\}/);
      assert.ok(!javaGen(framework, { monitoring: "grafana" }).get("pom.xml")!.includes("datadog"));
    }
  });

  it("Java: every queue option gets a publisher + consumer that read the env var docker-compose/.env set", () => {
    // The app must read the same variable the generated compose file / .env.example provide,
    // otherwise it silently falls back to localhost inside a container.
    const envOf: Record<string, string> = { rabbitmq: "RABBITMQ_URL", kafka: "KAFKA_BROKERS", nats: "NATS_URL", sqs: "AWS_ENDPOINT_URL_SQS", bullmq: "REDIS_URL" };
    for (const framework of JAVA) {
      for (const queue of queues.map((o) => o.id)) {
        const g = javaGen(framework, { queue, cache: "memcached" });
        const env = envOf[queue];
        assert.ok(env, `no expectation for queue ${queue}`);
        assert.ok(appProps(g).includes(`\${${env}:`), `${framework}/${queue}: application.properties must read ${env}`);
        assert.ok(g.get(".env.example")!.includes(`${env}=`) || g.get("docker-compose.yml")!.includes(`${env}:`), `${framework}/${queue}: ${env} is not provided anywhere`);
        const pub = g.get("src/main/java/dev/helios/app/messaging/NotificationPublisher.java");
        const con = g.get("src/main/java/dev/helios/app/messaging/NotificationConsumer.java");
        assert.ok(pub && /public void publish\(String payload\)/.test(pub), `${framework}/${queue}: publisher`);
        assert.ok(con && /void onMessage\(String payload\)/.test(con), `${framework}/${queue}: consumer`);
      }
      assert.ok(!javaGen(framework, { queue: "none" }).files.some((f) => f.path.includes("/messaging/")), "no queue, no messaging code");
      // bullmq has no JVM client: the code must say so instead of pretending to be a BullMQ worker.
      assert.match(javaGen(framework, { queue: "bullmq" }).get("src/main/java/dev/helios/app/messaging/NotificationPublisher.java")!, /BullMQ workers will\s+\*\s+NOT see these messages/);
    }
  });

  it("Java: `mvn test` needs no broker, Redis, exporter or database", () => {
    // CI and new users run the generated tests on a laptop with nothing installed.
    for (const queue of ["rabbitmq", "kafka", "nats", "sqs", "bullmq"]) {
      const spring = javaGen("spring", { queue, monitoring: "datadog" });
      const test = spring.get("src/test/resources/application-test.properties")!;
      assert.match(test, /jdbc:h2:mem:/);
      assert.match(test, /queue\.consumer\.enabled=false/);
      assert.match(test, /spring\.cache\.type=simple/);
      assert.match(test, /management\.datadog\.metrics\.export\.enabled=false/);
      assert.match(spring.get("src/main/java/dev/helios/app/messaging/NotificationConsumer.java")!,
        /@ConditionalOnProperty\(name = "queue\.consumer\.enabled", havingValue = "true", matchIfMissing = true\)/);
      assert.match(spring.get("src/test/java/dev/helios/app/UserControllerTest.java")!, /@ActiveProfiles\("test"\)/);

      const quarkus = appProps(javaGen("quarkus", { queue, monitoring: "sentry" }));
      assert.match(quarkus, /%test\.quarkus\.datasource\.db-kind=h2/);
      assert.match(quarkus, /%test\.quarkus\.otel\.sdk\.disabled=true/);
      assert.match(quarkus, /%test\.quarkus\.log\.sentry\.enabled=false/);
      // SmallRye channels become in-memory; hand-rolled consumers are switched off.
      assert.match(quarkus, /%test\.mp\.messaging\.incoming\.notifications-in\.connector=smallrye-in-memory|%test\.queue\.consumer\.enabled=false/);
    }
    assert.match(javaGen("spring", { queue: "kafka" }).get("src/test/resources/application-test.properties")!, /spring\.kafka\.admin\.auto-create=false/);
  });

  it("Java: Redis cache serves get-by-id and is evicted on every write", () => {
    // Without eviction a PUT/DELETE keeps serving the stale row for the TTL.
    for (const cache of ["redis", "upstash", "dragonfly"]) {
      const spring = javaGen("spring", { cache });
      assert.match(spring.get("pom.xml")!, /spring-boot-starter-data-redis/);
      assert.match(appProps(spring), /spring\.data\.redis\.url=\$\{REDIS_URL:/);
      const svc = spring.get("src/main/java/dev/helios/app/service/UserService.java")!;
      assert.match(svc, /@Cacheable\(cacheNames = "users", key = "#id"[^\n]*\)\n\s+public Optional<User> findById/);
      assert.match(svc, /@CacheEvict\(cacheNames = "users", key = "#id"\)\n\s+public Optional<User> update/);
      assert.match(svc, /@CacheEvict\(cacheNames = "users", key = "#id"\)\n\s+public boolean delete/);
      assert.match(spring.get("src/main/java/dev/helios/app/model/User.java")!, /class User implements java\.io\.Serializable/);
      assert.match(spring.get("src/main/java/dev/helios/app/infra/CacheConfig.java")!, /@EnableCaching/);

      const quarkus = javaGen("quarkus", { cache });
      assert.match(appProps(quarkus), /quarkus\.redis\.hosts=\$\{REDIS_URL:/);
      const res = quarkus.get("src/main/java/dev/helios/app/UserResource.java")!;
      assert.match(res, /cache\.get\("users:" \+ id, User\.class\)[\s\S]*User\.findById\(id\)[\s\S]*cache\.put\("users:" \+ id, entity\)/);
      assert.equal(res.match(/cache\.evict\("users:" \+ id\)/g)?.length, 2, "update and delete evict");
    }
    for (const framework of JAVA) {
      const g = javaGen(framework, { cache: "memcached", queue: "none" });
      assert.ok(!g.get("pom.xml")!.includes("redis"), `${framework}: memcached must not pull in a Redis client`);
      assert.ok(!javaSources(g).includes("Cacheable") && !javaSources(g).includes("JsonCache"));
    }
  });

  it("Java: /health?ready=1 aggregates dependency health; brokers without a built-in check get one", () => {
    const spring = javaGen("spring");
    assert.match(spring.get("pom.xml")!, /spring-boot-starter-actuator/);
    assert.match(spring.get("src/main/java/dev/helios/app/HealthController.java")!, /healthEndpoint\.health\(\)\.getStatus\(\)[\s\S]*up \? 200 : 503/);
    const quarkus = javaGen("quarkus");
    assert.match(quarkus.get("pom.xml")!, /quarkus-smallrye-health/);
    assert.match(quarkus.get("src/main/java/dev/helios/app/HealthResource.java")!, /reporter\.getReadiness\(\)[\s\S]*up \? 200 : 503/);
    // Spring auto-configures Redis + RabbitMQ indicators and SmallRye covers Kafka/RabbitMQ/Redis; the rest are generated.
    const springChecks: Record<string, RegExp> = { kafka: /class KafkaHealthIndicator implements HealthIndicator/, nats: /class NatsConnection implements HealthIndicator/, sqs: /class SqsHealthIndicator implements HealthIndicator/ };
    for (const [queue, re] of Object.entries(springChecks)) assert.match(javaSources(javaGen("spring", { queue })), re, queue);
    for (const queue of ["nats", "sqs"]) assert.match(javaSources(javaGen("quarkus", { queue })), /@Readiness\n@ApplicationScoped\npublic class \w+ implements HealthCheck/, queue);
  });

  it("Java: send_notification stubs publish to the queue; generated imports all resolve", () => {
    const eps = [{ id: "n", method: "POST" as const, path: "/notifications", summary: "", auth: false, pattern: "send_notification" }];
    const spring = javaGen("spring", { queue: "kafka" }, eps, []).get("src/main/java/dev/helios/app/ApiController.java")!;
    assert.match(spring, /postNotifications\(@RequestBody String payload\) \{\n\s+publisher\.publish\(payload\);/);
    const quarkus = javaGen("quarkus", { queue: "nats" }, eps, []).get("src/main/java/dev/helios/app/ApiResource.java")!;
    assert.match(quarkus, /postNotifications\(String payload\) \{\n\s+publisher\.publish\(payload\);/);
    // Without a queue the stub stays a stub (no dangling NotificationPublisher reference).
    assert.ok(!javaGen("spring", { queue: "none" }, eps, []).get("src/main/java/dev/helios/app/ApiController.java")!.includes("NotificationPublisher"));

    // Every `import dev.helios.app.…` points at a generated class — a missing file only shows up at `mvn compile`.
    for (const framework of JAVA) {
      for (const queue of queues.map((o) => o.id)) {
        const g = javaGen(framework, { queue }, [...SAMPLE_ENDPOINTS, ...eps]);
        for (const f of g.files.filter((x) => x.path.endsWith(".java"))) {
          for (const [, cls] of f.content.matchAll(/^import (dev\.helios\.app\.[\w.]+);$/gm)) {
            assert.ok(g.get(`src/main/java/${cls.replace(/\./g, "/")}.java`), `${framework}/${queue}: ${f.path} imports missing ${cls}`);
          }
        }
      }
    }
  });

  it("Kotlin: JUnit Platform builds ship the launcher (Gradle 9 fails `gradle test` without it)", () => {
    for (const framework of ["ktor", "spring-kt"]) {
      const build = gen({ language: "kotlin", framework }).get("build.gradle.kts")!;
      if (build.includes("useJUnitPlatform()")) assert.match(build, /testRuntimeOnly\("org\.junit\.platform:junit-platform-launcher"\)/, framework);
    }
  });

  it("Rust Kafka/Redpanda: pure-Rust rskafka, so the build needs no C toolchain and the binary runs on distroless", () => {
    // rdkafka's bundled librdkafka needs cmake + libcurl headers at build time and libcurl.so at
    // runtime, which gcr.io/distroless/cc-debian12 doesn't ship.
    for (const queue of ["kafka", "redpanda"]) {
      for (const framework of ["axum", "actix"]) {
        const g = gen({ language: "rust", framework, queue });
        const cargo = g.get("Cargo.toml")!;
        assert.match(cargo, /^rskafka = \{ version = "[\d.]+", default-features = false \}$/m, `${framework}/${queue}: no C-backed codecs`);
        assert.doesNotMatch(cargo, /rdkafka/, `${framework}/${queue}`);
        assert.doesNotMatch(g.get("Dockerfile")!, /apt-get|cmake/, `${framework}/${queue}: no build toolchain needed`);
        assert.match(g.get("Dockerfile")!, /FROM gcr\.io\/distroless\/cc-debian12/);
        assert.ok(!g.get(".cargo/config.toml"), `${framework}/${queue}: the CMake policy override is obsolete`);
        const q = g.get("src/queue.rs")!;
        // Comma-separated broker list, topic created if missing, and the missing consumer group is documented.
        assert.match(q, /env::var\("KAFKA_BROKERS"\)[\s\S]*\.split\(','\)/);
        assert.match(q, /controller_client\(\)[\s\S]*create_topic\(QUEUE, 1, 1,/);
        assert.match(q, /ponytail: rskafka has no consumer groups[\s\S]*Upgrade path: rdkafka/);
        // A dead broker must fail a publish, not hang the request handler.
        assert.match(q, /tokio::time::timeout\(Duration::from_secs\(\d+\), open\(\)\)/);
        // After a fetch error the worker resumes after the last handled offset instead of replaying.
        assert.match(q, /StartOffset::At[\s\S]*next = Some\(r\.offset \+ 1\)/);
      }
    }
  });

  // ─── Java contract tests: `mvn test` compiles and passes with no services ──

  const javaContract = (framework: string, overrides: Record<string, unknown> = {}, endpoints = SAMPLE_ENDPOINTS, entities = SAMPLE_ENTITIES) =>
    javaGen(framework, overrides, endpoints, entities).get("src/test/java/dev/helios/app/ApiContractTest.java")!;

  it("Java: ApiContractTest is native to its framework and only references classes the repo has", () => {
    // The old test imported a non-existent <Name>Application from com.example and used Spring in Quarkus repos,
    // so every Java `mvn test` died at test-compile.
    for (const framework of JAVA) {
      const g = javaGen(framework, { auth: "clerk" });
      assert.ok(!g.files.some((f) => f.path.includes("/com/example/")), `${framework}: no stray com.example package`);
      const src = g.get("src/test/java/dev/helios/app/ApiContractTest.java")!;
      assert.match(src, /^package dev\.helios\.app;/);
      assert.doesNotMatch(src, /\w+Application\.class/, "Spring finds dev.helios.app.Application by package; no hardcoded class");
    }
    const spring = javaContract("spring", { auth: "clerk" });
    assert.match(spring, /@SpringBootTest\n@AutoConfigureMockMvc\n@ActiveProfiles\("test"\)/, "runs on the H2 test profile");
    assert.match(spring, /\.with\(jwt\(\)\)/);
    assert.match(spring, /@MockBean\n\s+JwtDecoder jwtDecoder;/, "no JWKS fetch during tests");
    const quarkus = javaContract("quarkus", { auth: "clerk" });
    assert.doesNotMatch(quarkus, /org\.springframework/, "Quarkus repos have no Spring on the classpath");
    assert.match(quarkus, /@QuarkusTest\nclass ApiContractTest/);
    assert.match(quarkus, /@TestSecurity\(user = "test"\)/);
    assert.match(javaGen("quarkus", { auth: "clerk" }).get("pom.xml")!, /<artifactId>quarkus-test-security<\/artifactId>\n\s+<scope>test<\/scope>/, "@TestSecurity needs its test dependency");
    assert.ok(!javaGen("quarkus", { auth: "none" }, SAMPLE_ENDPOINTS.map((e) => ({ ...e, auth: false }))).get("pom.xml")!.includes("quarkus-test-security"));
  });

  it("Java: contract tests cover every CRUD route with 401 / authorized pairs, JSON shape, and unique valid names", () => {
    for (const framework of JAVA) {
      const src = javaContract(framework, { auth: "clerk" });
      const names = [...src.matchAll(/void (\w+)\(\)/g)].map((m) => m[1]);
      assert.equal(new Set(names).size, names.length, `${framework}: test method names are unique`);
      for (const n of names) assert.match(n, /^[A-Za-z_][A-Za-z0-9_]*$/);
      for (const entity of ["Users", "Posts"]) {
        for (const stem of [`get${entity}`, `post${entity}`, `get${entity}ById`, `put${entity}ById`, `delete${entity}ById`]) {
          assert.ok(names.includes(`${stem}_returns401WithoutToken`), `${framework}: ${stem} rejects a missing token`);
          assert.ok(names.some((n) => n.startsWith(`${stem}_returns`) && n.endsWith("WithToken") && !n.includes("401")), `${framework}: ${stem} succeeds when authorized`);
        }
      }
      // By-id routes round-trip a created row: a missing route or a broken id binding can't pass.
      assert.match(src, /String id = createUser\(\);[\s\S]*"\/users\/" \+ id/);
      assert.ok(names.includes("getHealth_returns200"), "health is public even with auth on");
      // Unique columns get a fresh value per request; a fixed one would collide across tests.
      assert.match(src, /"\{\\"name\\":\\"" \+ unique\(\) \+ "\\",\\"email\\":\\"" \+ unique\(\)/);
    }
    // Auth off: no 401 expectations, no principal plumbing.
    const open = SAMPLE_ENDPOINTS.map((e) => ({ ...e, auth: false }));
    for (const framework of JAVA) {
      const src = javaContract(framework, { auth: "none" }, open);
      assert.doesNotMatch(src, /_returns401|\.with\(jwt\(\)\)|@TestSecurity\(/);
      assert.match(src, /postUsers_returns201\(\)/);
    }
  });

  it("Java: endpoint stubs are contract-tested; publish stubs are checked without touching the broker", () => {
    const eps = [
      { id: "a", method: "GET" as const, path: "/reports/:id", summary: "", auth: true },
      { id: "b", method: "GET" as const, path: "/ping", summary: "", auth: false },
      { id: "n", method: "POST" as const, path: "/notifications", summary: "", auth: true, pattern: "send_notification" },
    ];
    const spring = javaContract("spring", { auth: "clerk", queue: "kafka" }, eps, []);
    assert.match(spring, /getReportsById_returns200WithToken[\s\S]*"\/reports\/1"[\s\S]*jsonPath\("\$\.op"\)\.exists\(\)/);
    // SecurityConfig protects every route but /health, so even the auth:false stub expects 401 without a token.
    assert.match(spring, /getPing_returns401WithoutToken/);
    assert.match(spring, /postNotifications_returns400WithToken\(\) throws Exception \{\n\s+mvc\.perform\(request\(HttpMethod\.POST, "\/notifications"\)\.with\(jwt\(\)\)\)/, "no body: rejected before publish");
    const quarkus = javaContract("quarkus", { auth: "clerk", queue: "nats" }, eps, []);
    assert.match(quarkus, /getPing_returns200\(\)/, "Quarkus only guards stubs marked auth");
    assert.match(quarkus, /postNotifications_returns415WithToken\(\) \{\n\s+given\(\)\.contentType\(ContentType\.TEXT\)/, "wrong media type: rejected before publish");
  });

  it("Java: the rate limiter is off in the test profile so contract tests don't trip 429", () => {
    const spring = javaGen("spring", { rateLimit: true });
    assert.match(spring.get("src/test/resources/application-test.properties")!, /^rate-limit\.enabled=false$/m);
    assert.match(spring.get("src/main/java/dev/helios/app/infra/RateLimitFilter.java")!, /@ConditionalOnProperty\(name = "rate-limit\.enabled", havingValue = "true", matchIfMissing = true\)/);
    const quarkus = javaGen("quarkus", { rateLimit: true });
    assert.match(appProps(quarkus), /^%test\.rate-limit\.enabled=false$/m);
    assert.match(quarkus.get("src/main/java/dev/helios/app/infra/RateLimitFilter.java")!, /if \(!enabled \|\| allow\(ip\)\) return Optional\.empty\(\);/);
  });
  // An entity that declares createdAt used to get two created_at columns, so the
  // initial migration failed on Postgres/MySQL and the app never started.
  it("SQL migrations never declare a column twice", () => {
    // TypeScript (Prisma) and Python (Alembic) have no generated .sql; these three do.
    for (const [language, framework, database] of [["java", "spring", "postgres"], ["go", "gin", "mysql"], ["rust", "axum", "postgres"]]) {
      const files = gen({ language, framework, database }, [], SAMPLE_ENTITIES).files.filter((f) => /\.sql$/.test(f.path) && /CREATE TABLE/.test(f.content));
      assert.ok(files.length > 0, `${language}: emits a SQL migration`);
      for (const f of files) {
        for (const [, body] of f.content.matchAll(/CREATE TABLE IF NOT EXISTS \w+ \(\n([\s\S]*?)\n\);/g)) {
          const cols = body.split(",\n").map((l) => l.trim().split(/\s+/)[0]);
          assert.equal(new Set(cols).size, cols.length, `${language} ${f.path}: duplicate column in ${cols}`);
        }
      }
    }
  });
  // Spring runs Hibernate with ddl-auto=validate against the Flyway schema: a `number`
  // field typed Long (bigint) against DOUBLE PRECISION stopped the app from starting.
  it("Java number fields match the migration's DOUBLE PRECISION column", () => {
    const entities = [{ id: "e", name: "Item", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "score", type: "number" as const, required: false, unique: false },
    ] }];
    for (const framework of ["spring", "quarkus"]) {
      const g = gen({ language: "java", framework }, [], entities);
      const model = g.files.find((f) => /model\/Item\.java$|Item\.java$/.test(f.path) && f.content.includes("score"))!;
      assert.match(model.content, /(private|public) Double score;/, `${framework}: score is Double`); // Panache uses public fields
      assert.match(g.files.find((f) => f.path.endsWith(".sql"))!.content, /score DOUBLE PRECISION/);
    }
  });
  // K8s must stop routing traffic to a pod whose broker is gone, or send_notification
  // 503s while the pod still looks ready. Rust used to ping only Redis.
  it("Rust /health?ready=1 pings the queue broker with a bounded timeout", () => {
    const brokerCall: Record<string, RegExp> = {
      rabbitmq: /_conn\.status\(\)\.connected\(\)/,
      kafka: /get_offset\(OffsetAt::Latest\)/,
      nats: /get_stream\(STREAM\)/,
      sqs: /get_queue_url\(\)/,
      bullmq: /cmd\("PING"\)/,
    };
    for (const framework of ["axum", "actix"]) {
      for (const queue of Object.keys(brokerCall)) {
        // mongodb = in-memory store in Rust: the broker alone must still gate readiness.
        const g = gen({ language: "rust", framework, queue, cache: "none", database: "mongodb" });
        const q = g.get("src/queue.rs")!;
        const check = q.slice(q.indexOf("async fn check"));
        assert.match(check.slice(0, check.indexOf("\n}\n")), brokerCall[queue], `${framework}/${queue}: check() talks to the broker`);
        assert.match(q, /pub async fn ping\(\)[\s\S]*from_secs\(2\)[\s\S]*timeout\(LIMIT, probe\)/, `${framework}/${queue}: ping is bounded`);
        const main = g.get("src/main.rs")!;
        assert.match(main, /ready=1[\s\S]*readiness\(\)/, `${framework}/${queue}: /health serves readiness without a cache`);
        assert.match(main, /tokio::join!\(queue::ping\(\)\)/);
        assert.doesNotMatch(main, /db_ping/, "the in-memory store has nothing to ping");
        assert.match(main, /SERVICE_UNAVAILABLE|ServiceUnavailable\(\)/, "a down broker is a 503");
      }
      // A DB that is down must make the pod unready even with no cache or queue.
      for (const [database, pool] of [["postgres", "PgPool"], ["mysql", "MySqlPool"]]) {
        const main = gen({ language: "rust", framework, database, cache: "none", queue: "none" }).get("src/main.rs")!;
        assert.match(main, /tokio::join!\(db_ping\(pool\)\)/, `${framework}/${database}: readiness pings the db`);
        assert.match(main, new RegExp(`async fn db_ping\\(pool: &sqlx::${pool}\\)[\\s\\S]*from_secs\\(2\\), sqlx::query\\("SELECT 1"\\)`), `${framework}/${database}: bounded SELECT 1`);
        assert.match(main, /"\/health", (axum::routing::get|web::get\(\)\.to)\(health\)/);
      }
    }
    // Everything configured: all three are pinged together and reported by name.
    assert.match(gen({ language: "rust", framework: "axum", queue: "nats", cache: "redis", database: "postgres" }).get("src/main.rs")!, /tokio::join!\(db_ping\(pool\), cache::ping\(\), queue::ping\(\)\)/);
  });
  // An auth:true route outside the auth layer is callable by anyone. Rust used to skip
  // the layer entirely for auth "none", leaving POST /notifications (send_notification) open.
  it("Rust: every auth:true route (stub and pattern) sits behind require_auth; auth:false routes don't", () => {
    const ep = (id: string, method: string, path: string, auth: boolean, pattern?: string) =>
      ({ id, method, path, summary: path, auth, ...(pattern ? { pattern } : {}) }) as (typeof SAMPLE_ENDPOINTS)[number];
    const endpoints = [
      ep("1", "GET", "/health", false),
      ep("2", "GET", "/reports/:id", true),
      ep("3", "GET", "/public", false),
      ep("4", "POST", "/notifications", true, "send_notification"),
      ep("5", "POST", "/auth/login", false, "auth_login"),
      ep("6", "GET", "/auth/me", true, "auth_me"),
    ];
    // Protected routes live between the layer's router and its wrap (axum) / inside the scope (actix).
    const protectedBlock = (main: string, fw: string) =>
      fw === "axum"
        ? main.slice(main.indexOf("let protected = Router::new()"), main.indexOf(".route_layer(axum::middleware::from_fn(auth::require_auth))"))
        : main.slice(main.indexOf(".wrap(actix_web::middleware::from_fn(auth::require_auth))"), main.indexOf("\n            )", main.indexOf('web::scope("")')));
    const routeOf = (path: string, fw: string) => `.route("${fw === "axum" ? path : path.replace(/:(\w+)/g, "{$1}")}"`;
    for (const framework of ["axum", "actix"]) {
      for (const auth of ["clerk", "none"]) {
        const g = gen({ language: "rust", framework, auth, queue: "sqs" }, endpoints);
        const main = g.get("src/main.rs")!;
        const block = protectedBlock(main, framework);
        assert.ok(block.length > 0, `${framework}/${auth}: an auth layer exists`);
        for (const e of endpoints.filter((e) => e.path !== "/health")) {
          const r = routeOf(e.path, framework);
          assert.ok(main.includes(r), `${framework}/${auth}: ${e.path} is routed`);
          assert.equal(block.includes(r), e.auth, `${framework}/${auth}: ${e.path} protected iff auth:true`);
        }
        assert.ok(g.get("src/auth.rs"), `${framework}/${auth}: src/auth.rs is emitted`);
      }
      // With entities, only the publish route stays a stub — it and the entity CRUD are protected.
      const main = gen({ language: "rust", framework, auth: "none", queue: "sqs" }, endpoints, SAMPLE_ENTITIES).get("src/main.rs")!;
      const block = protectedBlock(main, framework);
      assert.ok(block.includes(routeOf("/notifications", framework)), `${framework}: /notifications protected alongside entities`);
      assert.match(block, /handlers::user::(router|config)/, `${framework}: entity CRUD protected`);
    }
  });
  // auth "none" + auth_* patterns = self-issued HS256 tokens (JWT_SECRET), exactly like Go/TS/Python;
  // e2e-roundtrip.sh signs its token that way. A missing secret/JWKS config must be a 500, not a pass.
  it("Rust auth.rs verifies the right tokens and fails closed when unconfigured", () => {
    const ep = (id: string, method: string, path: string, auth: boolean, pattern?: string) =>
      ({ id, method, path, summary: path, auth, ...(pattern ? { pattern } : {}) }) as (typeof SAMPLE_ENDPOINTS)[number];
    const selfIssued = [ep("1", "POST", "/auth/login", false, "auth_login"), ep("2", "POST", "/notifications", true, "send_notification")];
    for (const framework of ["axum", "actix"]) {
      const hs = gen({ language: "rust", framework, auth: "none", queue: "sqs" }, selfIssued);
      const hsAuth = hs.get("src/auth.rs")!;
      assert.match(hsAuth, /Validation::new\(Algorithm::HS256\)/);
      assert.match(hsAuth, /DecodingKey::from_secret\(secret\.as_bytes\(\)\)/);
      assert.match(hsAuth, /\["JWT_SECRET"\]/, "missing JWT_SECRET fails closed");
      assert.doesNotMatch(hs.get("Cargo.toml")!, /^reqwest = /m, "no JWKS fetch for self-issued tokens");
      assert.match(hs.get(".env.example")!, /^JWT_SECRET=/m);

      const jw = gen({ language: "rust", framework, auth: "clerk", queue: "sqs" }, selfIssued).get("src/auth.rs")!;
      assert.match(jw, /\["AUTH_JWKS_URL", "AUTH_ISSUER"\]/);
      assert.doesNotMatch(jw, /Algorithm::HS256/, "a provider's tokens are never accepted as HS256");

      for (const a of [hsAuth, jw]) {
        const mw = a.slice(a.indexOf("pub async fn require_auth"));
        const fail = mw.search(/INTERNAL_SERVER_ERROR|ErrorInternalServerError/);
        assert.ok(fail > 0 && fail < mw.search(/UNAUTHORIZED|ErrorUnauthorized/), `${framework}: unconfigured → 500 before any token check`);
      }
      // Nothing protected and nothing issued: no verifier, same as the other languages.
      assert.equal(gen({ language: "rust", framework, auth: "none" }, [ep("1", "GET", "/public", false)]).get("src/auth.rs"), undefined);
    }
  });

  // The server owns GET /health (liveness + readiness). A user GET /health used to
  // be registered a second time, and Fastify refuses to boot on a duplicate route.
  it("TypeScript: a user GET /health (stub or health_check pattern) never duplicates the built-in route", () => {
    for (const pattern of [undefined, "health_check"]) {
      const eps = [{ id: "h", method: "GET", path: "/health", summary: "Health", auth: false, ...(pattern ? { pattern } : {}) }];
      for (const framework of ["express", "fastify", "hono", "nestjs"]) {
        for (const queue of ["none", "nats"]) {
          const g = gen({ language: "typescript", framework, queue }, eps as never);
          const main = g.get(framework === "nestjs" ? "src/app.controller.ts" : "src/main.ts")!;
          const n = main.match(/\b(get|Get)\("\/health"/g)?.length ?? 0;
          assert.equal(n, 1, `${framework} queue=${queue} pattern=${pattern}: /health registered ${n} times`);
        }
      }
    }
  });
  // `nats` on npm is deprecated; its maintained successors are the @nats-io/* v3 modules.
  it("TypeScript NATS uses @nats-io/transport-node + @nats-io/jetstream, not the deprecated `nats` package", () => {
    const g = gen({ language: "typescript", framework: "fastify", queue: "nats" });
    const deps = JSON.parse(g.get("package.json")!).dependencies;
    assert.equal(deps.nats, undefined);
    assert.ok(deps["@nats-io/transport-node"] && deps["@nats-io/jetstream"]);
    const q = g.get("src/queue.ts")!;
    assert.doesNotMatch(q, /from "nats"/);
    assert.match(q, /from "@nats-io\/transport-node"/);
    assert.match(q, /jetstreamManager\(c\)/); // v3 API: free functions over the connection
    assert.match(q, /process\.env\.NATS_URL/);
  });
  // Self-issued auth used to INSERT password_hash/name into the user's own `users`
  // table and skip its required columns, so register failed for any User entity that
  // didn't happen to declare them. Hashes now live in a generated auth_credentials
  // table keyed by the User PK; register fills the entity's real columns.
  it("self-issued auth (go/python) stores hashes in auth_credentials, never on the user's entity", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f3", name: "score", type: "number" as const, required: false, unique: false },
      { id: "f4", name: "active", type: "boolean" as const, required: true, unique: false },
      { id: "f5", name: "createdAt", type: "date" as const, required: true, unique: false },
    ] }];
    const eps = (["auth_register", "auth_login", "auth_change_password", "auth_me"] as const).map((pattern, i) =>
      ({ id: `a${i}`, method: "POST" as const, path: `/auth/${pattern}`, summary: pattern, auth: pattern === "auth_change_password" || pattern === "auth_me", pattern }));
    const sql = (g: ReturnType<typeof gen>) => g.files.filter((f) => f.path.endsWith(".sql") || f.path.includes("migrations/versions/")).map((f) => f.content).join("\n");
    for (const [language, framework] of [["go", "gin"], ["go", "chi"], ["python", "fastapi"], ["python", "litestar"], ["python", "django"]]) {
      const g = gen({ language, framework, auth: "none", database: "postgres" }, eps, user);
      const usersDdl = sql(g).match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\);/)![1];
      assert.doesNotMatch(usersDdl, /password/, `${framework}: the user's table keeps exactly its declared columns`);
      assert.match(sql(g), /CREATE TABLE IF NOT EXISTS auth_credentials \([\s\S]{0,30}user_id UUID PRIMARY KEY[\s\S]*password_hash VARCHAR\(255\) NOT NULL/, `${framework}: hashes get their own table, typed like the User PK`);
      const code = language === "go" ? g.get("internal/handlers/api.go")! : g.get("app/main.py")!;
      assert.match(code, /missing required fields/, `${framework}: an omitted required column is a 400, not a NOT NULL failure`);
      assert.match(code, language === "go" ? /\[\]string\{"active"\}/ : /\["active"\] if payload\.get\(f\) is None/, `${framework}: 'active' is required; optional 'score' and stamped 'createdAt' are not`);
      assert.match(code, language === "go" ? /"created_at": time\.Now\(\)/ : /createdAt=datetime\.utcnow\(\)/, `${framework}: required dates are stamped`);
      assert.doesNotMatch(code, /"name":|\bname=/, `${framework}: register no longer writes an undeclared name column`);
      assert.ok(code.match(/auth_credentials|AuthCredential\b/g)!.length >= 3, `${framework}: register, login and change_password all use the credentials table`);
      if (language === "python") assert.match(g.get("app/models.py")!, /class AuthCredential\(Base\):\n    __tablename__ = "auth_credentials"/);
    }
    // With a provider the credential endpoints are 501s, so there is nothing to store.
    assert.doesNotMatch(sql(gen({ language: "python", framework: "fastapi", auth: "clerk", database: "postgres" }, eps, user)), /auth_credentials/);
    // No usable User entity: an explicit 501 instead of queries against a table that doesn't exist.
    assert.match(gen({ language: "go", framework: "gin", auth: "none" }, eps, []).get("internal/handlers/api.go")!, /Declare a User entity[\s\S]*StatusNotImplemented/);
  });
  // TS register/login/change_password were commented-out stubs: register answered 201
  // without persisting anything and login could never succeed. They now use a Prisma
  // AuthCredential (auth_credentials) like Go/Python. And a credential row must die
  // with its user everywhere — otherwise a deleted account keeps a live password.
  it("self-issued auth: TS persists hashes via Prisma AuthCredential; credentials cascade with the user", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f4", name: "active", type: "boolean" as const, required: true, unique: false },
      { id: "f5", name: "createdAt", type: "date" as const, required: true, unique: false },
    ] }];
    const eps = (["auth_register", "auth_login", "auth_change_password", "auth_me"] as const).map((pattern, i) =>
      ({ id: `a${i}`, method: "POST" as const, path: `/auth/${pattern}`, summary: pattern, auth: pattern === "auth_change_password" || pattern === "auth_me", pattern }));
    for (const framework of ["express", "fastify", "hono", "nestjs"]) {
      const g = gen({ language: "typescript", framework, auth: "none", database: "postgres" }, eps, user);
      const schema = g.get("prisma/schema.prisma")!;
      assert.match(schema, /model AuthCredential \{[\s\S]*@relation\(fields: \[user_id\], references: \[id\], onDelete: Cascade\)[\s\S]*@@map\("auth_credentials"\)/, `${framework}: credential row is deleted with its user`);
      assert.match(schema, /model User \{[^}]*authCredential AuthCredential\?/, `${framework}: Prisma needs the back-relation`);
      const code = g.get(framework === "nestjs" ? "src/app.controller.ts" : "src/main.ts")!;
      assert.match(code, /import \{ prisma \} from "\.\/db"/, `${framework}: auth handlers reach the DB`);
      assert.match(code, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*tx\.user\.create[\s\S]*tx\.authCredential\.create/, `${framework}: user + credential are written atomically`);
      assert.match(code, /\["active"\]\.filter\(\(k\) => body\[k\] == null\)/, `${framework}: an omitted required column is a 400 by name`);
      assert.match(code, /createdAt: new Date\(\)/, `${framework}: required dates are stamped`);
      assert.match(code, /email_already_registered/);
      assert.match(code, /include: \{ authCredential: true \}/, `${framework}: login checks the stored hash`);
      assert.match(code, /prisma\.authCredential\.update/, `${framework}: change_password persists the new hash`);
      assert.doesNotMatch(code, /passwordHash: string \} \| null|\/\/ await prisma\.user\.update/, `${framework}: no placeholder stubs left`);
    }
    // Mongo has no Prisma data layer: an explicit 501 rather than a fake success.
    assert.match(gen({ language: "typescript", framework: "express", auth: "none", database: "mongodb" }, eps, user).get("src/main.ts")!, /Declare a User entity[\s\S]*res\.status\(501\)/);
    // With a provider the credential endpoints are 501s: no credentials model.
    assert.doesNotMatch(gen({ language: "typescript", framework: "express", auth: "clerk", database: "postgres" }, eps, user).get("prisma/schema.prisma")!, /AuthCredential/);
    // SQL migrations (every dialect) and SQLAlchemy carry the FK; SQLite connections opt into enforcing it.
    const sql = (g: ReturnType<typeof gen>) => g.files.filter((f) => f.path.endsWith(".sql") || f.path.includes("migrations/versions/")).map((f) => f.content).join("\n");
    for (const database of ["postgres", "mysql", "sqlite"]) {
      assert.match(sql(gen({ language: "go", framework: "gin", auth: "none", database }, eps, user)), /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/, `${database}: table-level FK (MySQL ignores inline REFERENCES)`);
    }
    const py = gen({ language: "python", framework: "fastapi", auth: "none", database: "sqlite" }, eps, user);
    assert.match(py.get("app/models.py")!, /user_id = Column\(String\(36\), ForeignKey\("users\.id", ondelete="CASCADE"\)/);
    assert.match(py.get("app/db.py")!, /PRAGMA foreign_keys=ON/, "SQLite ignores ON DELETE CASCADE unless each connection enables it");
    assert.match(gen({ language: "go", framework: "gin", auth: "none", database: "sqlite" }, eps, user).get("internal/db/gorm.go")!, /_pragma=foreign_keys\(1\)/);
  });

  // e2e CRUD (scripts/e2e-crud.sh) runs against a fresh database: the Rust api must create
  // its tables itself, and a NULL in an optional column must still decode into the row type.
  it("rust: api runs the sqlx migrations at startup; optional fields are Option<T> in the row", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f3", name: "score", type: "number" as const, required: false, unique: false },
      { id: "f6", name: "meta", type: "json" as const, required: false, unique: false },
      { id: "f4", name: "active", type: "boolean" as const, required: true, unique: false },
    ] }];
    for (const framework of ["axum", "actix"]) {
      for (const database of ["postgres", "mysql"]) {
        const g = gen({ language: "rust", framework, auth: "none", database }, SAMPLE_ENDPOINTS, user);
        const label = `${framework}/${database}`;
        assert.match(g.get("Cargo.toml")!, /sqlx = \{[^}]*"migrate"/, `${label}: migrate!() needs the sqlx migrate feature`);
        assert.match(g.get("src/main.rs")!, /db::connect[^\n]*\n[\s\S]*sqlx::migrate!\("\.\/migrations"\)\.run\(&pool\)/, `${label}: api migrates right after connecting`);
        assert.ok(g.files.some((f) => /^migrations\/\d+_[a-z_]+\.up\.sql$/.test(f.path)), `${label}: sqlx's <version>_<name>.up.sql naming`);
        if (g.get("src/bin/worker.rs")) assert.doesNotMatch(g.get("src/bin/worker.rs")!, /migrate!/, `${label}: only the api migrates`);
        const model = g.get("src/models/user.rs")!.split("pub struct CreateUser")[0];
        assert.match(model, /pub id: [^\n]*Uuid|pub id: String/, `${label}: pk stays non-optional`);
        assert.match(model, /pub email: String,/);
        assert.match(model, /pub score: Option<f64>,/, `${label}: nullable column decodes as Option`);
        assert.match(model, /pub meta: Option<serde_json::Value>,/);
        assert.match(model, /pub active: bool,/);
      }
    }
    // MySQL 8 rejects CREATE INDEX IF NOT EXISTS, which would fail the startup migration.
    const up = (database: string) => gen({ language: "rust", framework: "axum", database }, SAMPLE_ENDPOINTS, user).files.find((f) => f.path.endsWith(".up.sql"))!.content;
    assert.doesNotMatch(up("mysql"), /IF NOT EXISTS idx_/);
    assert.match(up("mysql"), /CREATE INDEX idx_users_id ON users \(id\);/);
    // No entities → no migrations dir, so no migrate!() (it would fail to compile).
    assert.doesNotMatch(gen({ language: "rust", framework: "axum", database: "postgres" }).get("src/main.rs")!, /migrate!/);
  });
  // Python repos couldn't run against a migrated DB: Alembic executed each SQL *line*
  // on its own (a CREATE TABLE split mid-statement), and SQLAlchemy mapped camelCase
  // column names while db/sql.ts creates snake_case ones. JSON keeps the entity names.
  it("python: alembic runs whole statements; models map onto the migration's snake_case columns", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f3", name: "lastLoginAt", type: "date" as const, required: false, unique: false },
      { id: "f5", name: "createdAt", type: "date" as const, required: true, unique: false },
    ] }];
    const eps = [{ id: "a", method: "POST" as const, path: "/auth/register", summary: "r", auth: false, pattern: "auth_register" as const }];
    for (const database of ["postgres", "mysql", "sqlite"]) {
      const g = gen({ language: "python", framework: "fastapi", auth: "none", database }, eps, user);
      const mig = g.get("migrations/versions/0001_init.py")!;
      const stmts = [...mig.matchAll(/op\.execute\("""\n([\s\S]*?)\n"""\)/g)].map((m) => m[1]);
      assert.equal(stmts.length, (mig.match(/op\.execute\(/g) ?? []).length, `${database}: every execute is one triple-quoted statement`);
      for (const s of stmts) {
        assert.match(s, /^(CREATE|DROP) /, `${database}: each execute starts a statement, not a column line`);
        assert.equal((s.match(/\(/g) ?? []).length, (s.match(/\)/g) ?? []).length, `${database}: statement is whole: ${s}`);
      }
      const ddl = mig.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\)/)![1];
      const dbCols = new Set([...ddl.matchAll(/^ {2}(\w+) /gm)].map((m) => m[1]));
      const model = g.get("app/models.py")!.split("class AuthCredential")[0].split("class User(Base):")[1];
      const mapped = [...model.matchAll(/^ {4}(\w+) = Column\((?:"(\w+)", )?/gm)].map((m) => m[2] ?? m[1]);
      assert.deepEqual(new Set(mapped), dbCols, `${database}: SQLAlchemy columns are exactly the migrated ones`);
      assert.match(model, /createdAt = Column\("created_at", DateTime, default=datetime\.utcnow\)/, "attribute (JSON) stays camelCase; the managed column gets a default");
    }
  });
  // FastAPI mounted app/routers/<entity>.py (no auth, raw ORM objects) before main.py's
  // pattern handlers, so GET/PUT/DELETE /users/{id} marked auth:true were served unauthenticated.
  it("python: an auth:true entity route is never also served by an unguarded router", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
    ] }];
    const crud = ([["GET", "/users", "crud_list", false], ["GET", "/users/:id", "crud_get", true], ["POST", "/users", "crud_create", true],
      ["PUT", "/users/:id", "crud_update", true], ["DELETE", "/users/:id", "crud_delete", true], ["POST", "/auth/login", "auth_login", false]] as const)
      .map(([method, path, pattern, auth], i) => ({ id: `c${i}`, method, path, summary: pattern, auth, pattern }));
    const g = gen({ language: "python", framework: "fastapi", auth: "none", database: "postgres" }, crud, user);
    const main = g.get("app/main.py")!;
    assert.equal(g.get("app/routers/user.py"), undefined, "no second CRUD implementation for a pattern-served entity");
    assert.doesNotMatch(main, /include_router/);
    for (const route of ['get("/users/{id}"', 'post("/users"', 'put("/users/{id}"', 'delete("/users/{id}"'])
      assert.match(main, new RegExp(`@app\\.${route.replace(/[(){}]/g, "\\$&")}[^\\n]*dependencies=\\[Depends\\(auth_required\\)\\]`), `${route} is guarded`);
    assert.match(main, /__mapper__\.column_attrs/, "responses serialize by attribute (JSON) name, not ORM objects or DB column names");
    // Without crud_* patterns the router remains the entity's only CRUD surface.
    assert.ok(gen({ language: "python", framework: "fastapi", auth: "none", database: "postgres" }, [], user).get("app/routers/user.py"));
  });
  // Nothing created the schema at container start, so every TS CRUD route hit a missing
  // table against a fresh database. The api now runs `prisma db push` before listening;
  // the worker (compose `command:` override) must not, or two processes race on DDL.
  it("TS images create the Prisma schema at api start (api only, CLI kept in the runtime)", () => {
    for (const framework of ["express", "fastify", "hono", "nestjs"]) {
      const g = gen({ language: "typescript", framework, database: "postgres", queue: "kafka" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      const docker = g.get("Dockerfile")!;
      assert.match(docker, /CMD \["sh", "-c", "node_modules\/\.bin\/prisma db push --skip-generate && exec node dist\/main\.js"\]/, `${framework}: schema synced before the api listens`);
      assert.doesNotMatch(docker, /--accept-data-loss/, `${framework}: a destructive schema change must stop the boot, not drop data`);
      assert.match(docker, /COPY --from=build \/app\/prisma \.\/prisma/, `${framework}: db push needs schema.prisma at runtime`);
      const pkg = JSON.parse(g.get("package.json")!);
      assert.ok(pkg.dependencies.prisma && !pkg.devDependencies.prisma, `${framework}: prisma CLI survives npm prune --omit=dev`);
      assert.match(g.get("docker-compose.yml")!, /worker:[\s\S]*?command: \["node", "dist\/worker\.js"\]/, `${framework}: worker overrides CMD, so only the api touches the schema`);
    }
    // No Prisma (no entities), no schema step: the image just starts the server.
    const plain = gen({ language: "typescript", framework: "express", database: "postgres" }, SAMPLE_ENDPOINTS, []).get("Dockerfile")!;
    assert.match(plain, /CMD \["node", "dist\/main\.js"\]/);
    assert.doesNotMatch(plain, /prisma db push/);
  });
  // Quarkus PUT answered 200 but never copied the body onto the row, so e2e-crud.sh's
  // score→42 / active→false check failed. And Hibernate's default naming kept camelCase
  // columns, diverging from the snake_case migration every other stack uses.
  it("Quarkus: PUT applies every writable field; columns are snake_case like the migration", () => {
    const user = [{ id: "e1", name: "User", fields: [
      { id: "f1", name: "id", type: "uuid" as const, required: true, unique: true, primaryKey: true },
      { id: "f2", name: "email", type: "string" as const, required: true, unique: true },
      { id: "f3", name: "score", type: "number" as const, required: false, unique: false },
      { id: "f4", name: "active", type: "boolean" as const, required: true, unique: false },
      { id: "f5", name: "createdAt", type: "date" as const, required: true, unique: false },
    ] }];
    const g = gen({ language: "java", framework: "quarkus", auth: "none", database: "postgres" }, [], user);
    const update = g.get("src/main/java/dev/helios/app/UserResource.java")!.match(/public Response update[\s\S]*?\n    }/)![0];
    for (const f of ["email", "score", "active", "createdAt"]) {
      assert.match(update, new RegExp(`if \\(updates\\.${f} != null\\) existing\\.${f} = updates\\.${f};`), `PUT writes ${f}`);
    }
    assert.doesNotMatch(update, /updates\.id\b/, "the path id wins; the body can't re-key the row");
    assert.match(g.get("src/main/resources/application.properties")!, /physical-naming-strategy=org\.hibernate\.boot\.model\.naming\.CamelCaseToUnderscoresNamingStrategy/);
    assert.match(g.get("src/test/java/dev/helios/app/UserResourceTest.java")!, /void updateUser_appliesBody\(\)[\s\S]*put\("\/users\/" \+ id\)[\s\S]*equalTo\(changed\)[\s\S]*get\("\/users\/" \+ id\)/, "mvn test proves the change sticks");
  });

  // e2e CRUD against compose Postgres: nothing created the tables (cmd/migrate was never run),
  // so every /users call 500'd. The api now migrates itself from embedded SQL before serving.
  it("Go api applies embedded migrations at startup, before opening GORM, on every SQL dialect", () => {
    for (const database of ["postgres", "mysql", "sqlite"]) {
      const g = gen({ database, auth: "none" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES);
      assert.match(g.get("migrations/migrations.go")!, /\/\/go:embed \*\.sql\nvar FS embed\.FS/, `${database}: SQL ships inside the binary`);
      assert.match(g.get("internal/db/migrate.go")!, /migrations\.FS/, `${database}: runner reads the embedded files, not ./migrations on disk`);
      const server = g.get("internal/server/server.go")!;
      assert.ok(server.indexOf("db.Migrate(cfg.DatabaseURL)") > 0 && server.indexOf("db.Migrate(") < server.indexOf("db.OpenGorm("), `${database}: schema exists before serving`);
      assert.match(server, /db\.Migrate\(cfg\.DatabaseURL\); err != nil \{\n\t\tlog\.Error\("migrate", "err", err\)\n\t\tos\.Exit\(1\)/, `${database}: a failed migration stops the pod instead of serving 500s`);
    }
    // Replicas race at startup: golang-migrate's DB lock + ErrNoChange make that safe.
    assert.match(gen({ auth: "none" }, SAMPLE_ENDPOINTS, SAMPLE_ENTITIES).get("internal/db/migrate.go")!, /errors\.Is\(err, migrate\.ErrNoChange\)/);
    // No entities -> no migrations -> no Migrate call (it would not compile).
    assert.doesNotMatch(gen({ auth: "none" }, SAMPLE_ENDPOINTS, []).get("internal/server/server.go")!, /db\.Migrate/);
  });
  // POST /users inserted a map, so the response only echoed the client's fields: no id
  // unless the client invented one. The model's hooks and DB defaults need a typed row.
  it("Go CRUD pattern handlers use the entity's GORM model so ids/timestamps come back and updates write zero values", () => {
    const eps = ([["GET", "/users", "crud_list"], ["GET", "/users/:id", "crud_get"], ["POST", "/users", "crud_create"],
      ["PUT", "/users/:id", "crud_update"], ["DELETE", "/users/:id", "crud_delete"], ["GET", "/reports/:id", "crud_get"]] as const)
      .map(([method, path, pattern], i) => ({ id: `c${i}`, method, path, summary: pattern, auth: false, pattern }));
    for (const framework of ["gin", "fiber", "echo", "chi"]) {
      const g = gen({ framework, auth: "none" }, eps as never, SAMPLE_ENTITIES);
      const api = g.get("internal/handlers/api.go")!;
      const fn = (name: string) => api.match(new RegExp(`\\) ${name}\\([\\s\\S]*?\\n}\\n`))![0];
      assert.match(api, /"github\.com\/your-username\/[\w-]+\/internal\/models"/, `${framework}: imports the models`);
      assert.match(fn("HandlePostUsers"), /var body models\.User[\s\S]*\.Create\(&body\)/, `${framework}: create returns the typed row (BeforeCreate id, CreatedAt)`);
      assert.doesNotMatch(fn("HandlePostUsers"), /var body map\[string\]any/);
      assert.match(fn("HandleGetUsersById"), /var row models\.User/);
      assert.match(fn("HandleGetUsers"), /var rows \[\]models\.User/);
      const put = fn("HandlePutUsersById");
      assert.match(put, /pk := existing\.Id[\s\S]*&existing\)[\s\S]*existing\.Id = pk[\s\S]*\.Save\(&existing\)/, `${framework}: overlay + Save writes active=false; the key can't be changed by the body`);
      assert.doesNotMatch(put, /Updates\(/, `${framework}: Updates(struct) would silently skip zero values`);
      assert.match(fn("HandleDeleteUsersById"), /RowsAffected == 0/, `${framework}: deleting a missing row is a 404`);
      // A table with no entity keeps the untyped fallback.
      assert.match(fn("HandleGetReportsById"), /var row map\[string\]any/);
    }
    // Non-SQL stacks have no internal/models package.
    assert.doesNotMatch(gen({ database: "mongodb", auth: "none" }, eps as never, SAMPLE_ENTITIES).get("internal/handlers/api.go") ?? "", /models\./);
    // Soft delete would keep "deleted" rows visible (and needs a deleted_at column the migration lacks).
    assert.doesNotMatch(gen({ auth: "none" }, eps as never, SAMPLE_ENTITIES).get("internal/models/models.go")!, /DeletedAt/);
  });
});

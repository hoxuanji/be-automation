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
    assert.match(app, /fun Application\.module\(\)[\s\S]*routing \{/);
    assert.match(app, /embeddedServer\(Netty, .*module = Application::module\)/);
    const test = ktor.get("src/test/kotlin/UserRouteTest.kt")!;
    assert.equal(test.match(/application \{ module\(\) \}/g)?.length, test.match(/testApplication \{/g)?.length);
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

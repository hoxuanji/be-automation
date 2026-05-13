import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../index.ts";

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

const API_MODES = ["rest", "grpc"] as const;

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

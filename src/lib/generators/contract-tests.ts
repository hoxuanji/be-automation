import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { isGraphqlSupported, safeName, toKebab, toPascal } from "./types";
import { goQueueKind } from "./queue/go";
import { goAuthMode, goDbKind } from "./go";
import { kotlinContractTestFiles } from "./kotlin";
import { javaContractTestFiles } from "./java";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectedStatus(method: string, _auth: boolean): number {
  if (method === "POST") return 201;
  if (method === "DELETE") return 204;
  return 200;
}

function pathToParam(path: string): string {
  // /users/:id → /users/test-id-123
  return path.replace(/:([a-zA-Z_]+)/g, "test-$1-123");
}

function _authHeader(auth: boolean, lang: "go" | "ts" | "py" | "rust" | "java"): string {
  if (!auth) return "";
  switch (lang) {
    case "ts":  return ', { headers: { Authorization: "Bearer test-token" } }';
    case "py":  return ', headers={"Authorization": "Bearer test-token"}';
    case "go":  return '\n\treq.Header.Set("Authorization", "Bearer test-token")';
    case "rust": return '.header("Authorization", "Bearer test-token")';
    case "java": return '\n        headers.set("Authorization", "Bearer test-token");';
  }
}

// ─── TypeScript (vitest + supertest) ─────────────────────────────────────────

function tsContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const framework = config.framework;
  const isNest = framework === "nestjs";

  const imports = isNest
    ? `import { Test } from '@nestjs/testing';\nimport * as request from 'supertest';\nimport { AppModule } from '../src/app.module';`
    : `import request from 'supertest';\nimport { createApp } from '../src/app';`;

  const setup = isNest
    ? `let app: any;

beforeAll(async () => {
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});`
    : `let app: any;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  if (app?.close) await app.close();
});`;

  const tests = endpoints.map((ep) => {
    const method = ep.method.toLowerCase();
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const body = ["POST", "PUT", "PATCH"].includes(ep.method) ? "\n      .send({})" : "";
    const auth = ep.auth ? '\n      .set("Authorization", "Bearer test-token")' : "";

    return `
  it('${ep.method} ${ep.path}', async () => {
    const res = await request(app)
      .${method}('${testPath}')${auth}${body};
    // ${ep.summary}
    expect(res.status).toBe(${status});
    expect(res.headers['content-type']).toMatch(/json/);
  });`;
  }).join("\n");

  return `import { describe, it, expect, beforeAll, afterAll } from 'vitest';
${imports}

describe('API contract tests — ${safeName(config.name)}', () => {
${setup}
${tests}
});
`;
}

// ─── Go (testing + net/http/httptest) ────────────────────────────────────────

// Every route must be mounted on the in-process server; protected routes must
// reject a request without a bearer token (401, decided by authRequired before
// any handler runs) and plain stub handlers answer 200. Pattern handlers'
// statuses depend on data and dependencies, so for them the contract is "the
// router matched" — their behaviour is covered by the e2e job.
function goContractTests(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): string {
  const module = `github.com/your-username/${safeName(config.name)}`;
  const isFiber = config.framework === "fiber";

  // With a real verifier (goAuthMode) protected routes must reject a request
  // without a valid token; with auth off they behave like public routes.
  const authEnforced = goAuthMode(config, endpoints) !== "off";

  const testServerSetup = isFiber
    ? `\t\tsrv := server.New(cfg, slog.Default())\n\t\tts = httptest.NewServer(adaptor.FiberApp(srv.App()))`
    : `\t\tsrv := server.New(cfg, slog.Default())\n\t\tts = httptest.NewServer(srv.Handler())`;

  // server.New exits the process when its database or broker is unreachable,
  // so probe them with the same openers first and skip (not fail) without them.
  const kind = goDbKind(config.database);
  const dbProbe =
    kind === "postgres" || kind === "mysql"
      ? `\tif cfg.DatabaseURL == "" {\n\t\tskipReason = "DATABASE_URL is not set; these tests need a reachable database"\n\t} else if conn, err := db.Open(cfg.DatabaseURL); err != nil {\n\t\tskipReason = "database unreachable (check DATABASE_URL): " + err.Error()\n\t} else {\n\t\t_ = conn.Close()\n\t}\n`
      : kind === "mongo"
        ? `\tif store, err := db.OpenMongo(context.Background(), cfg.MongoURI); err != nil {\n\t\tskipReason = "database unreachable (set MONGODB_URI to run): " + err.Error()\n\t} else {\n\t\t_ = store.Close(context.Background())\n\t}\n`
        : "";
  const queueProbe = goQueueKind(config.queue)
    ? `\tif skipReason == "" {\n\t\tif q, err := queue.Open(context.Background(), cfg); err != nil {\n\t\t\tskipReason = "message broker unavailable: " + err.Error()\n\t\t} else {\n\t\t\t_ = q.Close()\n\t\t}\n\t}\n`
    : "";
  const probes = dbProbe + queueProbe;

  // Mirrors goServer's routing: GET /health is the server's liveness check, and
  // a stub endpoint colliding with an entity CRUD route yields to that handler.
  const key = (m: string, p: string) => `${m} ${p.replace(/:[A-Za-z0-9_]+/g, ":p")}`;
  const entityKeys = new Set(entities.flatMap((e) => {
    const base = `/${toKebab(e.name)}s`;
    return [["GET", base], ["GET", `${base}/:id`], ["POST", base], ["PATCH", `${base}/:id`], ["DELETE", `${base}/:id`]].map(([m, p]) => key(m, p));
  }));
  const isStub = (ep: Endpoint) =>
    (ep.method === "GET" && ep.path === "/health") ||
    (!ep.pattern && !ep.logicCode && !entityKeys.has(key(ep.method, ep.path)));

  let usesServed = false;
  const tests = endpoints.map((ep) => {
    const testPath = pathToParam(ep.path);
    const body = ["POST", "PUT", "PATCH"].includes(ep.method) ? "{}" : "";
    let check: string;
    if (ep.auth && authEnforced) {
      check = `\tif resp.StatusCode != http.StatusUnauthorized {\n\t\tt.Errorf("${ep.method} ${ep.path}: expected 401 without a token, got %d", resp.StatusCode)\n\t}`;
    } else if (isStub(ep)) {
      check = `\tif resp.StatusCode != http.StatusOK {\n\t\tt.Errorf("${ep.method} ${ep.path}: expected 200, got %d", resp.StatusCode)\n\t}`;
    } else {
      usesServed = true;
      check = `\tif !served(resp) {\n\t\tt.Errorf("${ep.method} ${ep.path}: route is not mounted (got %d)", resp.StatusCode)\n\t}`;
    }
    return `
func Test${toPascal(ep.method)}${toPascal(ep.path.replace(/[/:]/g, "_"))}(t *testing.T) {
\trequireServer(t)
\t// ${ep.summary}
\tresp := call(t, "${ep.method}", "${testPath}", ${JSON.stringify(body)})
${check}
}`;
  }).join("\n");

  const std = [
    probes.includes("context.") ? "context" : "",
    usesServed ? "encoding/json" : "",
    "io", "log/slog", "net/http", "net/http/httptest", "os", "strings", "testing", "time",
  ].filter(Boolean).map((p) => `\t"${p}"`).join("\n");
  const local = ["config", dbProbe ? "db" : "", queueProbe ? "queue" : "", "server"]
    .filter(Boolean).map((p) => `\t"${module}/internal/${p}"`).join("\n");
  const fiberImport = isFiber ? `\n\t"github.com/gofiber/fiber/v2/middleware/adaptor"\n` : "";

  const servedFn = usesServed ? `

// served reports whether the router matched: a handler's own 404/405 carries a
// JSON {"error": ...} body, the router's "no such route" response does not.
func served(resp *http.Response) bool {
\tif resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
\t\treturn true
\t}
\tvar body map[string]any
\treturn json.NewDecoder(resp.Body).Decode(&body) == nil && body["error"] != nil
}` : "";

  return `// Contract tests for ${safeName(config.name)}
// Run with: go test ./internal/api/contract/...
//
// Every route is mounted, protected routes answer 401 without a token and stub
// handlers answer 200. The server runs in-process${probes ? ";\n// the tests skip when its database or broker is unreachable." : " with no external services."}
package api_contract_test

import (
${std}
${fiberImport}
${local}
)

var (
\tts         *httptest.Server
\tskipReason string
)

func TestMain(m *testing.M) {
\tcfg, err := config.Load() // reads from env; defaults work for tests
\tif err != nil {
\t\tpanic(err)
\t}
${probes}\tif skipReason == "" {
${testServerSetup}
\t}
\tcode := m.Run()
\tif ts != nil {
\t\tts.Close()
\t}
\tos.Exit(code)
}

// requireServer skips the test when TestMain could not reach a dependency.
func requireServer(t *testing.T) {
\tt.Helper()
\tif ts == nil {
\t\tt.Skip(skipReason)
\t}
}

// call sends one request to the in-process server. A rate limiter answers 429
// once the suite outruns its burst, so wait for a token and resend.
func call(t *testing.T, method, path, body string) *http.Response {
\tt.Helper()
\tfor attempt := 1; ; attempt++ {
\t\tvar rd io.Reader
\t\tif body != "" {
\t\t\trd = strings.NewReader(body)
\t\t}
\t\treq, err := http.NewRequest(method, ts.URL+path, rd)
\t\tif err != nil {
\t\t\tt.Fatalf("build request: %v", err)
\t\t}
\t\tif body != "" {
\t\t\treq.Header.Set("Content-Type", "application/json")
\t\t}
\t\tresp, err := http.DefaultClient.Do(req)
\t\tif err != nil {
\t\t\tt.Fatalf("%s %s: %v", method, path, err)
\t\t}
\t\tif resp.StatusCode != http.StatusTooManyRequests || attempt == 30 {
\t\t\tt.Cleanup(func() { _ = resp.Body.Close() })
\t\t\treturn resp
\t\t}
\t\t_ = resp.Body.Close()
\t\ttime.Sleep(100 * time.Millisecond)
\t}
}${servedFn}
${tests}
`;
}

// ─── Python (pytest + httpx/TestClient) ──────────────────────────────────────

function pythonContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const isFastAPI = config.framework === "fastapi";

  const header = isFastAPI
    ? `from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)`
    : `import httpx
import pytest

BASE_URL = "http://localhost:8000"`;

  const tests = endpoints.map((ep) => {
    const method = ep.method.toLowerCase();
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const auth = ep.auth ? ', headers={"Authorization": "Bearer test-token"}' : "";
    const body = ["post", "put", "patch"].includes(method) ? ", json={}" : "";
    const clientCall = isFastAPI
      ? `client.${method}("${testPath}"${auth}${body})`
      : `httpx.${method}(f"{BASE_URL}${testPath}"${auth}${body})`;

    return `
def test_${method}_${ep.path.replace(/[/:]/g, "_").replace(/^_/, "").replace(/_+/g, "_")}():
    """${ep.summary}"""
    response = ${clientCall}
    assert response.status_code == ${status}
    assert "application/json" in response.headers.get("content-type", "")
`;
  }).join("\n");

  return `"""API contract tests for ${safeName(config.name)}.

Run with: pytest tests/test_contracts.py -v
"""
${header}

${tests}`;
}

// ─── Rust (axum test helpers) ─────────────────────────────────────────────────

function rustContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const tests = endpoints.map((ep) => {
    const method = ep.method.toLowerCase();
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const authHeader = ep.auth ? '\n        .header("Authorization", "Bearer test-token")' : "";

    return `
#[tokio::test]
async fn test_${method}_${ep.path.replace(/[/:]/g, "_").replace(/^_/, "")}() {
    let app = create_app().await;
    let client = TestClient::new(app);
    // ${ep.summary}
    let res = client.${method}("${testPath}")${authHeader}.send().await;
    assert_eq!(res.status(), ${status});
}`;
  }).join("\n");

  return `//! Contract tests — ${safeName(config.name)}
//! Run with: cargo test --test contract_tests

use axum_test::TestClient;
use ${safeName(config.name).replace(/-/g, "_")}::create_app;

${tests}
`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function contractTestFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  // Kotlin covers entity CRUD routes too, so it doesn't need user endpoints.
  if (config.language === "kotlin") return kotlinContractTestFiles(config, endpoints, entities);
  if (config.language === "java") return javaContractTestFiles(config, endpoints, entities);
  if (endpoints.length === 0) return [];

  switch (config.language) {
    case "typescript":
      return [{ path: "tests/api.contract.test.ts", content: tsContractTests(config, endpoints) }];
    case "go":
      // gRPC / GraphQL stacks have no internal/server HTTP router to test.
      if (config.api === "grpc" || (config.api === "graphql" && isGraphqlSupported("go"))) return [];
      return [{ path: "internal/api/contract/contract_test.go", content: goContractTests(config, endpoints, entities) }];
    case "python":
      return [{ path: "tests/test_contracts.py", content: pythonContractTests(config, endpoints) }];
    case "rust":
      return [{ path: "tests/contract_tests.rs", content: rustContractTests(config, endpoints) }];
    default:
      return [];
  }
}

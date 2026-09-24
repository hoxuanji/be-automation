import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { isGraphqlSupported, safeName, toPascal } from "./types";
import { goAuthMode, goDbKind } from "./go";
import { kotlinContractTestFiles } from "./kotlin";

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

function goContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const module = `github.com/your-username/${safeName(config.name)}`;
  const isFiber = config.framework === "fiber";
  const needsStrings = endpoints.some((e) => ["POST", "PUT", "PATCH"].includes(e.method));

  // With a real verifier (goAuthMode) protected routes must reject a request
  // without a valid token; with auth off they behave like public routes.
  const authEnforced = goAuthMode(config, endpoints) !== "off";

  const testServerSetup = isFiber
    ? `\tsrv := server.New(cfg, slog.Default())\n\tts = httptest.NewServer(adaptor.FiberApp(srv.App()))`
    : `\tsrv := server.New(cfg, slog.Default())\n\tts = httptest.NewServer(srv.Handler())`;

  const fiberImport = isFiber ? `\n\t"github.com/gofiber/fiber/v2/middleware/adaptor"\n` : "";

  // server.New exits the process when its database is unreachable, so probe
  // with the same opener first and skip (not fail) when there is no DB.
  const kind = goDbKind(config.database);
  const probe =
    kind === "postgres" || kind === "mysql"
      ? `\tif conn, err := db.Open(cfg.DatabaseURL); err != nil {\n\t\tskipReason = "database unreachable (set DATABASE_URL to run): " + err.Error()\n\t} else {\n\t\t_ = conn.Close()\n\t}\n`
      : kind === "mongo"
        ? `\tif store, err := db.OpenMongo(context.Background(), cfg.MongoURI); err != nil {\n\t\tskipReason = "database unreachable (set MONGODB_URI to run): " + err.Error()\n\t} else {\n\t\t_ = store.Close(context.Background())\n\t}\n`
        : "";
  const skipCheck = probe ? `\trequireServer(t)\n` : "";

  const tests = endpoints.map((ep) => {
    const testPath = pathToParam(ep.path);
    const status = ep.auth && authEnforced ? 401 : expectedStatus(ep.method, ep.auth);
    const bodyLine = ["POST", "PUT", "PATCH"].includes(ep.method)
      ? `\tbody := strings.NewReader("{}")\n\treq, err := http.NewRequest("${ep.method}", ts.URL+"${testPath}", body)`
      : `\treq, err := http.NewRequest("${ep.method}", ts.URL+"${testPath}", nil)`;
    return `
func Test${toPascal(ep.method)}${toPascal(ep.path.replace(/[/:]/g, "_"))}(t *testing.T) {
${skipCheck}\t// ${ep.summary}
${bodyLine}
\tif err != nil {
\t\tt.Fatalf("build request: %v", err)
\t}
\tresp, err := http.DefaultClient.Do(req)
\tif err != nil {
\t\tt.Fatalf("request failed: %v", err)
\t}
\tdefer resp.Body.Close()
\tif resp.StatusCode != ${status} {
\t\tt.Errorf("${ep.method} ${ep.path}: expected ${status}, got %d", resp.StatusCode)
\t}
}`;
  }).join("\n");

  return `// Contract tests for ${safeName(config.name)}
// Run with: go test ./internal/api/contract/...
//
// Prerequisites: ${probe ? "the server is started in-process; tests skip when the database is unreachable." : "no external dependencies — the server is started in-process."}
package api_contract_test

import (
${kind === "mongo" ? '\t"context"\n' : ""}\t"log/slog"
\t"net/http"
\t"net/http/httptest"
\t"os"
${needsStrings ? '\t"strings"\n' : ""}\t"testing"
${fiberImport}
\t"${module}/internal/config"
${probe ? `\t"${module}/internal/db"\n` : ""}\t"${module}/internal/server"
)

${probe ? `var (
\tts         *httptest.Server
\tskipReason string
)

func TestMain(m *testing.M) {
\tcfg, err := config.Load() // reads from env; defaults work for tests
\tif err != nil {
\t\tpanic(err)
\t}
${probe}\tif skipReason == "" {
${testServerSetup.replace(/\t/g, "\t\t")}
\t}
\tcode := m.Run()
\tif ts != nil {
\t\tts.Close()
\t}
\tos.Exit(code)
}

// requireServer skips the test when TestMain could not reach the database.
func requireServer(t *testing.T) {
\tt.Helper()
\tif ts == nil {
\t\tt.Skip(skipReason)
\t}
}` : `var ts *httptest.Server

func TestMain(m *testing.M) {
\tcfg, err := config.Load() // reads from env; defaults work for tests
\tif err != nil {
\t\tpanic(err)
\t}
${testServerSetup}
\tcode := m.Run()
\tts.Close()
\tos.Exit(code)
}`}
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

// ─── Java (Spring Boot Test) ──────────────────────────────────────────────────

function javaContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const appClass = toPascal(safeName(config.name)) + "Application";
  const tests = endpoints.map((ep) => {
    const method = ep.method;
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const authSetup = ep.auth
      ? `\n        headers.set("Authorization", "Bearer test-token");\n        HttpEntity<String> entity = new HttpEntity<>(${["POST","PUT","PATCH"].includes(method) ? '"{}"' : "null"}, headers);`
      : `\n        HttpEntity<String> entity = new HttpEntity<>(${["POST","PUT","PATCH"].includes(method) ? '"{}"' : "null"}, headers);`;

    return `
    @Test
    void test${toPascal(method)}${toPascal(ep.path.replace(/[/:]/g, "_"))}() {
        // ${ep.summary}
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);${authSetup}
        ResponseEntity<String> response = restTemplate.exchange(
            "http://localhost:" + port + "${testPath}",
            HttpMethod.${method},
            entity,
            String.class
        );
        assertEquals(${status}, response.getStatusCode().value());
    }`;
  }).join("\n");

  return `package com.example.${safeName(config.name).replace(/-/g, "")};

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(classes = ${appClass}.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ApiContractTest {

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate restTemplate;
${tests}
}
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
  if (endpoints.length === 0) return [];

  switch (config.language) {
    case "typescript":
      return [{ path: "tests/api.contract.test.ts", content: tsContractTests(config, endpoints) }];
    case "go":
      // gRPC / GraphQL stacks have no internal/server HTTP router to test.
      if (config.api === "grpc" || (config.api === "graphql" && isGraphqlSupported("go"))) return [];
      return [{ path: "internal/api/contract/contract_test.go", content: goContractTests(config, endpoints) }];
    case "python":
      return [{ path: "tests/test_contracts.py", content: pythonContractTests(config, endpoints) }];
    case "rust":
      return [{ path: "tests/contract_tests.rs", content: rustContractTests(config, endpoints) }];
    case "java":
      return [{ path: `src/test/java/com/example/${safeName(config.name).replace(/-/g, "")}/ApiContractTest.java`, content: javaContractTests(config, endpoints) }];
    default:
      return [];
  }
}

import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { safeName, toPascal } from "./types";

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

  const testServerSetup = isFiber
    ? `\tsrv := server.New(cfg, slog.Default())\n\tts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tsrv.App().Handler()(w, r)\n\t}))`
    : `\tsrv := server.New(cfg, slog.Default())\n\tts = httptest.NewServer(srv.Handler())`;

  const fiberImport = isFiber ? `\t"net/http"\n` : "";

  const tests = endpoints.map((ep) => {
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const authLine = ep.auth ? `\n\treq.Header.Set("Authorization", "Bearer test-token")` : "";
    const bodyLine = ["POST", "PUT", "PATCH"].includes(ep.method)
      ? `\tbody := strings.NewReader("{}")\n\treq, err := http.NewRequest("${ep.method}", ts.URL+"${testPath}", body)`
      : `\treq, err := http.NewRequest("${ep.method}", ts.URL+"${testPath}", nil)`;
    return `
func Test${toPascal(ep.method)}${toPascal(ep.path.replace(/[/:]/g, "_"))}(t *testing.T) {
\t// ${ep.summary}
\t${bodyLine}
\tif err != nil {
\t\tt.Fatalf("build request: %v", err)
\t}${authLine}
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
// Prerequisites: no external dependencies — the server is started in-process.
package api_contract_test

import (
\t"log/slog"
\t"net/http"
\t"net/http/httptest"
\t"os"
${needsStrings ? '\t"strings"\n' : ""}${fiberImport}
\t"testing"

\t"${module}/internal/config"
\t"${module}/internal/server"
)

var ts *httptest.Server

func TestMain(m *testing.M) {
\tcfg := config.New() // reads from env; defaults work for tests
${testServerSetup}
\tcode := m.Run()
\tts.Close()
\tos.Exit(code)
}
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

// ─── Kotlin (Ktor testApplication) ───────────────────────────────────────────

function kotlinContractTests(config: StackConfig, endpoints: Endpoint[]): string {
  const tests = endpoints.map((ep) => {
    const method = ep.method;
    const testPath = pathToParam(ep.path);
    const status = expectedStatus(ep.method, ep.auth);
    const authLine = ep.auth ? '\n            header("Authorization", "Bearer test-token")' : "";
    const bodyLine = ["POST", "PUT", "PATCH"].includes(method) ? '\n            setBody("{}")' : "";

    return `
    @Test
    fun \`test ${method} ${ep.path}\`() = testApplication {
        // ${ep.summary}
        val response = client.${method.toLowerCase()}("${testPath}") {${authLine}${bodyLine}
        }
        assertEquals(HttpStatusCode.fromValue(${status}), response.status)
    }`;
  }).join("\n");

  return `package com.example.${safeName(config.name).replace(/-/g, "")}

import io.ktor.client.request.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlin.test.*

class ApiContractTest {
${tests}
}
`;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function contractTestFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  _entities: Entity[]
): GeneratedFile[] {
  if (endpoints.length === 0) return [];

  switch (config.language) {
    case "typescript":
      return [{ path: "tests/api.contract.test.ts", content: tsContractTests(config, endpoints) }];
    case "go":
      return [{ path: "internal/api/contract/contract_test.go", content: goContractTests(config, endpoints) }];
    case "python":
      return [{ path: "tests/test_contracts.py", content: pythonContractTests(config, endpoints) }];
    case "rust":
      return [{ path: "tests/contract_tests.rs", content: rustContractTests(config, endpoints) }];
    case "java":
      return [{ path: `src/test/java/com/example/${safeName(config.name).replace(/-/g, "")}/ApiContractTest.java`, content: javaContractTests(config, endpoints) }];
    case "kotlin":
      return [{ path: `src/test/kotlin/com/example/${safeName(config.name).replace(/-/g, "")}/ApiContractTest.kt`, content: kotlinContractTests(config, endpoints) }];
    default:
      return [];
  }
}

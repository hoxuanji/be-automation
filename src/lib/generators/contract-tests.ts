import type { Endpoint, Entity, GeneratedFile, StackConfig } from "./types";
import { isGraphqlSupported, safeName, toKebab, toPascal } from "./types";
import { goQueueKind } from "./queue/go";
import { goAuthMode, goDbKind } from "./go";
import { kotlinContractTestFiles } from "./kotlin";
import { tsEntityRouteFor, tsSendBody } from "./typescript";
import { CREDENTIAL_PATTERNS, SELF_AUTH_PATTERNS, hasRedisCache, tsAuthMode, tsGuarded, tsRouteHasModel, tsSelfAuthUser, usesPrisma, type TsAuthMode } from "./patterns/typescript";
import { tsQueueKind } from "./queue/typescript";
import { javaContractTestFiles } from "./java";
import { pythonContractTestFiles } from "./python";

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

// Runs the real app in-process with no Postgres / Redis / broker: the data
// clients are module-mocked, and protected routes are exercised with a real
// token checked by the app's own verifier (HS256 secret, or a local JWKS
// standing in for the provider). Statuses assume those fakes: every lookup
// finds a row, lists are empty, bodies are {} unless an entity route needs a valid one.
function tsExpectedStatus(e: Endpoint, config: StackConfig, endpoints: Endpoint[], entities: Entity[], mode: TsAuthMode): number | null {
  const prisma = usesPrisma(config, entities);
  const owner = tsEntityRouteFor(e, endpoints, entities);
  if (owner) return { list: 200, get: prisma ? 200 : 404, create: 201, update: prisma ? 200 : 404, remove: 204 }[owner.op];
  const p = e.pattern;
  if (!p) return config.framework === "nestjs" && e.method === "POST" ? 201 : 200; // Nest's @Post() default
  if (mode === "jwks" && CREDENTIAL_PATTERNS.includes(p)) return 501;
  if (SELF_AUTH_PATTERNS.includes(p) && !tsSelfAuthUser(config, entities)) return 501;
  const model = tsRouteHasModel(e.path, config, entities);
  switch (p) {
    case "crud_list": case "paginated_search": case "aggregate_stats": case "health_check": case "auth_me": return 200;
    case "crud_get": case "crud_update": case "cache_read": return model ? 200 : 404;
    case "crud_create": case "file_upload": return 201;
    case "crud_delete": case "auth_logout": return 204;
    // Empty body → validation error, before any DB or token work.
    case "auth_login": case "auth_register": case "auth_refresh": case "auth_change_password": case "send_notification": return 400;
    case "webhook_receive": return tsQueueKind(config) ? 202 : 503;
    default: return e.logicCode ? null : 200; // custom logic: only "no server error" is knowable
  }
}

function tsContractTests(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): string {
  const fw = config.framework;
  const mode = tsAuthMode(config, endpoints);
  // Express keeps authRequired (JWKS verifier) on protected routes even with auth "off".
  const guarded = (e: Endpoint) => tsGuarded(e, mode) || (fw === "express" && e.auth);
  const auth = !endpoints.some(guarded) && mode !== "hs256" ? null : mode === "hs256" ? "hs256" : "jwks";

  const mocks = [
    usesPrisma(config, entities) ? `vi.mock("@prisma/client", () => {
  const row = (a?: { where?: object; data?: object }) => ({ id: "test-id-123", ...a?.where, ...a?.data });
  const model = {
    findMany: async () => [], count: async () => 0,
    findUnique: async (a: any) => row(a), findFirst: async (a: any) => row(a),
    create: async (a: any) => row(a), update: async (a: any) => row(a), delete: async (a: any) => row(a),
  };
  const prisma: any = new Proxy({}, {
    get: (_t, key) =>
      key === "$transaction" ? (fn: (tx: unknown) => unknown) => fn(prisma)
      : key === "$queryRaw" ? async () => [{ ok: 1 }]
      : String(key).startsWith("$") ? async () => undefined
      : model,
  });
  return { PrismaClient: class { constructor() { return prisma; } } };
});` : "",
    hasRedisCache(config) ? `vi.mock("../src/cache", () => ({
  redis: { get: async () => null, set: async () => "OK", del: async () => 1, ping: async () => "PONG" },
}));` : "",
    tsQueueKind(config) ? `vi.mock("../src/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/queue")>()),
  publish: async () => undefined, queuePing: async () => undefined, closeQueue: async () => undefined,
}));` : "",
  ].filter(Boolean).join("\n");

  const tokenSetup = auth === "hs256"
    ? `  // Self-issued auth: sign with the same JWT_SECRET the app verifies against.
  process.env.JWT_SECRET = "contract-test-secret";
  token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("test-user")
    .setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(process.env.JWT_SECRET));
`
    : auth === "jwks"
    ? `  // A local JWKS endpoint stands in for the auth provider; the app's own verifier checks the token.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "contract-test", alg: "RS256" };
  const jwks = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => jwks.close(() => resolve())));
  process.env.AUTH_ISSUER = "https://issuer.contract.test";
  process.env.AUTH_JWKS_URL = \`http://127.0.0.1:\${(jwks.address() as AddressInfo).port}/.well-known/jwks.json\`;
  delete process.env.AUTH_AUDIENCE;
  token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "contract-test" })
    .setIssuer(process.env.AUTH_ISSUER).setSubject("test-user").setIssuedAt().setExpirationTime("5m").sign(privateKey);
`
    : "";

  // Imported after the env is set: the verifier reads it at module load.
  const appSetup = fw === "nestjs"
    ? `  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module");
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  cleanup.push(() => app.close());
  server = app.getHttpServer();`
    : fw === "fastify"
    ? `  const { createApp } = await import("../src/app");
  const app = await createApp();
  await app.ready();
  cleanup.push(() => app.close());
  server = app.server;`
    : fw === "hono"
    ? `  const { createAdaptorServer } = await import("@hono/node-server");
  const { createApp } = await import("../src/app");
  server = createAdaptorServer({ fetch: createApp().fetch });`
    : `  const { createApp } = await import("../src/app");
  server = createApp();`;

  const tests = endpoints.map((ep) => {
    const method = ep.method.toLowerCase();
    const testPath = pathToParam(ep.path);
    const status = tsExpectedStatus(ep, config, endpoints, entities, mode);
    const owner = tsEntityRouteFor(ep, endpoints, entities);
    // Entity routes validate their body; pattern handlers and stubs get {}.
    const body = ["POST", "PUT", "PATCH"].includes(ep.method)
      ? `\n      .send(${owner ? tsSendBody(owner.entity.fields.filter((f) => !f.primaryKey)) : "{}"})`
      : "";
    const call = `request(server)\n      .${method}('${testPath}')`;
    const unauth = guarded(ep)
      ? `    expect((await ${call}${body}).status).toBe(401);\n`
      : "";
    const assertStatus = status === null ? `expect(res.status).toBeLessThan(500);` : `expect(res.status).toBe(${status});`;
    const assertJson = status === 204 ? "" : `\n    expect(res.headers['content-type']).toMatch(/json/);`;
    return `
  it('${ep.method} ${ep.path}', async () => {
    // ${ep.summary}
${unauth}    const res = await ${call}${guarded(ep) ? "\n      .set('Authorization', `Bearer ${token}`)" : ""}${body};
    ${assertStatus}${assertJson}
  });`;
  }).join("\n");

  return `import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
${auth === "jwks" ? `import { createServer } from 'node:http';\nimport type { AddressInfo } from 'node:net';\n` : ""}${auth ? `import { ${auth === "jwks" ? "exportJWK, generateKeyPair, " : ""}SignJWT } from 'jose';\n` : ""}
${mocks ? `// No database, cache or broker needed: their clients are in-memory fakes.\n${mocks}\n` : ""}
describe('API contract tests — ${safeName(config.name)}', () => {
  let server: any;
  let token = '';
  const cleanup: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
${(tokenSetup + appSetup).replace(/^(?=.)/gm, "  ")}
  });

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });
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
  // Python's tests run against conftest.py's fakes and seed entities themselves.
  if (config.language === "python") return pythonContractTestFiles(config, endpoints, entities);
  if (endpoints.length === 0) return [];

  switch (config.language) {
    case "typescript":
      // tRPC / GraphQL / gRPC stacks don't serve the endpoints as REST routes.
      if (config.api !== "rest") return [];
      return [{ path: "tests/api.contract.test.ts", content: tsContractTests(config, endpoints, entities) }];
    case "go":
      // gRPC / GraphQL stacks have no internal/server HTTP router to test.
      if (config.api === "grpc" || (config.api === "graphql" && isGraphqlSupported("go"))) return [];
      return [{ path: "internal/api/contract/contract_test.go", content: goContractTests(config, endpoints, entities) }];
    case "rust":
      return [{ path: "tests/contract_tests.rs", content: rustContractTests(config, endpoints) }];
    default:
      return [];
  }
}

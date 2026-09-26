// Cloud deploy (GitHub Actions) tests.
//   npm run test:deploy
// 1. sealSecret must produce a libsodium sealed box that GitHub (the holder of
//    the repo private key) can open — otherwise secrets silently arrive as garbage.
// 2. cloudSecretsFor must emit exactly the secret names deploy.yml reads.
// 3. runCloudDeployPipeline must drive push → secrets → dispatch → poll and
//    surface a failed run as a typed error, with fetch mocked end to end.

import { describe, it, before, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import sodium from "libsodium-wrappers";
import { sealSecret, cloudSecretsFor } from "@/lib/cloud-deploy";
import { resolveKubeconfig, isPrivateAddress, type CloudVerifyError } from "@/lib/cloud-verify";
import { runCloudDeployPipeline } from "@/lib/deploy-pipeline";
import { PipelineError, type PipelineEvent } from "@/lib/pipeline-types";

let keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
const b64 = (u: Uint8Array) => sodium.to_base64(u, sodium.base64_variants.ORIGINAL);
const open = (sealedB64: string) =>
  sodium.to_string(
    sodium.crypto_box_seal_open(sodium.from_base64(sealedB64, sodium.base64_variants.ORIGINAL), keypair.publicKey, keypair.privateKey)
  );

before(async () => {
  await sodium.ready;
  // Deterministic keypair so failures are reproducible.
  keypair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
});

const GCP_KEY = JSON.stringify({
  type: "service_account",
  project_id: "helios-demo",
  client_email: "deployer@helios-demo.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n",
});

describe("sealSecret", () => {
  it("round-trips through crypto_box_seal_open with the repo private key", async () => {
    const sealed = await sealSecret("s3cr3t-value/with+chars=", b64(keypair.publicKey));
    assert.equal(open(sealed), "s3cr3t-value/with+chars=");
  });

  it("is non-deterministic (ephemeral key per seal) and adds SEALBYTES overhead", async () => {
    const a = await sealSecret("x".repeat(10), b64(keypair.publicKey));
    const b = await sealSecret("x".repeat(10), b64(keypair.publicKey));
    assert.notEqual(a, b);
    assert.equal(sodium.from_base64(a, sodium.base64_variants.ORIGINAL).length, 10 + sodium.crypto_box_SEALBYTES);
  });

  it("cannot be opened with a different keypair", async () => {
    const sealed = await sealSecret("value", b64(keypair.publicKey));
    const other = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(9));
    assert.throws(() =>
      sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), other.publicKey, other.privateKey)
    );
  });
});

describe("cloudSecretsFor", () => {
  // Names must match DEPLOY_SECRETS in src/lib/generators/deploy.ts (what deploy.yml reads).
  it("aws → AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY only (region is config, not a secret)", () => {
    const s = cloudSecretsFor("aws", { accessKeyId: "AKIAEXAMPLE12345678", secretAccessKey: "secretsecretsecret" });
    assert.deepEqual(s, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE12345678", AWS_SECRET_ACCESS_KEY: "secretsecretsecret" });
  });

  // With both set, configure-aws-credentials would use the keys to AssumeRole
  // instead of OIDC — so OIDC mode must never also emit the key pair.
  it("aws OIDC → AWS_ROLE_ARN only, no access keys", () => {
    const roleArn = "arn:aws:iam::123456789012:role/helios-deploy";
    assert.deepEqual(cloudSecretsFor("aws", { roleArn }), { AWS_ROLE_ARN: roleArn });
  });

  it("gcp → GCP_SA_KEY only, and rejects a non-service-account JSON", () => {
    assert.deepEqual(cloudSecretsFor("gcp", { serviceAccountKey: GCP_KEY }), { GCP_SA_KEY: GCP_KEY });
    assert.throws(() => cloudSecretsFor("gcp", { serviceAccountKey: '{"type":"authorized_user"}' }));
  });

  it("azure → AZURE_CREDENTIALS sdk-auth JSON only", () => {
    const ids = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", subscriptionId: "33333333-3333-4333-8333-333333333333" };
    const s = cloudSecretsFor("azure", { ...ids, clientSecret: "shh" });
    assert.deepEqual(Object.keys(s), ["AZURE_CREDENTIALS"]);
    assert.deepEqual(JSON.parse(s.AZURE_CREDENTIALS), { clientId: ids.clientId, clientSecret: "shh", subscriptionId: ids.subscriptionId, tenantId: ids.tenantId });
  });

  it("k8s → raw KUBECONFIG (not base64) + K8S_SECRETS_ENV dotenv only when env vars exist", () => {
    const kc = "apiVersion: v1\nkind: Config\n";
    assert.deepEqual(cloudSecretsFor("k8s", { kubeconfig: kc }), { KUBECONFIG: kc });
    const s = cloudSecretsFor("k8s", { kubeconfig: kc }, [
      { key: "DATABASE_URL", value: "postgres://u:p@h/db" },
      { key: "MASKED", value: "••••1234" }, // UI mask placeholder — never ship it
      { key: "MULTI", value: "a\nb" },
      { key: "EMPTY", value: "" },
    ]);
    assert.equal(s.KUBECONFIG, kc);
    assert.equal(s.K8S_SECRETS_ENV, "DATABASE_URL=postgres://u:p@h/db");
  });
});

describe("kubeconfig + SSRF guard (verify route)", () => {
  const kc = [
    "apiVersion: v1", "kind: Config", "current-context: prod",
    "contexts:", "- name: prod", "  context: { cluster: c1, user: u1 }",
    "clusters:", "- name: c1", '  cluster: { server: "https://k8s.example.com:6443", certificate-authority-data: "Zm9v" }',
    "users:", "- name: u1", '  user: { token: "abc" }',
  ].join("\n");

  it("resolves the current context's server, CA and token", () => {
    const r = resolveKubeconfig(kc);
    assert.equal(r.server.host, "k8s.example.com:6443");
    assert.equal(r.token, "abc");
    assert.equal(r.ca?.toString(), "foo");
  });

  it("rejects exec plugins and plain-http servers with typed codes", () => {
    assert.throws(() => resolveKubeconfig(kc.replace('{ token: "abc" }', "{ exec: { command: aws } }")), (e: unknown) => (e as CloudVerifyError).code === "unsupported_auth");
    assert.throws(() => resolveKubeconfig(kc.replace("https://", "http://")), (e: unknown) => (e as CloudVerifyError).code === "invalid_credentials");
  });

  it("treats loopback / private / link-local / metadata addresses as private", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1"]) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

// ─── Pipeline with mocked fetch ──────────────────────────────────────────────

const CONFIG = {
  name: "cloud-app", language: "typescript", framework: "hono", database: "postgres", cache: "none", queue: "none",
  api: "rest", auth: "none", deployment: "aws", scaling: "horizontal", monitoring: "none", cicd: "github-actions",
  docker: true, kubernetes: false, helm: false, tracing: false, rateLimit: false, audit: false, autoscale: false,
  replicas: 1, region: "us-east-1", envVars: [],
} as never;

type Call = { method: string; path: string; body?: unknown };

function mockGitHub(opts: { conclusion: string; secretStatus?: number }) {
  const calls: Call[] = [];
  const stored: Record<string, string> = {};
  let dispatches = 0;
  let runPolls = 0;
  let listPolls = 0;
  const json = (status: number, body: unknown) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    calls.push({ method, path, body });
    const repo = "/repos/octo/cloud-app";
    if (method === "POST" && path === "/user/repos")
      return json(201, { full_name: "octo/cloud-app", html_url: "https://github.com/octo/cloud-app", default_branch: "main", owner: { login: "octo" }, name: "cloud-app" });
    if (path === `${repo}/git/refs/heads/main`) return json(200, { object: { sha: "abc" } });
    if (path === "/graphql") return json(200, { data: { createCommitOnBranch: { commit: { oid: "def", url: "https://github.com/octo/cloud-app/commit/def" } } } });
    if (path === `${repo}/actions/secrets/public-key`) return json(200, { key_id: "kid-1", key: b64(keypair.publicKey) });
    if (method === "PUT" && path.startsWith(`${repo}/actions/secrets/`)) {
      if (opts.secretStatus) return json(opts.secretStatus, { message: "Resource not accessible by integration" });
      const b = body as { encrypted_value: string; key_id: string };
      assert.equal(b.key_id, "kid-1");
      stored[path.split("/").pop()!] = open(b.encrypted_value);
      return json(201, {});
    }
    // Stale-mode secrets usually don't exist: GitHub answers 404, which must be tolerated.
    if (method === "DELETE" && path.startsWith(`${repo}/actions/secrets/`)) return json(404, { message: "Not Found" });
    if (path === repo) return json(200, { default_branch: "main" });
    if (method === "POST" && path === `${repo}/actions/workflows/deploy.yml/dispatches`) {
      // First attempt simulates GitHub not having indexed the new workflow yet.
      return ++dispatches === 1 ? json(404, { message: "Not Found" }) : json(204, null);
    }
    const run = (status: string, conclusion: string | null) => ({
      id: 42, html_url: "https://github.com/octo/cloud-app/actions/runs/42", status, conclusion, created_at: new Date().toISOString(),
    });
    if (path === `${repo}/actions/workflows/deploy.yml/runs`) {
      assert.equal(url.searchParams.get("event"), "workflow_dispatch");
      return json(200, { workflow_runs: ++listPolls === 1 ? [] : [run("queued", null)] });
    }
    if (path === `${repo}/actions/runs/42`) {
      return json(200, ++runPolls < 2 ? run("in_progress", null) : run("completed", opts.conclusion));
    }
    if (path === `${repo}/actions/runs/42/jobs`)
      return json(200, { jobs: [{ name: "deploy", status: "in_progress", steps: [{ name: "Push image", status: "in_progress" }] }] });
    throw new Error(`unmocked ${method} ${path}`);
  }) as typeof fetch;
  return { calls, stored };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function drain(gen: AsyncGenerator<PipelineEvent, unknown, void>) {
  const events: PipelineEvent[] = [];
  let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }
  return { events, result: next.value };
}

const params = {
  githubToken: "gho_test",
  provider: "aws" as const,
  creds: { accessKeyId: "AKIAEXAMPLE12345678", secretAccessKey: "secretsecretsecret" },
  config: CONFIG, endpoints: [], entities: [], repoName: "cloud-app",
  pollIntervalMs: 1, maxWaitMs: 10_000,
};

describe("runCloudDeployPipeline", () => {
  it("push → secrets → dispatch (retrying indexing 404) → poll → done with run URL", async () => {
    const { calls, stored } = mockGitHub({ conclusion: "success" });
    const { events, result } = await drain(runCloudDeployPipeline(params));

    const stages = events.filter((e) => e.type === "stage").map((e) => (e as { stage: string }).stage);
    assert.deepEqual(stages, ["generate", "github_push", "actions_secrets", "workflow_dispatch", "workflow_run", "done"]);
    // GitHub received exactly the credentials, decryptable with the repo key.
    assert.deepEqual(stored, { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE12345678", AWS_SECRET_ACCESS_KEY: "secretsecretsecret" });
    assert.equal(calls.filter((c) => c.path.endsWith("/dispatches")).length, 2);
    assert.deepEqual(calls.find((c) => c.path.endsWith("/dispatches"))?.body, { ref: "main" });
    assert.ok(events.some((e) => e.type === "progress" && e.message.includes("Push image")));
    const r = result as { runUrl?: string; provider: string; projectUrl: string };
    assert.equal(r.provider, "aws");
    assert.equal(r.runUrl, "https://github.com/octo/cloud-app/actions/runs/42");
    assert.equal(r.projectUrl, r.runUrl);
    // Secrets must be stored before the workflow that reads them is dispatched.
    const lastPut = calls.map((c) => c.method).lastIndexOf("PUT");
    const firstDispatch = calls.findIndex((c) => c.path.endsWith("/dispatches"));
    assert.ok(lastPut < firstDispatch);
    // Key mode clears a stale OIDC role before the workflow runs.
    const del = calls.findIndex((c) => c.method === "DELETE" && c.path.endsWith("/actions/secrets/AWS_ROLE_ARN"));
    assert.ok(del !== -1 && del < firstDispatch, "stale AWS_ROLE_ARN deleted before dispatch");
  });

  it("a failed run surfaces workflow_run_failed with the run URL", async () => {
    mockGitHub({ conclusion: "failure" });
    await assert.rejects(drain(runCloudDeployPipeline(params)), (err: unknown) => {
      assert.ok(err instanceof PipelineError);
      assert.equal(err.code, "workflow_run_failed");
      assert.equal(err.partial?.runUrl, "https://github.com/octo/cloud-app/actions/runs/42");
      return true;
    });
  });

  it("a 403 on secrets maps to insufficient_scope and never dispatches", async () => {
    const { calls } = mockGitHub({ conclusion: "success", secretStatus: 403 });
    await assert.rejects(drain(runCloudDeployPipeline(params)), (err: unknown) => {
      assert.ok(err instanceof PipelineError);
      assert.equal(err.code, "insufficient_scope");
      assert.equal(err.stage, "actions_secrets");
      return true;
    });
    assert.ok(!calls.some((c) => c.path.endsWith("/dispatches")));
  });
});

// The Helios one-click side (CLOUD_SECRET_NAMES) and the generated deploy.yml
// (DEPLOY_SECRETS) are written separately; if they drift, secrets land under
// names the workflow never reads and every cloud deploy fails at runtime.
describe("one-click secrets match the generated deploy workflow", () => {
  it("every secret Helios sets is one deploy.yml reads", async () => {
    const { CLOUD_SECRET_NAMES } = await import("@/lib/cloud-deploy");
    const { DEPLOY_SECRETS } = await import("@/lib/generators/deploy");
    for (const [provider, names] of Object.entries(CLOUD_SECRET_NAMES)) {
      const read = new Set(DEPLOY_SECRETS[provider as keyof typeof DEPLOY_SECRETS].map((s) => s.name));
      for (const name of Object.values(names as Record<string, string>)) {
        assert.ok(read.has(name), `${provider}: Helios sets ${name}, but deploy.yml doesn't read it`);
      }
    }
  });

  it("the OIDC role secret is in the drift check (not silently dropped)", async () => {
    const { CLOUD_SECRET_NAMES } = await import("@/lib/cloud-deploy");
    const { DEPLOY_SECRETS } = await import("@/lib/generators/deploy");
    assert.equal(CLOUD_SECRET_NAMES.aws.roleArn, "AWS_ROLE_ARN");
    assert.ok(DEPLOY_SECRETS.aws.some((s) => s.name === CLOUD_SECRET_NAMES.aws.roleArn));
  });
});

// Settings and the deploy stream both gate on this; a loose check would store
// ARNs that configure-aws-credentials can't assume, failing only mid-workflow.
describe("AWS role ARN validation", () => {
  it("accepts role ARNs, with or without a path", async () => {
    const { isAwsRoleArn, CLOUD_CRED_SCHEMAS } = await import("@/lib/cloud-providers");
    for (const arn of ["arn:aws:iam::123456789012:role/helios-deploy", "arn:aws:iam::123456789012:role/ci/gh+deploy@x", " arn:aws:iam::123456789012:role/a "]) {
      assert.equal(isAwsRoleArn(arn), true, arn);
    }
    assert.ok(CLOUD_CRED_SCHEMAS.aws.safeParse({ roleArn: "arn:aws:iam::123456789012:role/r" }).success);
  });

  it("rejects users, short/long account ids, other services and trailing slashes", async () => {
    const { isAwsRoleArn, CLOUD_CRED_SCHEMAS } = await import("@/lib/cloud-providers");
    for (const arn of [
      "arn:aws:iam::123456789012:user/alice",
      "arn:aws:iam::12345678901:role/r",
      "arn:aws:iam::1234567890123:role/r",
      "arn:aws:sts::123456789012:assumed-role/r/s",
      "arn:aws:iam::123456789012:role/",
      "arn:aws:iam::123456789012:role/ci/",
      "AKIAEXAMPLE12345678",
    ]) {
      assert.equal(isAwsRoleArn(arn), false, arn);
    }
    // A bad ARN must not fall through to the access-key branch of the union.
    assert.ok(!CLOUD_CRED_SCHEMAS.aws.safeParse({ roleArn: "arn:aws:iam::123:role/r" }).success);
  });
});

// A reused repo keeps secrets from the other AWS mode; configure-aws-credentials would
// then use stale keys instead of OIDC (or assume a stale role in key mode).
describe("switching AWS credential modes clears the other mode's secrets", () => {
  it("OIDC removes the key pair; key mode removes the role", async () => {
    const { supersededSecrets } = await import("@/lib/cloud-deploy");
    assert.deepEqual(supersededSecrets("aws", { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/deploy" }).sort(), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    assert.deepEqual(supersededSecrets("aws", { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }), ["AWS_ROLE_ARN"]);
    assert.deepEqual(supersededSecrets("gcp", { GCP_SA_KEY: "{}" }), []);
  });
});

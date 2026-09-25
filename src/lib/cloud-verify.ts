// Credential probes for Settings → Integrations (AWS / GCP / Azure / K8s).
// Each probe makes one or two cheap authenticated calls with a timeout and
// throws `CloudVerifyError` with a user-safe message. Nothing here logs or
// echoes credential values or raw upstream error bodies.

import { createSign } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import yaml from "js-yaml";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { parseGcpServiceAccount } from "@/lib/cloud-deploy";
import type { CloudCreds } from "@/lib/cloud-providers";

const TIMEOUT_MS = 10_000;

export type CloudVerifyCode =
  | "not_authorized"
  | "invalid_credentials"
  | "unsupported_auth"
  | "not_found"
  | "forbidden"
  | "network_error"
  | "blocked_host"
  | "unexpected";

export class CloudVerifyError extends Error {
  code: CloudVerifyCode;
  status: number;
  hint?: string;
  constructor(code: CloudVerifyCode, status: number, message: string, hint?: string) {
    super(message);
    this.name = "CloudVerifyError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

const networkErr = (host: string) =>
  new CloudVerifyError("network_error", 503, `Couldn't reach ${host}.`, "Check connectivity and retry.");

async function timedFetch(url: string, init: RequestInit, host: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw networkErr(host);
  }
}

// ─── AWS: STS GetCallerIdentity ──────────────────────────────────────────────

export async function verifyAws(c: CloudCreds<"aws">) {
  const sts = new STSClient({
    region: "us-east-1", // GetCallerIdentity works from any region; the deploy region comes from config.region
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    maxAttempts: 1,
    requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 5_000 },
  });
  try {
    const out = await sts.send(new GetCallerIdentityCommand({}));
    return { account: out.Account ?? null, arn: out.Arn ?? null };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (["InvalidClientTokenId", "SignatureDoesNotMatch", "UnrecognizedClientException", "ExpiredToken", "AccessDenied"].includes(name)) {
      throw new CloudVerifyError("not_authorized", 401, "AWS rejected these credentials.", "Check the access key ID and secret, and that the key is active in IAM.");
    }
    if (name === "TimeoutError" || name === "RequestTimeout" || /ENOTFOUND|ECONN|ETIMEDOUT/.test(String((err as { code?: string })?.code ?? ""))) {
      throw networkErr("AWS STS");
    }
    throw new CloudVerifyError("unexpected", 502, "AWS verification failed.", "Check the region and retry.");
  } finally {
    sts.destroy();
  }
}

// ─── GCP: service-account JWT → OAuth token ──────────────────────────────────

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"; // fixed — never use the key's token_uri (SSRF)

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export async function verifyGcp(c: CloudCreds<"gcp">) {
  let sa;
  try {
    sa = parseGcpServiceAccount(c.serviceAccountKey);
  } catch (err) {
    throw new CloudVerifyError("invalid_credentials", 400, (err as Error).message, "Paste the full JSON key downloaded from IAM → Service accounts → Keys.");
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 300 })
  )}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  } catch {
    throw new CloudVerifyError("invalid_credentials", 400, "The service account private key couldn't be read.", "Re-download the JSON key and paste it unmodified.");
  }
  const res = await timedFetch(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    },
    "oauth2.googleapis.com"
  );
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      throw new CloudVerifyError("not_authorized", 401, "Google rejected this service account key.", "The key may be deleted or disabled — create a new key for the service account.");
    }
    throw new CloudVerifyError("unexpected", 502, "Google token exchange failed.", "Retry in a minute.");
  }
  return { clientEmail: sa.client_email, projectId: sa.project_id };
}

// ─── Azure: client-credentials token + subscription lookup ───────────────────

export async function verifyAzure(c: CloudCreds<"azure">) {
  // tenantId / subscriptionId are schema-validated GUIDs, so safe in the path.
  const tokenRes = await timedFetch(
    `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope: "https://management.azure.com/.default",
      }),
    },
    "login.microsoftonline.com"
  );
  if (!tokenRes.ok) {
    const body = (await tokenRes.json().catch(() => ({}))) as { error_codes?: number[] };
    const aadsts = body.error_codes?.[0];
    if (tokenRes.status === 400 || tokenRes.status === 401) {
      throw new CloudVerifyError(
        "not_authorized",
        401,
        `Azure AD rejected the service principal${aadsts ? ` (AADSTS${aadsts})` : ""}.`,
        "Check the tenant ID, client ID and that the client secret hasn't expired."
      );
    }
    throw new CloudVerifyError("unexpected", 502, "Azure token request failed.", "Retry in a minute.");
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const subRes = await timedFetch(
    `https://management.azure.com/subscriptions/${c.subscriptionId}?api-version=2022-12-01`,
    { headers: { Authorization: `Bearer ${access_token}` } },
    "management.azure.com"
  );
  if (subRes.status === 404) {
    throw new CloudVerifyError("not_found", 404, "Subscription wasn't found for this tenant.", "Check the subscription ID.");
  }
  if (subRes.status === 401 || subRes.status === 403) {
    throw new CloudVerifyError("forbidden", 403, "The service principal can't access this subscription.", "Grant it the Contributor role on the subscription (or the target resource group).");
  }
  if (!subRes.ok) throw new CloudVerifyError("unexpected", 502, "Azure Resource Manager call failed.", "Retry in a minute.");
  const sub = (await subRes.json()) as { displayName?: string };
  return { subscriptionId: c.subscriptionId, displayName: sub.displayName ?? null };
}

// ─── Kubernetes: kubeconfig → API server /version + SelfSubjectReview ────────

type KubeConfig = {
  "current-context"?: string;
  contexts?: { name: string; context: { cluster: string; user: string } }[];
  clusters?: { name: string; cluster: { server?: string; "certificate-authority-data"?: string; "certificate-authority"?: string; "insecure-skip-tls-verify"?: boolean } }[];
  users?: { name: string; user: { token?: string; "client-certificate-data"?: string; "client-key-data"?: string; exec?: unknown; "auth-provider"?: unknown; "client-certificate"?: string; tokenFile?: string } }[];
};

export type ResolvedKube = {
  server: URL;
  ca?: Buffer;
  insecure: boolean;
  token?: string;
  cert?: Buffer;
  key?: Buffer;
};

const invalidKube = (msg: string) =>
  new CloudVerifyError("invalid_credentials", 400, msg, "Export a self-contained kubeconfig (kubectl config view --minify --flatten).");

export function resolveKubeconfig(raw: string): ResolvedKube {
  let doc: KubeConfig;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as KubeConfig;
  } catch {
    throw invalidKube("Kubeconfig isn't valid YAML.");
  }
  if (!doc || typeof doc !== "object") throw invalidKube("Kubeconfig is empty.");
  const ctxName = doc["current-context"] ?? doc.contexts?.[0]?.name;
  const ctx = doc.contexts?.find((c) => c.name === ctxName)?.context;
  if (!ctx) throw invalidKube("Kubeconfig has no usable current-context.");
  const cluster = doc.clusters?.find((c) => c.name === ctx.cluster)?.cluster;
  const user = doc.users?.find((u) => u.name === ctx.user)?.user;
  if (!cluster?.server || !user) throw invalidKube("The current context's cluster or user is missing.");

  if (user.exec || user["auth-provider"]) {
    throw new CloudVerifyError(
      "unsupported_auth",
      400,
      "Exec / auth-provider plugins (aws eks get-token, gke-gcloud-auth-plugin, kubelogin) aren't supported.",
      "Use a ServiceAccount token or client-certificate kubeconfig with embedded data."
    );
  }
  if (cluster["certificate-authority"] || user["client-certificate"] || user.tokenFile) {
    throw invalidKube("Kubeconfig references local files; embed them as *-data fields.");
  }

  let server: URL;
  try {
    server = new URL(cluster.server);
  } catch {
    throw invalidKube("Cluster server URL is invalid.");
  }
  if (server.protocol !== "https:") throw invalidKube("Cluster server must use https://.");

  const fromB64 = (v?: string) => (v ? Buffer.from(v, "base64") : undefined);
  const resolved: ResolvedKube = {
    server,
    ca: fromB64(cluster["certificate-authority-data"]),
    insecure: cluster["insecure-skip-tls-verify"] === true,
    token: user.token,
    cert: fromB64(user["client-certificate-data"]),
    key: fromB64(user["client-key-data"]),
  };
  if (!resolved.token && !(resolved.cert && resolved.key)) {
    throw invalidKube("The current user has no token or client certificate.");
  }
  return resolved;
}

// SSRF guard: the server URL is user-supplied, so refuse loopback / private /
// link-local / metadata ranges. Such clusters aren't reachable from
// GitHub-hosted runners either.
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string; family: number }[];
  try {
    addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  } catch {
    throw networkErr(host);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new CloudVerifyError("blocked_host", 400, "The cluster API server resolves to a private or loopback address.", "Helios and GitHub-hosted runners can only reach publicly routable API servers.");
  }
  return addrs[0];
}

function kubeRequest(
  k: ResolvedKube,
  pinned: { address: string; family: number },
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        protocol: "https:",
        hostname: k.server.hostname.replace(/^\[|\]$/g, ""),
        port: k.server.port || 443,
        path: `${k.server.pathname.replace(/\/$/, "")}${path}`,
        method,
        // Connect to the vetted address only (defeats DNS rebinding); TLS still verifies the hostname.
        lookup: (_h, opts, cb) =>
          (opts as { all?: boolean }).all
            ? (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned])
            : cb(null, pinned.address, pinned.family),
        ca: k.ca,
        cert: k.cert,
        key: k.key,
        rejectUnauthorized: !k.insecure,
        timeout: TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...(k.token ? { Authorization: `Bearer ${k.token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size < 256_000) chunks.push(c);
        });
        res.on("end", () => {
          let json: unknown = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      const tls = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(e.code ?? "");
      reject(
        tls
          ? new CloudVerifyError("invalid_credentials", 400, "TLS verification against the cluster CA failed.", "Check certificate-authority-data in the kubeconfig.")
          : networkErr(k.server.host)
      );
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function verifyK8s(c: CloudCreds<"k8s">) {
  const k = resolveKubeconfig(c.kubeconfig);
  const pinned = await resolvePublicAddress(k.server.hostname);

  const version = await kubeRequest(k, pinned, "GET", "/version");
  if (version.status === 401) throw new CloudVerifyError("not_authorized", 401, "The API server rejected these credentials.", "The token or client certificate may be expired.");
  if (version.status !== 200 && version.status !== 403) {
    throw new CloudVerifyError("unexpected", 502, `API server /version returned HTTP ${version.status}.`, "Check the cluster server URL.");
  }

  // /version is often anonymous-readable; SelfSubjectReview (K8s ≥1.28) proves the creds.
  const review = await kubeRequest(k, pinned, "POST", "/apis/authentication.k8s.io/v1/selfsubjectreviews", {
    apiVersion: "authentication.k8s.io/v1",
    kind: "SelfSubjectReview",
  });
  if (review.status === 401) throw new CloudVerifyError("not_authorized", 401, "The API server rejected these credentials.", "The token or client certificate may be expired.");
  const username =
    review.status === 201 || review.status === 200
      ? ((review.json as { status?: { userInfo?: { username?: string } } })?.status?.userInfo?.username ?? null)
      : null;
  return {
    server: k.server.origin,
    version: (version.json as { gitVersion?: string } | null)?.gitVersion ?? null,
    username,
  };
}

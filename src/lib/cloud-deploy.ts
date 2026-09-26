// Server-only helpers for the GitHub-Actions-driven cloud deploy targets
// (AWS / GCP / Azure / Kubernetes). The generated repo ships
// `.github/workflows/deploy.yml` (workflow_dispatch); Helios stores the
// user's cloud credentials as encrypted repository secrets, dispatches the
// workflow and polls its run. See `runCloudDeployPipeline` in deploy-pipeline.ts.

import sodium from "libsodium-wrappers";
import type { CloudProvider, CloudCreds } from "./cloud-providers";

export const DEPLOY_WORKFLOW_FILE = "deploy.yml";

// ─── Secret names ────────────────────────────────────────────────────────────
// SINGLE source of truth (on the Helios side) for the Actions secret names the
// generated deploy.yml reads. Mirrors `DEPLOY_SECRETS` in
// src/lib/generators/deploy.ts — switch to importing it once both land.
// Not secrets by design: AWS region (config.region is baked into the task
// definition), GCP project id (read from the key), Azure resource group.
export const CLOUD_SECRET_NAMES = {
  aws: {
    accessKeyId: "AWS_ACCESS_KEY_ID",
    secretAccessKey: "AWS_SECRET_ACCESS_KEY",
    roleArn: "AWS_ROLE_ARN", // OIDC mode — set instead of (never alongside) the key pair
  },
  gcp: {
    serviceAccountKey: "GCP_SA_KEY",
  },
  azure: {
    credentials: "AZURE_CREDENTIALS", // sdk-auth JSON
  },
  k8s: {
    kubeconfig: "KUBECONFIG", // raw file contents, not base64
    secretsEnv: "K8S_SECRETS_ENV", // optional dotenv of the stack's env vars
  },
} as const;

type EnvVar = { key: string; value: string };

// dotenv body for K8S_SECRETS_ENV (kubectl --from-env-file style: raw
// KEY=value, one per line). Skips masked placeholders and multi-line values.
function toDotenv(envVars: EnvVar[]): string {
  return envVars
    .filter((v) => v.key && v.value && !v.value.includes("••") && !/[\r\n]/.test(v.value))
    .map((v) => `${v.key}=${v.value}`)
    .join("\n");
}

/** Maps stored credentials (+ the stack's env vars, k8s only) to `{ SECRET_NAME: value }`. */
export function cloudSecretsFor<P extends CloudProvider>(
  provider: P,
  creds: CloudCreds<P>,
  envVars: EnvVar[] = []
): Record<string, string> {
  switch (provider) {
    case "aws": {
      const c = creds as CloudCreds<"aws">;
      const n = CLOUD_SECRET_NAMES.aws;
      if ("roleArn" in c) return { [n.roleArn]: c.roleArn };
      return { [n.accessKeyId]: c.accessKeyId, [n.secretAccessKey]: c.secretAccessKey };
    }
    case "gcp": {
      const c = creds as CloudCreds<"gcp">;
      parseGcpServiceAccount(c.serviceAccountKey); // throws if unusable
      return { [CLOUD_SECRET_NAMES.gcp.serviceAccountKey]: c.serviceAccountKey };
    }
    case "azure": {
      const c = creds as CloudCreds<"azure">;
      return {
        [CLOUD_SECRET_NAMES.azure.credentials]: JSON.stringify({
          clientId: c.clientId,
          clientSecret: c.clientSecret,
          subscriptionId: c.subscriptionId,
          tenantId: c.tenantId,
        }),
      };
    }
    case "k8s": {
      const c = creds as CloudCreds<"k8s">;
      const n = CLOUD_SECRET_NAMES.k8s;
      const dotenv = toDotenv(envVars);
      return { [n.kubeconfig]: c.kubeconfig, ...(dotenv ? { [n.secretsEnv]: dotenv } : {}) };
    }
  }
  throw new Error("unknown cloud provider");
}

export type GcpServiceAccount = { client_email: string; private_key: string; project_id: string; token_uri?: string };

/** Throws a plain Error with a user-safe message when the JSON isn't a usable SA key. */
export function parseGcpServiceAccount(raw: string): GcpServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Service account key is not valid JSON.");
  }
  const sa = parsed as Partial<GcpServiceAccount> & { type?: string };
  if (sa.type !== "service_account" || !sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error("JSON is not a service account key (needs type, client_email, private_key, project_id).");
  }
  return sa as GcpServiceAccount;
}

// ─── Sealed-box encryption ───────────────────────────────────────────────────

/**
 * Encrypts a secret for the GitHub Actions secrets API: libsodium sealed box
 * (crypto_box_seal) against the repo's base64 public key; returns base64.
 */
export async function sealSecret(value: string, publicKeyB64: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

// ─── GitHub Actions client ───────────────────────────────────────────────────

export type ActionsErrorCode =
  | "not_authorized"
  | "insufficient_scope"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "network_error"
  | "server_error";

export class ActionsError extends Error {
  code: ActionsErrorCode;
  httpStatus: number;
  constructor(code: ActionsErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "ActionsError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Helios-App/1.0",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ActionsError("network_error", 503, "api.github.com wasn't reachable.");
  }
  if (res.ok) return res;
  const status = res.status;
  if (status === 401) throw new ActionsError("not_authorized", 401, "GitHub token is missing or expired.");
  if (status === 429 || (status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new ActionsError("rate_limited", 429, "GitHub rate limit hit.");
  }
  if (status === 403) throw new ActionsError("insufficient_scope", 403, "GitHub token lacks repo/workflow scope.");
  if (status === 404) throw new ActionsError("not_found", 404, `GitHub returned 404 for ${path.split("?")[0]}.`);
  if (status === 422) throw new ActionsError("validation", 422, "GitHub rejected the request.");
  throw new ActionsError("server_error", status, `GitHub returned HTTP ${status}.`);
}

export async function getDefaultBranch(token: string, fullName: string): Promise<string> {
  const res = await gh(token, `/repos/${fullName}`);
  return ((await res.json()) as { default_branch: string }).default_branch;
}

/** Encrypts and stores each secret on the repo. Never logs values. */
export async function putRepoSecrets(token: string, fullName: string, secrets: Record<string, string>): Promise<void> {
  const keyRes = await gh(token, `/repos/${fullName}/actions/secrets/public-key`);
  const { key_id, key } = (await keyRes.json()) as { key_id: string; key: string };
  for (const [name, value] of Object.entries(secrets)) {
    const encrypted_value = await sealSecret(value, key);
    await gh(token, `/repos/${fullName}/actions/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value, key_id }),
    });
  }
}

/**
 * Secrets from the provider's *other* credential mode. configure-aws-credentials prefers
 * static keys when both are present, so a repo that once used keys would silently keep
 * using them after switching to OIDC (and a stale AWS_ROLE_ARN would be assumed in key mode).
 */
export function supersededSecrets(provider: CloudProvider, secrets: Record<string, string>): string[] {
  if (provider !== "aws") return [];
  const n = CLOUD_SECRET_NAMES.aws;
  return n.roleArn in secrets ? [n.accessKeyId, n.secretAccessKey] : [n.roleArn];
}

/** Deletes repo secrets; ones that don't exist are fine. */
export async function deleteRepoSecrets(token: string, fullName: string, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      await gh(token, `/repos/${fullName}/actions/secrets/${name}`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof ActionsError && err.code === "not_found")) throw err;
    }
  }
}

export async function dispatchWorkflow(token: string, fullName: string, ref: string): Promise<void> {
  await gh(token, `/repos/${fullName}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
}

export type WorkflowRun = {
  id: number;
  html_url: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: string | null;
  created_at: string;
};

/** Latest workflow_dispatch run of deploy.yml created at/after `since` (ms epoch), if any. */
export async function findDispatchedRun(token: string, fullName: string, since: number): Promise<WorkflowRun | null> {
  const res = await gh(
    token,
    `/repos/${fullName}/actions/workflows/${DEPLOY_WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=10`
  );
  const { workflow_runs } = (await res.json()) as { workflow_runs: WorkflowRun[] };
  // Allow for clock skew between us and GitHub.
  const candidates = workflow_runs.filter((r) => Date.parse(r.created_at) >= since - 60_000);
  candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return candidates[0] ?? null;
}

export async function getRun(token: string, fullName: string, runId: number): Promise<WorkflowRun> {
  const res = await gh(token, `/repos/${fullName}/actions/runs/${runId}`);
  return (await res.json()) as WorkflowRun;
}

/** Name of the first in-progress job step, for progress detail. Best-effort. */
export async function getActiveStep(token: string, fullName: string, runId: number): Promise<string | null> {
  const res = await gh(token, `/repos/${fullName}/actions/runs/${runId}/jobs`);
  const { jobs } = (await res.json()) as {
    jobs: { name: string; status: string; steps?: { name: string; status: string }[] }[];
  };
  for (const job of jobs) {
    if (job.status !== "in_progress") continue;
    const step = job.steps?.find((s) => s.status === "in_progress");
    return step ? `${job.name} › ${step.name}` : job.name;
  }
  return null;
}

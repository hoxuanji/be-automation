// Minimal Vercel API client.
//
// Auth: Authorization: Bearer <token> where token is a Personal Access Token
// from vercel.com/account/tokens. Team tokens also work but we default to
// personal scope.
//
// Base URL: https://api.vercel.com
//
// Deploy flow:
// 1. Create a project linked to a GitHub repo → Vercel installs a webhook and
//    triggers the first deployment automatically (same as Render autoDeploy).
// 2. Set environment variables on the project.
// 3. Surface the project dashboard URL and the canonical .vercel.app hostname.
//
// Prerequisite (communicated to the user): the Vercel GitHub App must be
// installed on the GitHub account/org that owns the pushed repo. The API
// returns a clear error if it isn't — we surface it as a "vercel_no_github"
// code with an install link hint.

const VERCEL_API = "https://api.vercel.com";

export type VercelErrorCode =
  | "not_authorized"
  | "rate_limited"
  | "validation"
  | "network_error"
  | "server_error"
  | "conflict"
  | "no_github"
  | "unknown";

export class VercelError extends Error {
  code: VercelErrorCode;
  httpStatus: number;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(opts: {
    code: VercelErrorCode;
    httpStatus: number;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(opts.message);
    this.name = "VercelError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function classifyVercel(status: number, body: Record<string, unknown>): VercelError {
  const errCode = (body?.error as Record<string, unknown>)?.code as string | undefined;
  const errMsg = ((body?.error as Record<string, unknown>)?.message ?? "") as string;

  if (status === 401 || status === 403) {
    return new VercelError({
      code: "not_authorized",
      httpStatus: status,
      message:
        "Vercel rejected the token. Ensure it's a Personal Access Token from vercel.com/account/tokens with no scope restrictions.",
      retryable: false,
    });
  }
  if (errCode === "missing_github_installation" || errCode === "repo_not_found" || (errMsg && errMsg.toLowerCase().includes("github"))) {
    return new VercelError({
      code: "no_github",
      httpStatus: 400,
      message:
        "Vercel can't access the GitHub repo. Install the Vercel GitHub App on your account at vercel.com/integrations/github, then retry.",
      retryable: false,
    });
  }
  if (status === 409 || errCode === "project_already_exists" || errMsg.toLowerCase().includes("already exists")) {
    return new VercelError({
      code: "conflict",
      httpStatus: 409,
      message: errMsg || "A Vercel project with this name already exists.",
      retryable: false,
    });
  }
  if (status === 429) {
    return new VercelError({
      code: "rate_limited",
      httpStatus: 429,
      message: "Rate limited by Vercel. Retrying shortly.",
      retryable: true,
      retryAfterMs: 5000,
    });
  }
  if (status >= 500) {
    return new VercelError({
      code: "server_error",
      httpStatus: status,
      message: `Vercel API returned ${status}. Retrying.`,
      retryable: true,
    });
  }
  if (status === 400) {
    return new VercelError({
      code: "validation",
      httpStatus: 400,
      message: errMsg || "Vercel rejected the request as invalid.",
      retryable: false,
    });
  }
  return new VercelError({
    code: "unknown",
    httpStatus: status || 502,
    message: errMsg || "Vercel API call failed.",
    retryable: false,
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function vercelFetch<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const maxAttempts = 3;
  let lastErr: VercelError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${VERCEL_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      lastErr = new VercelError({
        code: "network_error",
        httpStatus: 0,
        message: `Network error reaching Vercel: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
        retryable: attempt < maxAttempts,
      });
      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }
      throw lastErr;
    }

    let parsed: Record<string, unknown> = {};
    try {
      const text = await res.text();
      if (text) parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // non-JSON body — ignore
    }

    if (res.ok) return parsed as T;

    const err = classifyVercel(res.status, parsed);
    if (err.retryable && attempt < maxAttempts) {
      await sleep(err.retryAfterMs ?? 1000 * attempt);
      lastErr = err;
      continue;
    }
    throw err;
  }

  throw lastErr!;
}

// ─── Exported operations ─────────────────────────────────────────────────────

export type VercelUser = {
  uid: string;
  username: string;
  email: string;
  name: string;
};

export async function getVercelUser(token: string): Promise<VercelUser> {
  const data = await vercelFetch<{ user: VercelUser }>(token, "GET", "/v2/user");
  return data.user;
}

export type VercelProject = {
  id: string;
  name: string;
  accountId: string;
};

// Create a Vercel project linked to a GitHub repo. The token's owner must
// have the Vercel GitHub App installed — if not, a VercelError with code
// "no_github" is thrown.
export async function createVercelProject(
  token: string,
  name: string,
  githubRepo: string // "owner/repo" full name
): Promise<VercelProject> {
  return vercelFetch<VercelProject>(token, "POST", "/v10/projects", {
    name,
    gitRepository: { type: "github", repo: githubRepo },
    framework: null, // backend — no Next.js/React framework detection
  });
}

type VercelEnvInput = {
  key: string;
  value: string;
  type: "encrypted" | "plain";
  target: ("production" | "preview" | "development")[];
};

export async function setVercelEnvVars(
  token: string,
  projectId: string,
  vars: Record<string, string>
): Promise<void> {
  const entries = Object.entries(vars);
  if (entries.length === 0) return;
  const body: VercelEnvInput[] = entries.map(([key, value]) => ({
    key,
    value,
    type: "encrypted",
    target: ["production", "preview", "development"],
  }));
  await vercelFetch(token, "POST", `/v10/projects/${projectId}/env`, body);
}

export function vercelProjectUrl(username: string, projectName: string): string {
  return `https://vercel.com/${username}/${projectName}`;
}

export function vercelDeploymentUrl(projectName: string): string {
  return `https://${projectName}.vercel.app`;
}

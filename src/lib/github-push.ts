import { generate } from "@/lib/generators";
import type { StackConfig, Endpoint, Entity } from "@/lib/generators/types";
import { PipelineError } from "./pipeline-types";

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function ghFetch(path: string, token: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Helios-App/1.0",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

function retryAfterFromHeaders(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const resetAt = Number(reset) * 1000;
    if (Number.isFinite(resetAt)) return Math.max(0, resetAt - Date.now());
  }
  return undefined;
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<{ ok: true; value: T } | { ok: false; status: number; retryAfterMs?: number }>
): Promise<{ ok: true; value: T } | { ok: false; status: number }> {
  const maxAttempts = 3;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (result.ok) return result;
      lastStatus = result.status;
      if (!isTransient(result.status) || attempt === maxAttempts) {
        return { ok: false, status: result.status };
      }
      const backoff = result.retryAfterMs ?? Math.min(8000, 500 * 2 ** (attempt - 1));
      console.warn(`[github/push] ${label} failed (${result.status}); retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts - 1})`);
      await sleep(backoff);
    } catch (err) {
      lastStatus = 0;
      if (attempt === maxAttempts) {
        console.error(`[github/push] ${label} network error after ${maxAttempts} attempts:`, err);
        return { ok: false, status: 0 };
      }
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      console.warn(`[github/push] ${label} threw; retrying in ${backoff}ms:`, err instanceof Error ? err.message : err);
      await sleep(backoff);
    }
  }
  return { ok: false, status: lastStatus };
}

// ─── Error helpers ───────────────────────────────────────────────────────────

function errFromStatus(status: number, res?: Response): PipelineError | null {
  if (status === 0) {
    return new PipelineError({
      code: "network_error",
      status: 503,
      message: "Couldn't reach GitHub.",
      hint: "api.github.com wasn't reachable. Check connectivity and retry.",
    });
  }
  if (status === 401) {
    return new PipelineError({
      code: "token_invalid",
      status: 401,
      message: "GitHub token is missing or expired.",
      hint: "Reconnect GitHub from Settings → Integrations.",
    });
  }
  if (status === 403) {
    if (res?.headers.get("x-ratelimit-remaining") === "0") {
      const retry = retryAfterFromHeaders(res);
      return new PipelineError({
        code: "rate_limited",
        status: 429,
        message: "GitHub rate limit hit.",
        hint: retry ? `Retry in ~${Math.max(1, Math.ceil(retry / 1000))}s.` : "Retry in a minute.",
      });
    }
    return new PipelineError({
      code: "insufficient_scope",
      status: 403,
      message: "GitHub token is missing the repo scope.",
      hint: "Disconnect and reconnect GitHub to re-authorize with the repo scope.",
    });
  }
  if (status === 429) {
    return new PipelineError({
      code: "rate_limited",
      status: 429,
      message: "GitHub rate limit hit.",
      hint: "Retry in a minute.",
    });
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type PushParams = {
  token: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  repoName: string;
  isPrivate?: boolean;
};

export type PushResult = {
  url: string;
  fullName: string;
  fileCount: number;
  commitUrl: string | null;
};

type RepoShape = {
  full_name: string;
  html_url: string;
  default_branch: string;
  owner: { login: string };
  name: string;
};

/**
 * Pushes a freshly generated repo to GitHub. Throws `PipelineError` on failure.
 * Retries transient errors with exponential backoff, and recovers from
 * stale-HEAD races by re-fetching the ref and retrying the commit once.
 */
export async function pushGeneratedRepo(params: PushParams): Promise<PushResult> {
  const { token, config, endpoints, entities, repoName, isPrivate = false } = params;
  const files = generate(config, endpoints, entities);

  // 1. Create repo (or reuse existing)
  const repoResult = await withRetry<RepoShape>("create-or-fetch-repo", async () => {
    const createRes = await ghFetch("/user/repos", token, {
      method: "POST",
      body: JSON.stringify({
        name: repoName,
        description: `Generated by Helios — ${config.language}/${config.framework}`,
        auto_init: true,
        private: isPrivate,
      }),
    });
    if (createRes.ok) {
      return { ok: true, value: (await createRes.json()) as RepoShape };
    }
    if (createRes.status === 422) {
      const userRes = await ghFetch("/user", token);
      if (!userRes.ok) {
        return { ok: false, status: userRes.status, retryAfterMs: retryAfterFromHeaders(userRes) };
      }
      const ghUser = (await userRes.json()) as { login: string };
      const getRes = await ghFetch(`/repos/${ghUser.login}/${repoName}`, token);
      if (getRes.ok) {
        return { ok: true, value: (await getRes.json()) as RepoShape };
      }
      return { ok: false, status: 422 };
    }
    return { ok: false, status: createRes.status, retryAfterMs: retryAfterFromHeaders(createRes) };
  });

  if (!repoResult.ok) {
    throw errFromStatus(repoResult.status) ?? new PipelineError({
      code: "repo_create_failed",
      status: 422,
      message: "GitHub refused to create the repository.",
      hint: "Check the repo name and whether it already exists under a different owner.",
    });
  }
  const repo = repoResult.value;
  const owner = repo.owner.login;
  const name = repo.name;
  const branch = repo.default_branch;

  console.log(`[github/push] pushing ${files.length} files to ${owner}/${name} on branch ${branch}`);

  // 2. Push additions with stale-HEAD recovery
  const additions = files.map((f) => ({
    path: f.path,
    contents: Buffer.from(f.content, "utf8").toString("base64"),
  }));

  let commitUrl: string | null = null;
  let commitOid: string | null = null;
  for (let attempt = 1; attempt <= 2 && !commitOid; attempt++) {
    const refResult = await withRetry<string>("get-ref", async () => {
      const refRes = await ghFetch(`/repos/${owner}/${name}/git/refs/heads/${branch}`, token);
      if (!refRes.ok) return { ok: false, status: refRes.status, retryAfterMs: retryAfterFromHeaders(refRes) };
      const refData = (await refRes.json()) as { object?: { sha: string } };
      if (!refData.object?.sha) return { ok: false, status: 502 };
      return { ok: true, value: refData.object.sha };
    });
    if (!refResult.ok) {
      throw errFromStatus(refResult.status) ?? new PipelineError({
        code: "commit_failed",
        status: 502,
        message: "Couldn't read the default branch.",
        hint: "Verify the repo isn't empty and the branch name matches.",
      });
    }
    const headOid = refResult.value;

    const commitResult = await withRetry<{ oid: string; url: string } | "stale_oid">(
      "create-commit",
      async () => {
        const gqlRes = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Helios-App/1.0",
          },
          body: JSON.stringify({
            query: `mutation CreateCommit($input: CreateCommitOnBranchInput!) {
              createCommitOnBranch(input: $input) {
                commit { oid url }
              }
            }`,
            variables: {
              input: {
                branch: { repositoryNameWithOwner: `${owner}/${name}`, branchName: branch },
                message: {
                  headline: "chore: initial backend generated by Helios",
                  body: `Stack: ${config.language} / ${config.framework} / ${config.database}`,
                },
                fileChanges: { additions },
                expectedHeadOid: headOid,
              },
            },
          }),
        });
        if (!gqlRes.ok) {
          return { ok: false, status: gqlRes.status, retryAfterMs: retryAfterFromHeaders(gqlRes) };
        }
        const gqlJson = (await gqlRes.json()) as {
          data?: { createCommitOnBranch: { commit: { oid: string; url: string } } };
          errors?: { message: string; type?: string }[];
        };
        if (gqlJson.errors?.length) {
          const staleOid = gqlJson.errors.some((e) => /expected.*head|stale|not.*match/i.test(e.message));
          if (staleOid) return { ok: true, value: "stale_oid" };
          console.error("[github/push] GraphQL commit failed:", JSON.stringify(gqlJson.errors));
          return { ok: false, status: 422 };
        }
        const commit = gqlJson.data?.createCommitOnBranch?.commit;
        if (!commit) return { ok: false, status: 502 };
        return { ok: true, value: commit };
      }
    );

    if (!commitResult.ok) {
      throw errFromStatus(commitResult.status) ?? new PipelineError({
        code: "commit_failed",
        status: 502,
        message: "Couldn't push the initial commit.",
        hint: "GitHub rejected the commit. Check for protected branches.",
      });
    }
    if (commitResult.value === "stale_oid") {
      console.warn("[github/push] stale HEAD OID; refetching and retrying");
      continue;
    }
    commitOid = commitResult.value.oid;
    commitUrl = commitResult.value.url;
  }

  if (!commitOid) {
    throw new PipelineError({
      code: "commit_failed",
      status: 502,
      message: "Couldn't push the initial commit after retry.",
      hint: "The default branch kept moving. Retry the operation.",
    });
  }

  console.log(`[github/push] done — commit ${commitOid}`);

  return {
    url: repo.html_url,
    fullName: repo.full_name,
    fileCount: files.length,
    commitUrl,
  };
}

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

async function ghFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Helios-App/1.0",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

const envSchema = z.object({
  name: z.string().min(1).max(100),
  targetBranches: z.array(z.string()).max(10),
  requireApproval: z.boolean(),
  waitTimer: z.number().int().min(0).max(43200).optional(),
});

const bodySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  environments: z.array(envSchema).min(1).max(10),
  // Branch protection rules to apply
  branchProtection: z.array(z.object({
    pattern: z.string(),
    requirePr: z.boolean(),
    requiredApprovals: z.number().int().min(0).max(6),
    dismissStaleReviews: z.boolean(),
    requireStatusChecks: z.boolean(),
    requireLinearHistory: z.boolean(),
    allowForcePush: z.boolean(),
  })).optional(),
});

// POST /api/github/environments — push environments + branch protection rules to GitHub
export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) {
    return NextResponse.json({ error: "no_token", message: "GitHub not connected." }, { status: 401 });
  }

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { owner, repo, environments, branchProtection } = parsed.data;

  const results: { name: string; ok: boolean; error?: string }[] = [];

  // Push each environment
  await Promise.all(
    environments.map(async (env) => {
      const body: Record<string, unknown> = {
        wait_timer: env.waitTimer ?? 0,
        reviewers: env.requireApproval ? [] : [],
      };

      if (env.targetBranches.length > 0) {
        body.deployment_branch_policy = {
          protected_branches: false,
          custom_branch_policies: true,
        };
      }

      const res = await ghFetch(
        `/repos/${owner}/${repo}/environments/${encodeURIComponent(env.name)}`,
        token,
        { method: "PUT", body: JSON.stringify(body) }
      );

      if (res.ok && env.targetBranches.length > 0) {
        // Set deployment branch policies
        await Promise.all(
          env.targetBranches.map((branch) =>
            ghFetch(
              `/repos/${owner}/${repo}/environments/${encodeURIComponent(env.name)}/deployment-branch-policies`,
              token,
              { method: "POST", body: JSON.stringify({ name: branch }) }
            )
          )
        );
      }

      results.push({ name: env.name, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` });
    })
  );

  // Push branch protection rules (best-effort — requires admin access)
  const protectionResults: { pattern: string; ok: boolean; error?: string }[] = [];
  if (branchProtection?.length) {
    await Promise.all(
      branchProtection.map(async (rule) => {
        const body = {
          required_status_checks: rule.requireStatusChecks
            ? { strict: true, contexts: ["CI"] }
            : null,
          enforce_admins: false,
          required_pull_request_reviews: rule.requirePr
            ? {
                dismiss_stale_reviews: rule.dismissStaleReviews,
                required_approving_review_count: rule.requiredApprovals,
              }
            : null,
          restrictions: null,
          allow_force_pushes: rule.allowForcePush,
          required_linear_history: rule.requireLinearHistory,
        };

        const res = await ghFetch(
          `/repos/${owner}/${repo}/branches/${encodeURIComponent(rule.pattern)}/protection`,
          token,
          { method: "PUT", body: JSON.stringify(body) }
        );
        protectionResults.push({
          pattern: rule.pattern,
          ok: res.ok,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        });
      })
    );
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json(
    { environments: results, branchProtection: protectionResults, success: allOk },
    { status: allOk ? 200 : 207 }
  );
}

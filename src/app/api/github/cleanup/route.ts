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

// GET /api/github/cleanup?owner=&repo=&base=
// Returns branches whose PRs have been merged into `base`
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const base = searchParams.get("base") ?? "main";

  if (!owner || !repo) return NextResponse.json({ error: "missing_params" }, { status: 400 });

  const [branchRes, prRes] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}/branches?per_page=100`, token),
    ghFetch(`/repos/${owner}/${repo}/pulls?state=closed&base=${base}&per_page=100`, token),
  ]);

  if (!branchRes.ok || !prRes.ok) {
    return NextResponse.json({ error: "github_error" }, { status: 502 });
  }

  const branches = (await branchRes.json()) as { name: string; protected: boolean }[];
  const pulls = (await prRes.json()) as { head: { ref: string }; merged_at: string | null }[];

  const mergedBranchNames = new Set(
    pulls.filter((p) => p.merged_at).map((p) => p.head.ref)
  );

  const stale = branches
    .filter((b) => !b.protected && mergedBranchNames.has(b.name) && b.name !== base)
    .map((b) => b.name);

  return NextResponse.json({ branches: stale, base });
}

// DELETE /api/github/cleanup — batch delete branches
const deleteSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  branches: z.array(z.string().min(1).max(255)).min(1).max(50),
});

export async function DELETE(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { owner, repo, branches } = parsed.data;
  const deleted: string[] = [];
  const failed: string[] = [];

  await Promise.all(
    branches.map(async (branch) => {
      const res = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
        method: "DELETE",
      });
      if (res.ok || res.status === 422) {
        deleted.push(branch);
      } else {
        failed.push(branch);
      }
    })
  );

  return NextResponse.json({ deleted, failed });
}

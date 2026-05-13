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

// GET /api/github/branches?owner=&repo=  — list branches
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  if (!owner || !repo) return NextResponse.json({ error: "missing_params" }, { status: 400 });

  const res = await ghFetch(`/repos/${owner}/${repo}/branches?per_page=100`, token);
  if (!res.ok) {
    return NextResponse.json(
      { error: "github_error", status: res.status },
      { status: res.status < 500 ? res.status : 502 }
    );
  }
  const data = (await res.json()) as { name: string; protected: boolean }[];
  return NextResponse.json({
    branches: data.map((b) => ({ name: b.name, protected: b.protected })),
  });
}

// POST /api/github/branches — create a branch from base
const createSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  branchName: z.string().min(1).max(255),
  baseBranch: z.string().min(1).max(255),
});

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const { owner, repo, branchName, baseBranch } = parsed.data;

  const refRes = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`, token);
  if (!refRes.ok) {
    return NextResponse.json(
      { error: "base_branch_not_found", message: `Branch '${baseBranch}' was not found in ${owner}/${repo}` },
      { status: 404 }
    );
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const sha = refData.object?.sha;
  if (!sha) return NextResponse.json({ error: "ref_missing_sha" }, { status: 502 });

  const createRes = await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });

  if (!createRes.ok) {
    const errData = (await createRes.json()) as { message?: string };
    return NextResponse.json(
      { error: "branch_create_failed", message: errData.message },
      { status: createRes.status < 500 ? createRes.status : 502 }
    );
  }

  return NextResponse.json({ branchName, sha });
}

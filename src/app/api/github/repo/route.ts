import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

async function ghFetch(path: string, token: string) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Helios-App/1.0",
    },
  });
}

export type GhTreeItem = {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
};

// GET /api/github/repo?owner=&repo=&ref=
// Returns repo metadata + flat recursive file tree
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const ref = searchParams.get("ref"); // optional — defaults to repo's default branch

  if (!owner || !repo) return NextResponse.json({ error: "missing_params" }, { status: 400 });

  // Fetch repo metadata
  const repoRes = await ghFetch(`/repos/${owner}/${repo}`, token);
  if (!repoRes.ok) {
    return NextResponse.json(
      { error: "repo_not_found", message: `Cannot access ${owner}/${repo}` },
      { status: repoRes.status < 500 ? repoRes.status : 502 }
    );
  }
  const repoData = (await repoRes.json()) as {
    default_branch: string;
    description: string | null;
    private: boolean;
    stargazers_count: number;
    language: string | null;
  };

  const branch = ref ?? repoData.default_branch;

  // Get the branch SHA
  const refRes = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token);
  if (!refRes.ok) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const treeSha = refData.object?.sha;
  if (!treeSha) return NextResponse.json({ error: "ref_missing_sha" }, { status: 502 });

  // Get the commit to find the tree SHA
  const commitRes = await ghFetch(`/repos/${owner}/${repo}/git/commits/${treeSha}`, token);
  if (!commitRes.ok) return NextResponse.json({ error: "commit_fetch_failed" }, { status: 502 });
  const commitData = (await commitRes.json()) as { tree: { sha: string } };
  const rootTreeSha = commitData.tree?.sha;
  if (!rootTreeSha) return NextResponse.json({ error: "tree_sha_missing" }, { status: 502 });

  // Fetch the full recursive tree (truncated at ~100k items by GitHub)
  const treeRes = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${rootTreeSha}?recursive=1`,
    token
  );
  if (!treeRes.ok) return NextResponse.json({ error: "tree_fetch_failed" }, { status: 502 });
  const treeData = (await treeRes.json()) as {
    tree: GhTreeItem[];
    truncated: boolean;
  };

  // Filter to blobs only and cap at 500 files for safety
  const files = treeData.tree
    .filter((item) => item.type === "blob")
    .slice(0, 500);

  return NextResponse.json({
    owner,
    repo,
    defaultBranch: repoData.default_branch,
    branch,
    description: repoData.description,
    language: repoData.language,
    isPrivate: repoData.private,
    stars: repoData.stargazers_count,
    headSha: treeSha,
    truncated: treeData.truncated,
    files,
  });
}

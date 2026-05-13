import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  branch: z.string().min(1).max(255),
  message: z.string().min(1).max(500),
  // Files to upsert: path + new content
  changes: z.array(z.object({
    path: z.string().min(1).max(500),
    content: z.string().max(500_000),
  })).min(1).max(200),
  // Expected HEAD sha — prevents committing on top of stale state
  expectedHeadSha: z.string().min(1),
});

// POST /api/github/commit
// Commits a set of file changes to an existing branch via GraphQL
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

  const { owner, repo, branch, message, changes, expectedHeadSha } = parsed.data;

  const additions = changes.map((c) => ({
    path: c.path,
    contents: Buffer.from(c.content, "utf8").toString("base64"),
  }));

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
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          message: { headline: message },
          fileChanges: { additions },
          expectedHeadOid: expectedHeadSha,
        },
      },
    }),
  });

  if (!gqlRes.ok) {
    return NextResponse.json({ error: "commit_failed", message: "GraphQL request failed" }, { status: 502 });
  }

  const gqlJson = (await gqlRes.json()) as {
    data?: { createCommitOnBranch: { commit: { oid: string; url: string } } };
    errors?: { message: string; type?: string }[];
  };

  if (gqlJson.errors?.length) {
    const msg = gqlJson.errors[0].message;
    const isStale = /stale|expected.*head|not.*match/i.test(msg);
    return NextResponse.json(
      { error: isStale ? "stale_head" : "commit_failed", message: msg },
      { status: 422 }
    );
  }

  const commit = gqlJson.data?.createCommitOnBranch?.commit;
  if (!commit) return NextResponse.json({ error: "commit_missing" }, { status: 502 });

  return NextResponse.json({ oid: commit.oid, url: commit.url });
}

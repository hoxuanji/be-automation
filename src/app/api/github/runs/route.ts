import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

export type WorkflowRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | null;
  headBranch: string;
  headSha: string;
  headMessage: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  workflowName: string;
};

// GET /api/github/runs?owner=&repo=&branch=&per_page=
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const owner = searchParams.get("owner");
  const repo = searchParams.get("repo");
  const branch = searchParams.get("branch");
  const perPage = Math.min(Number(searchParams.get("per_page") ?? "10"), 30);

  if (!owner || !repo) return NextResponse.json({ error: "missing_params" }, { status: 400 });

  const qs = new URLSearchParams({ per_page: String(perPage) });
  if (branch) qs.set("branch", branch);

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/runs?${qs}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Helios-App/1.0",
      },
    }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: "github_error", status: res.status },
      { status: res.status < 500 ? res.status : 502 }
    );
  }

  const data = (await res.json()) as {
    workflow_runs: {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      head_branch: string;
      head_sha: string;
      head_commit: { message: string } | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }[];
    total_count: number;
  };

  const runs: WorkflowRun[] = data.workflow_runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status as WorkflowRun["status"],
    conclusion: r.conclusion as WorkflowRun["conclusion"],
    headBranch: r.head_branch,
    headSha: r.head_sha.slice(0, 7),
    headMessage: (r.head_commit?.message ?? "").split("\n")[0].slice(0, 80),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    workflowName: r.name,
  }));

  return NextResponse.json({ runs, totalCount: data.total_count });
}

import { NextRequest } from "next/server";
import { openPrRequestSchema } from "@/lib/autopilot/schema";
import { openPullRequest } from "@/lib/autopilot/committer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = openPrRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const { number, htmlUrl } = await openPullRequest(
      parsed.data.token,
      parsed.data.repo,
      parsed.data.baseBranch,
      parsed.data.proposal
    );
    return Response.json({ number, htmlUrl });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) {
      return Response.json(
        { error: "bad_token", detail: "GitHub rejected the token." },
        { status: 401 }
      );
    }
    if (e.status === 403) {
      return Response.json(
        {
          error: "forbidden",
          detail:
            "Token lacks permission to open PRs on this repo (needs 'repo' scope).",
        },
        { status: 403 }
      );
    }
    return Response.json(
      {
        error: "open_pr_failed",
        detail: e.message ?? "unknown",
      },
      { status: 500 }
    );
  }
}

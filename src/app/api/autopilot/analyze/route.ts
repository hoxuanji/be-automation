import { NextRequest } from "next/server";
import { analyzeRequestSchema } from "@/lib/autopilot/schema";
import { auditRepo } from "@/lib/autopilot/analyzer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = analyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const audit = await auditRepo(parsed.data.token, parsed.data.repo);
    return Response.json(audit);
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) {
      return Response.json(
        { error: "bad_token", detail: "GitHub rejected the token." },
        { status: 401 }
      );
    }
    if (e.status === 404) {
      return Response.json(
        {
          error: "repo_not_found",
          detail:
            "Repo not found — check the owner/name or that the token has access.",
        },
        { status: 404 }
      );
    }
    return Response.json(
      { error: "analyze_failed", detail: e.message ?? "unknown" },
      { status: 500 }
    );
  }
}

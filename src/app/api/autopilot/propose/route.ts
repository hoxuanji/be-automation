import { NextRequest } from "next/server";
import { proposeRequestSchema } from "@/lib/autopilot/schema";
import { proposePr } from "@/lib/autopilot/proposer";
import { fetchFileContent } from "@/lib/autopilot/committer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "missing_api_key",
        detail: "Set ANTHROPIC_API_KEY to enable Autopilot.",
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = proposeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { token, repo, audit, findingIds } = parsed.data;
  const findings = audit.findings.filter((f) => findingIds.includes(f.id));
  if (findings.length === 0) {
    return Response.json(
      { error: "no_findings", detail: "Select at least one finding." },
      { status: 400 }
    );
  }

  // Fetch the *current* contents of any file a finding wants to update, so
  // the model can edit in-place rather than stomp.
  const pathsToFetch = new Set<string>();
  for (const f of findings) {
    for (const pf of f.proposedFiles) {
      if (pf.action === "update") pathsToFetch.add(pf.path);
    }
  }

  const existingFiles: Record<string, string> = {};
  await Promise.all(
    Array.from(pathsToFetch).map(async (path) => {
      const content = await fetchFileContent(
        token,
        repo,
        path,
        audit.repo.defaultBranch
      );
      if (content !== null) existingFiles[path] = content;
    })
  );

  try {
    const proposal = await proposePr({ audit, findings, existingFiles });
    return Response.json({ proposal });
  } catch (err) {
    return Response.json(
      {
        error: "propose_failed",
        detail: (err as Error).message,
      },
      { status: 500 }
    );
  }
}

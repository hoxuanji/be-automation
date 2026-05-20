import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  createProjectShare,
  listProjectShares,
  getTeamMember,
} from "@/lib/db";
import { getProjectAccess, canManage } from "@/lib/permissions";
import { createShareSchema } from "@/lib/schema";

export const runtime = "nodejs";

// GET /api/projects/[id]/shares — list shares (owner-only)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await params;
  const access = getProjectAccess(projectId, claims.sub);
  if (!canManage(access)) {
    // Hide existence from non-owners — same surface area as a non-existent project.
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ shares: listProjectShares(projectId) });
}

// POST /api/projects/[id]/shares — create a share (owner-only)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId } = await params;
  const access = getProjectAccess(projectId, claims.sub);
  if (!canManage(access)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createShareSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Owner must be a member of any team they share with — prevents granting
  // edit access to teams they don't belong to (e.g. via guessed team ids).
  if (parsed.data.principal.type === "team") {
    const member = getTeamMember(parsed.data.principal.teamId, claims.sub);
    if (!member) {
      return Response.json({ error: "not_a_team_member" }, { status: 403 });
    }
  }

  const id = crypto.randomUUID();
  try {
    createProjectShare(id, projectId, parsed.data.principal, parsed.data.permission, claims.sub);
  } catch (err) {
    // CHECK constraint or FK violation — surface a structured error rather
    // than a 500 with raw SQLite text.
    return Response.json(
      { error: "share_failed", detail: err instanceof Error ? err.message : "unknown" },
      { status: 400 }
    );
  }
  return Response.json({ id, ok: true }, { status: 201 });
}

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listSharedWithUser } from "@/lib/db";

export const runtime = "nodejs";

// GET /api/shared-with-me — projects shared with the current user
// (directly or via team membership). Owner's own projects are excluded —
// those live under /api/projects.
export async function GET(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const projects = listSharedWithUser(claims.sub).map((p) => ({
    id: p.id,
    name: p.name,
    permission: p.permission,
    sharedVia: p.shared_via,
    sharedTeamId: p.shared_team_id,
    ownerName: p.owner_name,
    savedAt: new Date(p.updated_at * 1000).toISOString(),
  }));
  return Response.json({ projects });
}

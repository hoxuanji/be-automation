import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTeam, getTeamMember, removeTeamMember } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id, userId } = await params;
  const team = getTeam(id);
  if (!team) return Response.json({ error: "not_found" }, { status: 404 });

  // Owner can remove anyone; a member can only remove themselves
  const requestorMembership = getTeamMember(id, claims.sub);
  if (!requestorMembership) return Response.json({ error: "forbidden" }, { status: 403 });
  if (claims.sub !== userId && requestorMembership.role !== "owner") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (userId === team.owner_id) {
    return Response.json({ error: "cannot_remove_owner" }, { status: 400 });
  }

  removeTeamMember(id, userId);
  return Response.json({ ok: true });
}

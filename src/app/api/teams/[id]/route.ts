import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTeam, getTeamMember, listTeamMembers, listTeamInvites, deleteTeam } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const team = getTeam(id);
  if (!team) return Response.json({ error: "not_found" }, { status: 404 });

  const membership = getTeamMember(id, claims.sub);
  if (!membership) return Response.json({ error: "forbidden" }, { status: 403 });

  const members = listTeamMembers(id);
  const invites = membership.role === "owner" ? listTeamInvites(id) : [];

  return Response.json({ team, members, invites });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const team = getTeam(id);
  if (!team) return Response.json({ error: "not_found" }, { status: 404 });
  if (team.owner_id !== claims.sub) return Response.json({ error: "forbidden" }, { status: 403 });

  deleteTeam(id, claims.sub);
  return Response.json({ ok: true });
}

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTeamMember, listProjectsForTeamMembers } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id: teamId } = await params;

  const member = getTeamMember(teamId, claims.sub);
  if (!member) return Response.json({ error: "forbidden" }, { status: 403 });

  const projects = listProjectsForTeamMembers(teamId);
  return Response.json({ projects });
}

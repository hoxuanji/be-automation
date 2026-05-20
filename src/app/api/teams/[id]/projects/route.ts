import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTeamMember, listProjectsForTeamMembers, getProjectAccessRow } from "@/lib/db";

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

  // Tag each project with the caller's effective permission so the UI can
  // decide whether to render an Edit affordance vs a read-only badge. Owner
  // rows always come back as "owner"; non-owner rows fall through to the
  // share check (which may upgrade them to edit if the share grants it).
  const projects = listProjectsForTeamMembers(teamId).map((p) => {
    const access = getProjectAccessRow(p.id, claims.sub);
    return { ...p, permission: access?.level ?? null };
  });
  return Response.json({ projects });
}

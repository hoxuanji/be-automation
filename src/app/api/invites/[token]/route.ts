import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTeamInvite, getTeam, getTeamMember, addTeamMember, acceptTeamInvite } from "@/lib/db";

export const runtime = "nodejs";

function inviteStatus(invite: { expires_at: number; accepted_at: number | null }) {
  if (invite.accepted_at) return "used";
  if (invite.expires_at < Math.floor(Date.now() / 1000)) return "expired";
  return "valid";
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = getTeamInvite(token);
  if (!invite) return Response.json({ error: "not_found" }, { status: 404 });

  const status = inviteStatus(invite);
  if (status !== "valid") return Response.json({ error: status }, { status: 410 });

  const team = getTeam(invite.team_id);
  return Response.json({
    teamId: invite.team_id,
    teamName: team?.name ?? "Unknown team",
    expiresAt: invite.expires_at,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { token } = await params;
  const invite = getTeamInvite(token);
  if (!invite) return Response.json({ error: "not_found" }, { status: 404 });

  const status = inviteStatus(invite);
  if (status !== "valid") return Response.json({ error: status }, { status: 410 });

  const alreadyMember = getTeamMember(invite.team_id, claims.sub);
  if (!alreadyMember) {
    addTeamMember(invite.team_id, claims.sub, "member");
  }
  acceptTeamInvite(token, claims.sub);

  return Response.json({ teamId: invite.team_id });
}

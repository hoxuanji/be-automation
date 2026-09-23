import { NextRequest } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/auth";
import { getTeam, getTeamMember, createTeamInvite } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const team = getTeam(id);
  if (!team) return Response.json({ error: "not_found" }, { status: 404 });

  const membership = getTeamMember(id, claims.sub);
  if (!membership) return Response.json({ error: "forbidden" }, { status: 403 });

  let email: string | null = null;
  try {
    const body = await req.json() as { email?: string };
    email = body.email?.trim() || null;
  } catch {
    // email is optional — body may be empty
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days

  createTeamInvite(token, id, email, claims.sub, expiresAt);

  const origin = req.headers.get("origin") ?? `https://${req.headers.get("host") ?? "localhost:3000"}`;
  const url = `${origin}/invite/${token}`;

  return Response.json({ token, url, expiresAt });
}

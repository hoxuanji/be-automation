import { NextRequest } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/auth";
import { createTeam, listUserTeams } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const teams = listUserTeams(claims.sub);
  return Response.json({ teams });
}

export async function POST(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string };
  try {
    body = await req.json() as { name?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || name.length < 2 || name.length > 64) {
    return Response.json({ error: "name must be 2–64 characters" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  createTeam(id, name, claims.sub);

  return Response.json({ team: { id, name, role: "owner", memberCount: 1 } }, { status: 201 });
}

import { NextRequest } from "next/server";
import { buildClearCookieHeader, getTokenFromRequest, verifyToken } from "@/lib/auth";
import { deleteSession } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = getTokenFromRequest(req);
  if (token) {
    const payload = await verifyToken(token);
    if (payload?.jti) deleteSession(payload.jti);
  }
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": buildClearCookieHeader() } }
  );
}

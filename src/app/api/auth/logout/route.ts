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
  const headers = new Headers();
  headers.append("Set-Cookie", buildClearCookieHeader());
  // Provider tokens + in-flight OAuth cookies must not outlive the app session.
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  for (const name of [
    "github_token",
    "bitbucket_token",
    "github_return_to",
    "bitbucket_return_to",
    "github_oauth_nonce",
    "bitbucket_oauth_nonce",
  ]) {
    headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
  return Response.json({ ok: true }, { headers });
}

import { NextRequest } from "next/server";
import { getCurrentUser, buildClearCookieHeader, getTokenFromRequest } from "@/lib/auth";
import { findUserById, deleteUser } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const hasCookie = !!getTokenFromRequest(req);
  const claims = await getCurrentUser(req);

  if (!claims) {
    // If there's a cookie but no valid session, clear the stale cookie so the
    // middleware redirects to /login on the next page navigation.
    if (hasCookie) {
      return Response.json({ user: null }, { status: 200, headers: { "Set-Cookie": buildClearCookieHeader() } });
    }
    return Response.json({ user: null }, { status: 200 });
  }

  const user = findUserById(claims.sub);
  if (!user) {
    return Response.json({ user: null }, { status: 200, headers: { "Set-Cookie": buildClearCookieHeader() } });
  }

  return Response.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasApiKey: !!user.llm_api_key_enc,
    },
  });
}

export async function DELETE(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  deleteUser(claims.sub);

  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": buildClearCookieHeader() } }
  );
}

import { NextRequest } from "next/server";
import { getPasswordResetToken, markPasswordResetUsed, updateUserProfile, deleteUserSessions } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 10)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json() as { token?: string; password?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { token, password } = body;
  if (!token || !password || password.length < 8) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const record = getPasswordResetToken(token);
  if (!record) return Response.json({ error: "invalid_token" }, { status: 400 });
  if (record.used_at) return Response.json({ error: "token_used" }, { status: 400 });
  if (record.expires_at < Math.floor(Date.now() / 1000)) return Response.json({ error: "token_expired" }, { status: 400 });

  const passwordHash = await hashPassword(password);
  updateUserProfile(record.user_id, { passwordHash });
  markPasswordResetUsed(token);
  // Invalidate all existing sessions for this user
  deleteUserSessions(record.user_id);

  return Response.json({ ok: true });
}

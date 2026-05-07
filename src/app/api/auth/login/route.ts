import { NextRequest } from "next/server";
import { loginSchema } from "@/lib/schema";
import { verifyPassword, signToken, buildSetCookieHeader } from "@/lib/auth";
import { findUserByEmail } from "@/lib/db";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 10)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;
  const user = findUserByEmail(email.toLowerCase());

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const token = await signToken({ sub: user.id, email: user.email, name: user.name });

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        hasApiKey: !!user.llm_api_key_enc,
      },
    },
    { headers: { "Set-Cookie": buildSetCookieHeader(token) } }
  );
}

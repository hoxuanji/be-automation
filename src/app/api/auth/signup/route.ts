import { NextRequest } from "next/server";
import crypto from "crypto";
import { signupSchema } from "@/lib/schema";
import { hashPassword } from "@/lib/auth";
import { signToken, buildSetCookieHeader } from "@/lib/auth";
import { createUser, findUserByEmail } from "@/lib/db";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 5)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { email, name, password } = parsed.data;

  if (findUserByEmail(email)) {
    return Response.json({ error: "email_taken" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  createUser(id, email.toLowerCase(), name, passwordHash);

  const token = await signToken({ sub: id, email: email.toLowerCase(), name });

  return Response.json(
    { user: { id, email: email.toLowerCase(), name, hasApiKey: false } },
    {
      status: 201,
      headers: { "Set-Cookie": buildSetCookieHeader(token) },
    }
  );
}

import { NextRequest } from "next/server";
import crypto from "crypto";
import { findUserByEmail, createPasswordResetToken } from "@/lib/db";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 5)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: { email?: string };
  try {
    body = await req.json() as { email?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) return Response.json({ error: "email_required" }, { status: 400 });

  // Always return success to prevent user enumeration
  const user = findUserByEmail(email);
  if (user) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
    createPasswordResetToken(token, user.id, expiresAt);

    const origin = req.headers.get("origin") ?? `http://localhost:3000`;
    const resetUrl = `${origin}/reset-password?token=${token}`;

    if (process.env.RESEND_API_KEY) {
      // Send via Resend if configured
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM ?? "noreply@helios.app",
          to: email,
          subject: "Reset your Helios password",
          html: `<p>Click the link below to reset your password. It expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, ignore this email.</p>`,
        }),
      }).catch(() => {});
    } else {
      // Dev fallback: log to console
      console.log(`\n[Helios] Password reset link for ${email}:\n${resetUrl}\n`);
    }
  }

  return Response.json({ ok: true });
}

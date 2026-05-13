import { NextRequest } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/auth";
import { reportGalleryStack } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (!checkRateLimit(`report:${claims.sub}`, 5)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const { id: stackId } = await params;

  let reason: string | undefined;
  try {
    const body = await req.json() as { reason?: unknown };
    if (typeof body.reason === "string") reason = body.reason.slice(0, 500);
  } catch {}

  reportGalleryStack(crypto.randomUUID(), stackId, claims.sub, reason);
  return Response.json({ ok: true });
}

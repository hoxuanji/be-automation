import { NextRequest } from "next/server";
import crypto from "crypto";
import { createGalleryStack, listGalleryStacks, starGalleryStack, deleteGalleryStack } from "@/lib/db";
import { gallerySubmitSchema } from "@/lib/schema";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const language = searchParams.get("language") ?? undefined;
  const q = searchParams.get("q") ?? undefined;
  const offset = parseInt(searchParams.get("offset") ?? "0", 10);

  const rows = listGalleryStacks({ language, q, limit: 24, offset });
  return Response.json({ stacks: rows, hasMore: rows.length === 24 });
}

export async function POST(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (!checkRateLimit(`gallery:${claims.sub}`, 10)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = gallerySubmitSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { title, description, language, framework, useCase, stackUrl } = parsed.data;
  const id = crypto.randomUUID();
  createGalleryStack({ id, title, description: description ?? null, language, framework, use_case: useCase ?? null, author: claims.name, owner_id: claims.sub, stack_url: stackUrl });

  return Response.json({ id }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "id_required" }, { status: 400 });

  const deleted = deleteGalleryStack(id, claims.sub);
  if (!deleted) return Response.json({ error: "not_found_or_not_owner" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function PUT(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 30)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "id_required" }, { status: 400 });

  starGalleryStack(id);
  return Response.json({ ok: true });
}

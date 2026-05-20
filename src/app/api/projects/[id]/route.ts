import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getProjectByIdRaw,
  updateProjectRaw,
  deleteProjectById,
} from "@/lib/db";
import { getProjectAccess, canRead, canWrite, canManage } from "@/lib/permissions";
import { projectPayloadSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = getProjectAccess(id, claims.sub);
  if (!canRead(access)) return Response.json({ error: "not_found" }, { status: 404 });

  const row = getProjectByIdRaw(id);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({
    project: {
      id: row.id,
      name: row.name,
      savedAt: new Date(row.updated_at * 1000).toISOString(),
      // Surface effective permission so the UI can render read-only mode
      // without a second round-trip.
      permission: access,
      ownerId: row.user_id,
      ...JSON.parse(row.data),
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { id } = await params;
  const access = getProjectAccess(id, claims.sub);
  if (!canRead(access)) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canWrite(access)) return Response.json({ error: "forbidden" }, { status: 403 });

  const existing = getProjectByIdRaw(id);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

  const raw = body as Record<string, unknown>;

  // Rename-only: body has just { name }
  if (raw.name && !raw.data) {
    const name = String(raw.name).trim();
    if (!name || name.length > 128) return Response.json({ error: "invalid_name" }, { status: 400 });
    updateProjectRaw(id, name, existing.data);
    return Response.json({ ok: true });
  }

  // Full update: validate with schema
  const parsed = projectPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { name, data } = parsed.data;
  updateProjectRaw(id, name, JSON.stringify(data));
  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = getProjectAccess(id, claims.sub);
  // Only the owner can delete — editors keep the project, deletion is final.
  if (!canManage(access)) {
    return Response.json(
      { error: canRead(access) ? "forbidden" : "not_found" },
      { status: canRead(access) ? 403 : 404 }
    );
  }
  deleteProjectById(id, claims.sub);
  return Response.json({ ok: true });
}

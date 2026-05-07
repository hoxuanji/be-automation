import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  getProjectById,
  updateProject,
  deleteProjectById,
} from "@/lib/db";
import { projectPayloadSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const row = getProjectById(id, claims.sub);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({
    project: {
      id: row.id,
      name: row.name,
      savedAt: new Date(row.updated_at * 1000).toISOString(),
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

  const parsed = projectPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;
  const { name, data } = parsed.data;
  updateProject(id, claims.sub, name, JSON.stringify(data));

  return Response.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  deleteProjectById(id, claims.sub);
  return Response.json({ ok: true });
}

import { NextRequest } from "next/server";
import crypto from "crypto";
import { getCurrentUser } from "@/lib/auth";
import {
  createProject,
  listUserProjects,
} from "@/lib/db";
import { projectPayloadSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = listUserProjects(claims.sub);
  const projects = rows.map((r) => ({
    id: r.id,
    name: r.name,
    savedAt: new Date(r.updated_at * 1000).toISOString(),
    ...JSON.parse(r.data),
  }));

  return Response.json({ projects });
}

export async function POST(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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

  const id = crypto.randomUUID();
  const { name, data } = parsed.data;
  createProject(id, claims.sub, name, JSON.stringify(data));

  return Response.json(
    {
      project: {
        id,
        name,
        savedAt: new Date().toISOString(),
        ...data,
      },
    },
    { status: 201 }
  );
}

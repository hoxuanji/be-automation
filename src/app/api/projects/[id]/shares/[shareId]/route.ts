import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { deleteProjectShare } from "@/lib/db";
import { getProjectAccess, canManage } from "@/lib/permissions";

export const runtime = "nodejs";

// DELETE /api/projects/[id]/shares/[shareId] — revoke a share (owner-only)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; shareId: string }> }
) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id: projectId, shareId } = await params;
  const access = getProjectAccess(projectId, claims.sub);
  if (!canManage(access)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  deleteProjectShare(shareId, projectId);
  return Response.json({ ok: true });
}

import { countAllProjects } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  let dbOk = false;
  try {
    countAllProjects();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const isPersisted = !!(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? process.env.RENDER_DISK_NAME ?? process.env.FLY_VOLUME_MOUNTS);

  return Response.json({
    status: dbOk ? "ok" : "degraded",
    db: dbOk ? "ok" : "error",
    storage: isPersisted ? "persistent" : "ephemeral",
    timestamp: new Date().toISOString(),
  }, { status: dbOk ? 200 : 503 });
}

import { countAllProjects } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const projectCount = countAllProjects();
  return Response.json({ projectCount });
}

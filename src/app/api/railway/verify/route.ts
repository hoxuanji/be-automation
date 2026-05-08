import { type NextRequest } from "next/server";
import { verifyRailwayToken } from "@/lib/railway";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { token } = body as { token?: string };
  if (!token || typeof token !== "string" || !token.trim()) {
    return Response.json({ error: "token required" }, { status: 400 });
  }

  try {
    const user = await verifyRailwayToken(token.trim());
    return Response.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    return Response.json({ error: msg }, { status: 401 });
  }
}

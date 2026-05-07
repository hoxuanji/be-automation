import { buildClearCookieHeader } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": buildClearCookieHeader() } }
  );
}

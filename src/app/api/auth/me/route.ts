import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { findUserById } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) {
    return Response.json({ user: null }, { status: 200 });
  }

  const user = findUserById(claims.sub);
  if (!user) {
    return Response.json({ user: null }, { status: 200 });
  }

  return Response.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasApiKey: !!user.llm_api_key_enc,
    },
  });
}

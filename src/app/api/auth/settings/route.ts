import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { updateUserProfile, updateUserApiKey, encryptApiKey, findUserById } from "@/lib/db";
import { updateSettingsSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
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

  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Helios is SSO-only — passwords are no longer accepted on this endpoint.
  // Display name and email remain editable so users can fix typos that
  // came in from GitHub/Bitbucket profile data.
  const { name, email, apiKey } = parsed.data;

  const profileUpdates: { name?: string; email?: string } = {};
  if (name) profileUpdates.name = name;
  if (email) profileUpdates.email = email.toLowerCase();

  if (Object.keys(profileUpdates).length > 0) {
    updateUserProfile(claims.sub, profileUpdates);
  }

  if (apiKey !== undefined) {
    updateUserApiKey(claims.sub, apiKey ? encryptApiKey(apiKey) : null);
  }

  const user = findUserById(claims.sub);
  return Response.json({
    user: {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      hasApiKey: !!user!.llm_api_key_enc,
    },
  });
}

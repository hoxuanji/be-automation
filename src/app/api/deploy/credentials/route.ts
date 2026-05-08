import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds, setDeployCreds } from "@/lib/db";

export const runtime = "nodejs";

function maskValue(v: string): string {
  return v.length > 8 ? `••••${v.slice(-4)}` : "••••";
}

// GET — return masked credentials for all providers
export async function GET(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const raw = getDeployCreds(claims.sub);
  const masked: Record<string, Record<string, string>> = {};
  for (const [provider, fields] of Object.entries(raw)) {
    masked[provider] = {};
    for (const [key, value] of Object.entries(fields)) {
      masked[provider][key] = maskValue(value);
    }
  }
  return Response.json({ creds: masked });
}

// POST — save (merge) credentials for a provider
export async function POST(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { provider, fields } = body as { provider?: string; fields?: Record<string, string> };
  if (!provider || typeof provider !== "string") {
    return Response.json({ error: "provider required" }, { status: 400 });
  }
  if (!fields || typeof fields !== "object") {
    return Response.json({ error: "fields required" }, { status: 400 });
  }

  const existing = getDeployCreds(claims.sub);
  setDeployCreds(claims.sub, { ...existing, [provider]: fields });
  return Response.json({ ok: true });
}

// DELETE — remove credentials for a provider
export async function DELETE(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider) return Response.json({ error: "provider required" }, { status: 400 });

  const existing = getDeployCreds(claims.sub);
  delete existing[provider];
  setDeployCreds(claims.sub, existing);
  return Response.json({ ok: true });
}

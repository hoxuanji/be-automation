import { type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds, setDeployCreds } from "@/lib/db";

export const runtime = "nodejs";

// Whitelist of providers and the exact field keys each accepts. This prevents
// clients from writing arbitrary keys into the encrypted credentials blob
// (which could be used to exfiltrate data via GET masking or to pollute
// future providers).
const PROVIDER_SCHEMAS = {
  railway: z.object({
    token: z.string().min(8).max(512),
  }),
  vercel: z.object({
    token: z.string().min(8).max(512),
  }),
  fly: z.object({
    token: z.string().min(8).max(512),
  }),
  render: z.object({
    token: z.string().min(8).max(512),
  }),
} as const;

type KnownProvider = keyof typeof PROVIDER_SCHEMAS;

const bodySchema = z.object({
  provider: z.enum(Object.keys(PROVIDER_SCHEMAS) as [KnownProvider, ...KnownProvider[]]),
  fields: z.record(z.string(), z.string()),
});

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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { provider, fields } = parsed.data;
  const fieldSchema = PROVIDER_SCHEMAS[provider];
  const fieldsParsed = fieldSchema.safeParse(fields);
  if (!fieldsParsed.success) {
    return Response.json(
      { error: "invalid_fields", issues: fieldsParsed.error.flatten() },
      { status: 400 }
    );
  }

  const existing = getDeployCreds(claims.sub);
  setDeployCreds(claims.sub, { ...existing, [provider]: fieldsParsed.data });
  return Response.json({ ok: true });
}

// DELETE — remove credentials for a provider
export async function DELETE(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  const provider = new URL(req.url).searchParams.get("provider");
  if (!provider || !(provider in PROVIDER_SCHEMAS)) {
    return Response.json({ error: "unknown_provider" }, { status: 400 });
  }

  const existing = getDeployCreds(claims.sub);
  delete existing[provider];
  setDeployCreds(claims.sub, existing);
  return Response.json({ ok: true });
}

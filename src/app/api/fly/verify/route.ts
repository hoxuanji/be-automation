import { type NextRequest } from "next/server";
import { listFlyOrgs, FlyError } from "@/lib/fly";

export const runtime = "nodejs";

// POST /api/fly/verify
// Body: { token: string }
// Returns the orgs the token can deploy into.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ code: "invalid_json", error: "Malformed request body." }, { status: 400 });
  }

  const { token } = body as { token?: string };
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) {
    return Response.json(
      { code: "token_required", error: "Token is required.", hint: "Paste your Fly Personal Access Token." },
      { status: 400 }
    );
  }

  try {
    const orgs = await listFlyOrgs(trimmed);
    if (orgs.length === 0) {
      return Response.json(
        {
          code: "no_org",
          error: "Token has no organization access.",
          hint: "Sign in at fly.io and re-issue the token.",
        },
        { status: 400 }
      );
    }
    const personal = orgs.find((o) => o.slug === "personal") ?? orgs[0];
    return Response.json({ orgSlug: personal.slug, name: personal.name, orgs });
  } catch (err) {
    if (err instanceof FlyError) {
      const status = err.code === "not_authorized" ? 401 : err.code === "network_error" ? 503 : 500;
      return Response.json(
        {
          code: err.code,
          error:
            err.code === "not_authorized"
              ? "Fly rejected this token."
              : err.code === "network_error"
              ? "Couldn't reach Fly."
              : "Verification failed.",
          hint: err.message,
        },
        { status }
      );
    }
    return Response.json(
      {
        code: "unexpected",
        error: "Verification failed.",
        hint: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      },
      { status: 500 }
    );
  }
}

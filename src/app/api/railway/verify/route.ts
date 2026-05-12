import { type NextRequest } from "next/server";
import { verifyRailwayToken } from "@/lib/railway";

export const runtime = "nodejs";

type VerifyErrorCode =
  | "invalid_json"
  | "token_required"
  | "not_authorized"
  | "network_error"
  | "unexpected";

function classify(err: unknown): { code: VerifyErrorCode; status: number; error: string; hint: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes("not authorized") || lower.includes("unauthorized") || lower.includes("problem processing")) {
    return {
      code: "not_authorized",
      status: 401,
      error: "Railway rejected this token.",
      hint: "Generate a Personal API Token from railway.app/account/tokens — Project and Team tokens can't authenticate. Also check for stray whitespace when pasting.",
    };
  }
  if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("enotfound") || lower.includes("econnrefused")) {
    return {
      code: "network_error",
      status: 503,
      error: "Couldn't reach Railway.",
      hint: "backboard.railway.app wasn't reachable. Retry in a moment, or check your network / proxy.",
    };
  }
  return {
    code: "unexpected",
    status: 500,
    error: "Verification failed.",
    hint: raw.slice(0, 200),
  };
}

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
      { code: "token_required", error: "Token is required.", hint: "Paste your Railway Personal API Token." },
      { status: 400 }
    );
  }

  try {
    const user = await verifyRailwayToken(trimmed);
    return Response.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    const classified = classify(err);
    return Response.json(
      { code: classified.code, error: classified.error, hint: classified.hint },
      { status: classified.status }
    );
  }
}

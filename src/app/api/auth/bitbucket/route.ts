import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { getJwtSecret } from "@/lib/env";

// Bitbucket OAuth 2 — auth code grant. Identical state-signing scheme as
// the GitHub route so we can reuse the same TTL/HMAC logic and force the
// callback to reject mismatched providers.
//
// State format: `bb:${nonce}:${mode}:${issuedAtSec}:${sig}`
//   prefix `bb` makes provider mix-ups (state from a github request hitting
//   the bitbucket callback) trip the parse and reject up front.
const STATE_TTL_SEC = 600;

function signState(payload: string): string {
  return crypto.createHmac("sha256", getJwtSecret()).update(payload).digest("hex").slice(0, 24);
}

const IS_PROD = process.env.NODE_ENV === "production";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") ?? "login"; // "login" | "connect"
  const nonce = crypto.randomBytes(16).toString("hex");
  const issued = Math.floor(Date.now() / 1000);
  const payload = `bb:${nonce}:${mode}:${issued}`;
  const sig = signState(payload);
  const stateValue = `${payload}:${sig}`;

  const clientId = process.env.BITBUCKET_CLIENT_ID;
  if (!clientId) {
    // The whole route fails closed when not configured — return a 500 with a
    // structured hint instead of redirecting the user to a broken Bitbucket page.
    return NextResponse.json(
      {
        error: "bitbucket_not_configured",
        hint: "Set BITBUCKET_CLIENT_ID + BITBUCKET_CLIENT_SECRET in the env, then restart.",
      },
      { status: 500 }
    );
  }

  // Bitbucket has no `repo` scope split — `repository` covers reads, `repository:write`
  // is needed for pushes. We ask for the full set so the same token can drive
  // the Push-to-Bitbucket flow when we add it later.
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    state: stateValue,
  });

  const response = NextResponse.redirect(
    `https://bitbucket.org/site/oauth2/authorize?${params.toString()}`
  );

  const returnTo = req.nextUrl.searchParams.get("returnTo");
  if (returnTo && returnTo.startsWith("/")) {
    response.cookies.set("bitbucket_return_to", returnTo, {
      httpOnly: true,
      path: "/",
      maxAge: STATE_TTL_SEC,
      sameSite: "lax",
      secure: IS_PROD,
    });
  }

  return response;
}

import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { getJwtSecret } from "@/lib/env";

// State format: `${nonce}:${mode}:${issuedAtSec}:${sig}`
//   nonce  — 16 random bytes of hex, prevents state reuse / replay
//   mode   — "login" or "connect"
//   issued — Unix seconds; the callback rejects anything older than STATE_TTL_SEC
//   sig    — first 24 hex chars of HMAC-SHA256 over `${nonce}:${mode}:${issued}`
const STATE_TTL_SEC = 600; // 10 min — plenty for a browser round-trip

function signState(payload: string): string {
  return crypto.createHmac("sha256", getJwtSecret()).update(payload).digest("hex").slice(0, 24);
}

const IS_PROD = process.env.NODE_ENV === "production";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") ?? "connect"; // "login" | "connect"
  const nonce = crypto.randomBytes(16).toString("hex");
  const issued = Math.floor(Date.now() / 1000);
  const payload = `${nonce}:${mode}:${issued}`;
  const sig = signState(payload);
  const stateValue = `${payload}:${sig}`;

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    scope: "repo,workflow,user:email",
    state: stateValue,
  });

  const response = NextResponse.redirect(
    `https://github.com/login/oauth/authorize?${params.toString()}`
  );

  const returnTo = req.nextUrl.searchParams.get("returnTo");
  if (returnTo && returnTo.startsWith("/")) {
    response.cookies.set("github_return_to", returnTo, {
      httpOnly: true,
      path: "/",
      maxAge: STATE_TTL_SEC,
      sameSite: "lax",
      secure: IS_PROD,
    });
  }

  return response;
}

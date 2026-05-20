import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { signToken } from "@/lib/auth";
import { upsertUserByBitbucket, createSession } from "@/lib/db";
import { getJwtSecret } from "@/lib/env";

export const runtime = "nodejs";

const STATE_TTL_SEC = 600; // must match the issuer in src/app/api/auth/bitbucket/route.ts
const IS_PROD = process.env.NODE_ENV === "production";

function verifyState(state: string): { mode: string } | null {
  // State format: `bb:${nonce}:${mode}:${issued}:${sig}` — see issuer for details.
  const parts = state.split(":");
  if (parts.length !== 5) return null;
  const [prefix, nonce, mode, issuedStr, sig] = parts;
  if (prefix !== "bb" || !nonce || !mode || !issuedStr || !sig) return null;
  const payload = `${prefix}:${nonce}:${mode}:${issuedStr}`;
  const expected = crypto
    .createHmac("sha256", getJwtSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 24);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - issued) > STATE_TTL_SEC) return null;
  return { mode };
}

async function getBitbucketToken(code: string): Promise<string | null> {
  // Bitbucket uses HTTP Basic auth on the token endpoint with form-encoded body.
  const basic = Buffer.from(
    `${process.env.BITBUCKET_CLIENT_ID}:${process.env.BITBUCKET_CLIENT_SECRET}`
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
  });
  const res = await fetch("https://bitbucket.org/site/oauth2/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (data.error) {
    console.error("[bitbucket/callback] token exchange error:", data.error, data.error_description);
  }
  return data.access_token ?? null;
}

async function getBitbucketUser(
  token: string
): Promise<{ uuid: string; nickname: string; display_name: string | null } | null> {
  const res = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getBitbucketPrimaryEmail(token: string): Promise<string | null> {
  // Bitbucket exposes a separate emails endpoint — same pattern as GitHub.
  // Returns 401 if the user denied email scope; we fall back to a synthesized
  // address keyed off the uuid so account creation can still complete.
  const res = await fetch("https://api.bitbucket.org/2.0/user/emails", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    values?: { email: string; is_primary: boolean; is_confirmed: boolean }[];
  };
  const primary = json.values?.find((e) => e.is_primary && e.is_confirmed);
  return primary?.email ?? json.values?.[0]?.email ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.redirect(new URL("/login?bitbucket=error", req.url));
    }

    const verified = verifyState(state);
    if (!verified) {
      console.error("[bitbucket/callback] invalid state signature");
      return NextResponse.redirect(new URL("/login?bitbucket=error", req.url));
    }

    const { mode } = verified;

    const bbToken = await getBitbucketToken(code);
    if (!bbToken) {
      console.error("[bitbucket/callback] token exchange returned no access_token, mode:", mode);
      const dest = mode === "login" ? "/login?bitbucket=error" : "/preview?bitbucket=error";
      return NextResponse.redirect(new URL(dest, req.url));
    }

    if (mode === "login") {
      const [bbUser, email] = await Promise.all([
        getBitbucketUser(bbToken),
        getBitbucketPrimaryEmail(bbToken),
      ]);

      if (!bbUser) {
        console.error("[bitbucket/callback] could not fetch Bitbucket user");
        return NextResponse.redirect(new URL("/login?bitbucket=error", req.url));
      }

      // Bitbucket uuids are wrapped in braces — strip them so storage and lookup
      // are stable across surfaces that do or don't preserve the braces.
      const cleanUuid = bbUser.uuid.replace(/[{}]/g, "");
      const resolvedEmail = email ?? `${bbUser.nickname || cleanUuid}@users.noreply.bitbucket.org`;
      const resolvedName = bbUser.display_name ?? bbUser.nickname ?? cleanUuid;

      const user = upsertUserByBitbucket(cleanUuid, resolvedEmail, resolvedName);
      const { token: jwtToken, jti, expiresAt } = await signToken({ sub: user.id, email: user.email, name: user.name });
      createSession(jti, user.id, expiresAt);

      const maxAge = 86400 * 7;
      const cookieOpts = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${IS_PROD ? "; Secure" : ""}`;
      const headers = new Headers({ "Content-Type": "text/html" });
      headers.append("Set-Cookie", `helios_token=${jwtToken}; ${cookieOpts}`);
      headers.append("Set-Cookie", `bitbucket_token=${bbToken}; ${cookieOpts}`);
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8">
        <script>window.location.replace("/dashboard")</script></head>
        <body>Signing in…</body></html>`,
        { status: 200, headers }
      );
    }

    // Connect mode — store the Bitbucket access token for future repo pushes.
    const returnTo = req.cookies.get("bitbucket_return_to")?.value;
    const dest = returnTo && returnTo.startsWith("/") ? returnTo : "/preview?bitbucket=connected";

    const maxAge = 86400 * 7;
    const cookieOpts = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${IS_PROD ? "; Secure" : ""}`;
    const headers = new Headers({ "Content-Type": "text/html" });
    headers.append("Set-Cookie", `bitbucket_token=${bbToken}; ${cookieOpts}`);
    headers.append("Set-Cookie", `bitbucket_return_to=; Path=/; Max-Age=0`);
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8">
      <script>window.location.replace(${JSON.stringify(dest)})</script></head>
      <body>Connecting…</body></html>`,
      { status: 200, headers }
    );
  } catch (err) {
    console.error("[bitbucket/callback] unexpected error:", err);
    return NextResponse.redirect(new URL("/login?bitbucket=error", req.url));
  }
}

import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { signToken } from "@/lib/auth";
import { upsertUserByGithub } from "@/lib/db";
import { getJwtSecret } from "@/lib/env";

export const runtime = "nodejs";

const STATE_TTL_SEC = 600; // must match the issuer in src/app/api/auth/github/route.ts
const IS_PROD = process.env.NODE_ENV === "production";

function verifyState(state: string): { mode: string } | null {
  // State format: `${nonce}:${mode}:${issued}:${sig}` — see issuer for details.
  // Older states had no `issued` segment; those are rejected outright so
  // a mix-and-match attacker can't replay a pre-timestamp state.
  const parts = state.split(":");
  if (parts.length !== 4) return null;
  const [nonce, mode, issuedStr, sig] = parts;
  if (!nonce || !mode || !issuedStr || !sig) return null;
  const payload = `${nonce}:${mode}:${issuedStr}`;
  const expected = crypto
    .createHmac("sha256", getJwtSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 24);
  // Constant-time compare to avoid signature timing leaks.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const issued = Number(issuedStr);
  if (!Number.isFinite(issued)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - issued) > STATE_TTL_SEC) return null;
  return { mode };
}

async function getGithubToken(code: string): Promise<string | null> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (data.error) {
    console.error("[github/callback] token exchange error:", data.error, data.error_description);
  }
  return data.access_token ?? null;
}

async function getGithubUser(token: string): Promise<{ id: number; login: string; name: string | null; email: string | null } | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Helios-App/1.0",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getGithubPrimaryEmail(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Helios-App/1.0",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return null;
  const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
  return emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");

    if (!code || !state) {
      return NextResponse.redirect(new URL("/login?github=error", req.url));
    }

    const verified = verifyState(state);
    if (!verified) {
      console.error("[github/callback] invalid state signature");
      return NextResponse.redirect(new URL("/login?github=error", req.url));
    }

    const { mode } = verified;

    const ghToken = await getGithubToken(code);
    if (!ghToken) {
      console.error("[github/callback] token exchange returned no access_token, mode:", mode);
      const dest = mode === "login" ? "/login?github=error" : "/preview?github=error";
      return NextResponse.redirect(new URL(dest, req.url));
    }

    // ── Login / signup via GitHub ──────────────────────────────────────────────
    if (mode === "login") {
      const [ghUser, email] = await Promise.all([
        getGithubUser(ghToken),
        getGithubPrimaryEmail(ghToken),
      ]);

      if (!ghUser) {
        console.error("[github/callback] could not fetch GitHub user");
        return NextResponse.redirect(new URL("/login?github=error", req.url));
      }

      const resolvedEmail = email ?? `${ghUser.login}@users.noreply.github.com`;
      const resolvedName = ghUser.name ?? ghUser.login;

      const user = upsertUserByGithub(String(ghUser.id), resolvedEmail, resolvedName);
      const jwtToken = await signToken({ sub: user.id, email: user.email, name: user.name });

      const maxAge = 86400 * 7;
      const cookieOpts = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${IS_PROD ? "; Secure" : ""}`;
      const headers = new Headers({ "Content-Type": "text/html" });
      headers.append("Set-Cookie", `helios_token=${jwtToken}; ${cookieOpts}`);
      headers.append("Set-Cookie", `github_token=${ghToken}; ${cookieOpts}`);
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8">
        <script>window.location.replace("/dashboard")</script></head>
        <body>Signing in…</body></html>`,
        { status: 200, headers }
      );
    }

    // ── Connect GitHub for push (existing flow) ────────────────────────────────
    const returnTo = req.cookies.get("github_return_to")?.value;
    const dest = returnTo && returnTo.startsWith("/") ? returnTo : "/preview?github=connected";

    const maxAge = 86400 * 7;
    const cookieOpts = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${IS_PROD ? "; Secure" : ""}`;
    const headers = new Headers({ "Content-Type": "text/html" });
    headers.append("Set-Cookie", `github_token=${ghToken}; ${cookieOpts}`);
    headers.append("Set-Cookie", `github_return_to=; Path=/; Max-Age=0`);
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8">
      <script>window.location.replace(${JSON.stringify(dest)})</script></head>
      <body>Connecting…</body></html>`,
      { status: 200, headers }
    );
  } catch (err) {
    console.error("[github/callback] unexpected error:", err);
    return NextResponse.redirect(new URL("/login?github=error", req.url));
  }
}

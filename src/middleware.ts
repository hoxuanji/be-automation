import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/env";

const COOKIE_NAME = "helios_token";
let _jwtSecret: Uint8Array | null = null;
function jwtSecret(): Uint8Array {
  if (!_jwtSecret) _jwtSecret = new TextEncoder().encode(getJwtSecret());
  return _jwtSecret;
}

const PROTECTED = ["/dashboard", "/builder", "/api-builder", "/preview", "/deploy", "/settings", "/git-settings", "/editor", "/templates", "/gallery", "/from-repo"];
const AUTH_ONLY = ["/login", "/signup"];

function matchesAny(path: string, prefixes: string[]) {
  return prefixes.some((p) => path === p || path.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(COOKIE_NAME)?.value;

  let authenticated = false;
  if (token) {
    try {
      await jwtVerify(token, jwtSecret());
      authenticated = true;
    } catch {}
  }

  if (matchesAny(pathname, PROTECTED) && !authenticated) {
    const returnTo = encodeURIComponent(pathname);
    return NextResponse.redirect(new URL(`/login?returnTo=${returnTo}`, req.url));
  }

  if (matchesAny(pathname, AUTH_ONLY) && authenticated) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "helios_token";
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "helios-dev-secret-change-in-production"
);

const PROTECTED = ["/dashboard", "/builder", "/api-builder", "/preview", "/deploy", "/settings"];
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
      await jwtVerify(token, JWT_SECRET);
      authenticated = true;
    } catch {}
  }

  if (matchesAny(pathname, PROTECTED) && !authenticated) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  if (matchesAny(pathname, AUTH_ONLY) && authenticated) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";

const COOKIE_NAME = "helios_token";
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "helios-dev-secret-change-in-production"
);

// ─── Password ────────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── JWT ─────────────────────────────────────────────────────────────────────

export type JWTPayload = {
  sub: string;
  email: string;
  name: string;
};

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ email: payload.email, name: payload.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
    };
  } catch {
    return null;
  }
}

// ─── Request helpers ─────────────────────────────────────────────────────────

export function getTokenFromRequest(req: NextRequest): string | null {
  return (
    req.cookies.get(COOKIE_NAME)?.value ??
    req.headers.get("Authorization")?.replace("Bearer ", "") ??
    null
  );
}

export async function getCurrentUser(
  req: NextRequest
): Promise<JWTPayload | null> {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  return verifyToken(token);
}

// ─── Cookie helpers ──────────────────────────────────────────────────────────

const IS_PROD = process.env.NODE_ENV === "production";

export function buildSetCookieHeader(token: string): string {
  const maxAge = 60 * 60 * 24 * 7; // 7 days
  return [
    `${COOKIE_NAME}=${token}`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    IS_PROD ? `Secure` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

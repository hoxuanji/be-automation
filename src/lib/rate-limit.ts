import { checkRateLimitDb } from "./db";

export function checkRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  return checkRateLimitDb(key, limit, windowMs);
}

// The first X-Forwarded-For entry is client-controlled; prefer x-real-ip, else
// the last entry (appended by the nearest proxy).
// ponytail: assumes exactly one trusted proxy hop; make the hop count configurable if deployed behind more.
export function getRateLimitKey(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const last = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last || "anon";
}

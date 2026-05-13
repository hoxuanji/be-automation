import { checkRateLimitDb } from "./db";

export function checkRateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  return checkRateLimitDb(key, limit, windowMs);
}

export function getRateLimitKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() ?? "anon";
}

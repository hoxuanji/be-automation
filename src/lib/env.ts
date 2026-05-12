// Centralized environment validation. Import `requireProdSecret()` whenever
// you need a secret — in production it throws if the value is missing or
// matches the well-known dev fallback. In development we still allow the
// dev fallback so local onboarding works, but we log the choice once.

const DEV_JWT_FALLBACK = "helios-dev-secret-change-in-production";
const DEV_ENC_FALLBACK = "helios-dev-enc-key-change-in-production";

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

let loggedDevFallback = new Set<string>();

function logDevFallback(name: string) {
  if (loggedDevFallback.has(name)) return;
  loggedDevFallback.add(name);
  console.warn(
    `[Helios] ${name} is not set — using an insecure dev fallback. This will REFUSE to start in production.`
  );
}

/**
 * Returns the JWT signing secret. In production, throws if the env var is
 * unset or matches the documented dev fallback. In development, allows the
 * fallback but logs a warning once per process.
 */
export function getJwtSecret(): string {
  const v = process.env.JWT_SECRET;
  if (isProd()) {
    if (!v || v === DEV_JWT_FALLBACK) {
      throw new Error(
        "JWT_SECRET is required in production and must not use the dev fallback. " +
          "Set a high-entropy value (`openssl rand -hex 32`) in your environment."
      );
    }
    return v;
  }
  if (!v) {
    logDevFallback("JWT_SECRET");
    return DEV_JWT_FALLBACK;
  }
  return v;
}

/**
 * Returns the AES-256 key used to encrypt credentials at rest.
 * Same fail-hard-in-prod semantics as `getJwtSecret`.
 */
export function getEncryptionKey(): string {
  const v = process.env.ENCRYPTION_KEY;
  if (isProd()) {
    if (!v || v === DEV_ENC_FALLBACK) {
      throw new Error(
        "ENCRYPTION_KEY is required in production and must not use the dev fallback. " +
          "Set a high-entropy value (`openssl rand -hex 32`) in your environment."
      );
    }
    return v;
  }
  if (!v) {
    logDevFallback("ENCRYPTION_KEY");
    return DEV_ENC_FALLBACK;
  }
  return v;
}

/**
 * One-shot audit for production startup. Prints / throws a summary of any
 * missing-or-unsafe env vars. Call from the first code path that touches the
 * DB so it runs reliably without needing a dedicated init step.
 */
let auditRan = false;
export function assertProdSecretsReady(): void {
  if (auditRan) return;
  auditRan = true;
  if (!isProd()) return;

  const errors: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_FALLBACK) {
    errors.push("JWT_SECRET is missing or uses the dev fallback.");
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === DEV_ENC_FALLBACK) {
    errors.push("ENCRYPTION_KEY is missing or uses the dev fallback.");
  }
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    // OAuth being misconfigured is not memory-safety-critical but it's a user-visible
    // failure. Log loudly but don't throw — the app should still boot for endpoints
    // that don't need GitHub (e.g. health checks).
    console.error("[Helios] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set — GitHub OAuth will fail.");
  }
  if (errors.length > 0) {
    throw new Error(
      "Helios refused to start: insecure configuration detected.\n  - " + errors.join("\n  - ")
    );
  }
}

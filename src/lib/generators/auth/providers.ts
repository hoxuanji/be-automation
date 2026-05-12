import type { StackConfig } from "../types";

// Authoritative list of auth providers Helios knows how to wire up. Kept in
// sync with `authProviders` in src/data/stack-options.ts — the id values
// must match exactly. Each entry describes:
//
//   - `envVars`:       env variable names the user fills in (surfaced in
//                       .env.example and the README's env-var table).
//   - `issuerEnv`:     env var that holds the JWT `iss` claim expected value.
//                       Generated middleware validates the token's iss against
//                       this at request time.
//   - `jwksUrlEnv`:    env var holding the JWKS URL (RS256/ES256 public-key
//                       discovery endpoint). All six supported providers publish
//                       one; Supabase's legacy HMAC-only mode is not wired up.
//   - `audienceEnv`:   env var holding the expected `aud` claim (optional —
//                       some providers issue tokens without audience).
//   - `jwksUrlExample` + `issuerExample`: human-readable examples dropped into
//                       .env.example so users know what shape to supply.
//   - `notes`:         a short blurb rendered into the README's auth section.

export type AuthProviderId =
  | "clerk"
  | "auth0"
  | "supabase-auth"
  | "cognito"
  | "firebase"
  | "keycloak";

export type AuthProviderSpec = {
  id: AuthProviderId;
  label: string;
  envVars: string[];
  issuerEnv: string;
  jwksUrlEnv: string;
  audienceEnv?: string;
  jwksUrlExample: string;
  issuerExample: string;
  notes: string;
};

export const AUTH_PROVIDERS: Record<AuthProviderId, AuthProviderSpec> = {
  clerk: {
    id: "clerk",
    label: "Clerk",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    audienceEnv: "AUTH_AUDIENCE",
    jwksUrlExample: "https://your-instance.clerk.accounts.dev/.well-known/jwks.json",
    issuerExample: "https://your-instance.clerk.accounts.dev",
    notes:
      "Clerk issues RS256 JWTs. Find your instance's issuer and JWKS URL at dashboard.clerk.com → API Keys. `AUTH_AUDIENCE` is your Clerk application id (not required by Clerk but still validated when set).",
  },
  auth0: {
    id: "auth0",
    label: "Auth0",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    audienceEnv: "AUTH_AUDIENCE",
    jwksUrlExample: "https://your-tenant.auth0.com/.well-known/jwks.json",
    issuerExample: "https://your-tenant.auth0.com/",
    notes:
      "Auth0 issues RS256 JWTs. `AUTH_AUDIENCE` is the API Identifier from your Auth0 API definition. Make sure your Auth0 API `RS256` signing is enabled (the default).",
  },
  "supabase-auth": {
    id: "supabase-auth",
    label: "Supabase Auth",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    jwksUrlExample: "https://your-project-ref.supabase.co/auth/v1/.well-known/jwks.json",
    issuerExample: "https://your-project-ref.supabase.co/auth/v1",
    notes:
      "Supabase Auth now publishes a JWKS endpoint for asymmetric keys. If your project still uses the legacy HMAC secret, set `AUTH_HMAC_SECRET` instead and the middleware will fall back to `HS256` verification.",
  },
  cognito: {
    id: "cognito",
    label: "AWS Cognito",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    audienceEnv: "AUTH_AUDIENCE",
    jwksUrlExample:
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX/.well-known/jwks.json",
    issuerExample:
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX",
    notes:
      "`AUTH_AUDIENCE` is your Cognito App Client id (the `aud` claim for ID tokens or `client_id` for access tokens).",
  },
  firebase: {
    id: "firebase",
    label: "Firebase Auth",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    audienceEnv: "AUTH_AUDIENCE",
    jwksUrlExample:
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    issuerExample: "https://securetoken.google.com/your-firebase-project-id",
    notes:
      "`AUTH_AUDIENCE` is your Firebase project id. Firebase rotates signing keys roughly every day — the JWKS cache should honor the `Cache-Control` header.",
  },
  keycloak: {
    id: "keycloak",
    label: "Keycloak",
    envVars: ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_AUDIENCE"],
    issuerEnv: "AUTH_ISSUER",
    jwksUrlEnv: "AUTH_JWKS_URL",
    audienceEnv: "AUTH_AUDIENCE",
    jwksUrlExample:
      "https://your-keycloak-host/realms/your-realm/protocol/openid-connect/certs",
    issuerExample: "https://your-keycloak-host/realms/your-realm",
    notes:
      "`AUTH_AUDIENCE` is your Keycloak client id. Keycloak's discovery doc lives at `{issuer}/.well-known/openid-configuration` if you'd rather read these values from there at boot.",
  },
};

export function authProviderSpec(config: StackConfig): AuthProviderSpec | null {
  return (AUTH_PROVIDERS as Record<string, AuthProviderSpec>)[config.auth] ?? null;
}

/**
 * Whether any endpoint is marked `auth: true` — used to decide if we should
 * even emit auth middleware + wire it into the app. No auth-required endpoints
 * and no entities? Skip everything and keep the generated zip smaller.
 */
export function needsAuth(config: StackConfig, anyProtected: boolean): boolean {
  return anyProtected && authProviderSpec(config) !== null;
}

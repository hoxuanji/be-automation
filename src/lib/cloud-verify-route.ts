// Shared POST handler for /api/{aws,gcp,azure,k8s}/verify: auth → rate limit →
// Zod-validate the credential fields → run the probe from cloud-verify.ts.

import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { CloudVerifyError } from "@/lib/cloud-verify";
import { CLOUD_CRED_SCHEMAS, CLOUD_META, type CloudCreds, type CloudProvider } from "@/lib/cloud-providers";

/** POST handler for /api/<cloud>/verify. Body: the provider's credential fields. */
export function cloudVerifyRoute<P extends CloudProvider>(
  provider: P,
  verify: (creds: CloudCreds<P>) => Promise<Record<string, unknown>>
) {
  return async function POST(req: NextRequest): Promise<Response> {
    const claims = await getCurrentUser(req);
    if (!claims) return Response.json({ code: "unauthorized", error: "Sign in required." }, { status: 401 });
    if (!checkRateLimit(`verify:${provider}:${claims.sub}`, 10)) {
      return Response.json({ code: "rate_limited", error: "Too many verification attempts.", hint: "Wait a minute and retry." }, { status: 429 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ code: "invalid_json", error: "Malformed request body." }, { status: 400 });
    }
    const parsed = CLOUD_CRED_SCHEMAS[provider].safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Response.json(
        {
          code: "invalid_fields",
          error: `${CLOUD_META[provider].label} credentials are incomplete.`,
          hint: first ? `${first.path.join(".") || "field"}: ${first.message}` : undefined,
        },
        { status: 400 }
      );
    }
    try {
      return Response.json(await verify(parsed.data as CloudCreds<P>));
    } catch (err) {
      if (err instanceof CloudVerifyError) {
        return Response.json({ code: err.code, error: err.message, hint: err.hint }, { status: err.status });
      }
      console.error(`[${provider}/verify] unexpected error:`, err instanceof Error ? err.name : typeof err);
      return Response.json({ code: "unexpected", error: "Verification failed.", hint: "Retry in a minute." }, { status: 500 });
    }
  };
}

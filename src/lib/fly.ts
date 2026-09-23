// Minimal Fly.io API client. Two API surfaces are at play:
//
// 1. **REST**       at https://api.machines.dev/v1 — the modern Machines API
//    used for app create/list, secrets, machine ops.
// 2. **GraphQL**    at https://api.fly.io/graphql — older surface, still
//    canonical for org listing + a few admin operations.
//
// We use REST for everything we can. The Fly auth token is a "Personal API
// Token" from fly.io/user/personal_access_tokens; same token works on both
// surfaces.
//
// Note on scope: Fly's git-driven deploy isn't a single API call — the
// canonical flow runs `flyctl deploy` from CI/CD. Helios provisions the app
// + secrets via the API, then surfaces a one-line `flyctl deploy` instruction
// (or a GitHub Action workflow we already emit in the generated repo's
// .github/workflows). The pipeline thus marks the deploy as "provisioned,
// build pending" rather than "live", and the deploy result includes a
// `nextStep` hint.

const FLY_REST = "https://api.machines.dev/v1";
const FLY_GQL = "https://api.fly.io/graphql";

export type FlyErrorCode =
  | "not_authorized"
  | "rate_limited"
  | "validation"
  | "network_error"
  | "server_error"
  | "conflict"
  | "unknown";

export class FlyError extends Error {
  code: FlyErrorCode;
  httpStatus: number;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(opts: {
    code: FlyErrorCode;
    httpStatus: number;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(opts.message);
    this.name = "FlyError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function classifyFly(status: number, message: string): FlyError {
  const lower = message.toLowerCase();
  if (status === 401 || status === 403) {
    return new FlyError({
      code: "not_authorized",
      httpStatus: 401,
      message:
        "Fly rejected the API token. Generate a Personal Access Token from fly.io/user/personal_access_tokens.",
      retryable: false,
    });
  }
  if (status === 409 || lower.includes("name has already been taken") || lower.includes("already exists")) {
    return new FlyError({
      code: "conflict",
      httpStatus: 409,
      message: message || "Fly app name is already taken.",
      retryable: false,
    });
  }
  if (status === 429) {
    return new FlyError({
      code: "rate_limited",
      httpStatus: 429,
      message: "Rate limited by Fly. Retrying shortly.",
      retryable: true,
      retryAfterMs: 5000,
    });
  }
  if (status >= 500) {
    return new FlyError({
      code: "server_error",
      httpStatus: 502,
      message: `Fly API returned ${status}. Retrying.`,
      retryable: true,
    });
  }
  if (status === 400 || status === 422 || lower.includes("invalid") || lower.includes("required")) {
    return new FlyError({
      code: "validation",
      httpStatus: 400,
      message: message || "Fly rejected the request as invalid.",
      retryable: false,
    });
  }
  return new FlyError({
    code: "unknown",
    httpStatus: status || 502,
    message: message || "Fly API call failed.",
    retryable: false,
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function flyFetch<T>(
  token: string,
  baseUrl: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const maxAttempts = 3;
  let lastErr: FlyError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 204) return undefined as unknown as T;
      const text = await res.text().catch(() => "");
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // not JSON
      }
      if (!res.ok) {
        const message =
          (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string")
            ? String((parsed as { error: string }).error)
            : text.slice(0, 400);
        const err = classifyFly(res.status, message);
        if (!err.retryable || attempt === maxAttempts) throw err;
        lastErr = err;
        await sleep(err.retryAfterMs ?? 1500 * attempt);
        continue;
      }
      return (parsed ?? {}) as T;
    } catch (err) {
      if (err instanceof FlyError) {
        if (!err.retryable || attempt === maxAttempts) throw err;
        lastErr = err;
        await sleep(err.retryAfterMs ?? 1500 * attempt);
        continue;
      }
      lastErr = new FlyError({
        code: "network_error",
        httpStatus: 503,
        message:
          err instanceof Error
            ? `Couldn't reach Fly: ${err.message}`
            : "Couldn't reach Fly.",
        retryable: true,
      });
      if (attempt === maxAttempts) throw lastErr;
      await sleep(1500 * attempt);
    }
  }
  throw lastErr ?? new FlyError({
    code: "unknown",
    httpStatus: 502,
    message: "Fly API call failed after retries.",
    retryable: false,
  });
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export type FlyOrg = { id: string; slug: string; name: string };

/**
 * Lists organizations the token can deploy into. The "personal" org is
 * always present. Used by /verify and to pick a default org for createApp.
 */
export async function listFlyOrgs(token: string): Promise<FlyOrg[]> {
  // GraphQL has the cleanest org list shape; REST machines API doesn't expose
  // org membership directly.
  const query = `query { viewer { id email organizations { nodes { id slug name } } } }`;
  const res = await fetch(FLY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyFly(res.status, text.slice(0, 400));
  }
  const json = (await res.json()) as {
    data?: { viewer?: { organizations?: { nodes?: FlyOrg[] } } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw classifyFly(401, json.errors[0].message);
  }
  return json.data?.viewer?.organizations?.nodes ?? [];
}

export type FlyApp = {
  id?: string;
  name: string;
  organization?: { slug: string };
};

/**
 * Creates a Fly app. The app is empty until `flyctl deploy` is run from a
 * checkout that contains the Dockerfile + fly.toml.
 */
export async function createFlyApp(
  token: string,
  appName: string,
  orgSlug: string
): Promise<FlyApp> {
  await flyFetch<unknown>(token, FLY_REST, "POST", "/apps", {
    app_name: appName,
    org_slug: orgSlug,
  });
  return { name: appName, organization: { slug: orgSlug } };
}

/**
 * Sets app-level secrets. These are exposed as env vars to the running app.
 * Setting an empty map is a no-op (Fly rejects empty payloads).
 */
export async function setFlySecrets(
  token: string,
  appName: string,
  secrets: Record<string, string>
): Promise<void> {
  if (Object.keys(secrets).length === 0) return;
  // Machines API exposes secrets via /apps/{name}/secrets — Fly accepts a
  // batch upsert. We map our flat env-var dict to the array shape they want.
  const items = Object.entries(secrets).map(([label, value]) => ({
    label,
    type: "raw_value",
    value,
  }));
  await flyFetch(token, FLY_REST, "POST", `/apps/${appName}/secrets`, items);
}

export function flyDashboardUrl(appName: string): string {
  return `https://fly.io/apps/${appName}`;
}

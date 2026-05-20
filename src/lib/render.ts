// Minimal Render API client — auth, retry/backoff for transient errors,
// typed error class. We only call the endpoints we need for the deploy
// pipeline (createService) and a credential probe (listOwners).
//
// Render's REST API is at https://api.render.com/v1. Auth is `Authorization:
// Bearer <token>` where the token is a "Personal API Key" from
// render.com/u/settings#api-keys. Render's git-driven services auto-deploy
// on push when `autoDeploy: "yes"` is set, so the pipeline doesn't need to
// trigger a deploy explicitly — creating the service kicks off the first
// build.

const RENDER_API = "https://api.render.com/v1";

export type RenderErrorCode =
  | "not_authorized"
  | "rate_limited"
  | "validation"
  | "network_error"
  | "server_error"
  | "conflict"
  | "unknown";

export class RenderError extends Error {
  code: RenderErrorCode;
  httpStatus: number;
  retryable: boolean;
  retryAfterMs?: number;

  constructor(opts: {
    code: RenderErrorCode;
    httpStatus: number;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(opts.message);
    this.name = "RenderError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

function classifyRender(status: number, message: string): RenderError {
  const lower = message.toLowerCase();
  if (status === 401 || status === 403) {
    return new RenderError({
      code: "not_authorized",
      httpStatus: 401,
      message:
        "Render rejected the API key. Ensure it's a Personal API Key from render.com/u/settings#api-keys with deploy permissions.",
      retryable: false,
    });
  }
  if (status === 409) {
    return new RenderError({
      code: "conflict",
      httpStatus: 409,
      message: message || "A Render resource with this name already exists.",
      retryable: false,
    });
  }
  if (status === 429) {
    return new RenderError({
      code: "rate_limited",
      httpStatus: 429,
      message: "Rate limited by Render. Retrying shortly.",
      retryable: true,
      retryAfterMs: 5000,
    });
  }
  if (status >= 500) {
    return new RenderError({
      code: "server_error",
      httpStatus: 502,
      message: `Render API returned ${status}. Retrying.`,
      retryable: true,
    });
  }
  if (status === 400 || lower.includes("invalid") || lower.includes("required")) {
    return new RenderError({
      code: "validation",
      httpStatus: 400,
      message: message || "Render rejected the request as invalid.",
      retryable: false,
    });
  }
  return new RenderError({
    code: "unknown",
    httpStatus: status || 502,
    message: message || "Render API call failed.",
    retryable: false,
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function renderFetch<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const maxAttempts = 3;
  let lastErr: RenderError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${RENDER_API}${path}`, {
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
        // body wasn't JSON — keep raw text for the error message
      }
      if (!res.ok) {
        const message =
          (parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message: unknown }).message === "string")
            ? String((parsed as { message: string }).message)
            : text.slice(0, 400);
        const err = classifyRender(res.status, message);
        if (!err.retryable || attempt === maxAttempts) throw err;
        lastErr = err;
        await sleep(err.retryAfterMs ?? 1500 * attempt);
        continue;
      }
      return (parsed ?? {}) as T;
    } catch (err) {
      if (err instanceof RenderError) {
        if (!err.retryable || attempt === maxAttempts) throw err;
        lastErr = err;
        await sleep(err.retryAfterMs ?? 1500 * attempt);
        continue;
      }
      // Network-level failure (fetch threw) — classify as transient and retry.
      lastErr = new RenderError({
        code: "network_error",
        httpStatus: 503,
        message:
          err instanceof Error
            ? `Couldn't reach Render: ${err.message}`
            : "Couldn't reach Render.",
        retryable: true,
      });
      if (attempt === maxAttempts) throw lastErr;
      await sleep(1500 * attempt);
    }
  }
  throw lastErr ?? new RenderError({
    code: "unknown",
    httpStatus: 502,
    message: "Render API call failed after retries.",
    retryable: false,
  });
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export type RenderOwner = {
  id: string;
  name: string;
  email?: string;
  type: "user" | "team";
};

/**
 * Lists owners (user + teams) the API key has access to. Used by /verify to
 * confirm the token is live and to pick a default owner for createService
 * when the caller doesn't specify one.
 */
export async function listRenderOwners(token: string): Promise<RenderOwner[]> {
  const res = await renderFetch<Array<{ owner: RenderOwner }>>(
    token,
    "GET",
    "/owners?limit=20"
  );
  return res.map((r) => r.owner);
}

export type CreateServiceParams = {
  ownerId: string;
  name: string;
  repo: string; // https://github.com/<owner>/<repo>
  branch?: string;
  // Service shape — Helios always provisions a `web_service` since gRPC/
  // worker variants need different Render product types we don't support yet.
  env: "node" | "python" | "go" | "rust" | "docker";
  buildCommand?: string;
  startCommand?: string;
  region?: string; // oregon | frankfurt | singapore | ohio (default: oregon)
  plan?: "starter" | "standard" | "pro";
  envVars?: Record<string, string>;
  isPrivate?: boolean;
};

export type RenderService = {
  id: string;
  name: string;
  serviceDetails?: { url?: string };
  // Render also returns { dashboardUrl } in some shapes; we synthesize from id.
};

/**
 * Creates a Render web service from a public/private GitHub repo. The first
 * build is auto-triggered after creation when autoDeploy is "yes".
 */
export async function createRenderService(
  token: string,
  p: CreateServiceParams
): Promise<RenderService> {
  // Render's REST contract: serviceDetails wraps env-specific details; envVars
  // is a flat array at the top level. The minimal shape that yields a working
  // service is below — additional fields (healthCheckPath, autoscaling) can be
  // patched in by the user after the initial deploy.
  const envVarPairs = Object.entries(p.envVars ?? {}).map(([key, value]) => ({
    key,
    value,
  }));

  const body: Record<string, unknown> = {
    type: "web_service",
    name: p.name,
    ownerId: p.ownerId,
    repo: p.repo,
    branch: p.branch ?? "main",
    autoDeploy: "yes",
    serviceDetails: {
      env: p.env,
      region: p.region ?? "oregon",
      plan: p.plan ?? "starter",
      envSpecificDetails: {
        ...(p.buildCommand ? { buildCommand: p.buildCommand } : {}),
        ...(p.startCommand ? { startCommand: p.startCommand } : {}),
      },
    },
    ...(envVarPairs.length > 0 ? { envVars: envVarPairs } : {}),
  };

  const created = await renderFetch<{ service?: RenderService } | RenderService>(
    token,
    "POST",
    "/services",
    body
  );
  // Render's response can be {service: {...}} or the service directly across versions.
  return (
    (created as { service?: RenderService }).service ??
    (created as RenderService)
  );
}

/**
 * Returns the dashboard URL for a service id. Synthesized — Render's API
 * doesn't return a stable dashboard URL field.
 */
export function renderDashboardUrl(serviceId: string): string {
  return `https://dashboard.render.com/web/${serviceId}`;
}

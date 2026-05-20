// Shared error + event types for the push → deploy pipeline.
// These are returned to the client verbatim, so keep the shape stable.

export type DeployProvider = "railway" | "render" | "fly" | "vercel";

export type PipelineErrorCode =
  // GitHub
  | "token_invalid"
  | "insufficient_scope"
  | "rate_limited"
  | "network_error"
  | "repo_create_failed"
  | "commit_failed"
  // Railway
  | "railway_not_authorized"
  | "railway_rate_limited"
  | "railway_validation"
  | "railway_network"
  | "railway_env_not_found"
  | "railway_error"
  // Render
  | "render_not_authorized"
  | "render_rate_limited"
  | "render_validation"
  | "render_network"
  | "render_conflict"
  | "render_no_owner"
  | "render_error"
  // Fly
  | "fly_not_authorized"
  | "fly_rate_limited"
  | "fly_validation"
  | "fly_network"
  | "fly_conflict"
  | "fly_no_org"
  | "fly_error"
  // Other
  | "invalid_request"
  | "unauthorized"
  | "railway_token_missing"
  | "render_token_missing"
  | "fly_token_missing"
  | "github_not_connected"
  // Vercel
  | "vercel_not_authorized"
  | "vercel_rate_limited"
  | "vercel_validation"
  | "vercel_network"
  | "vercel_conflict"
  | "vercel_no_github"
  | "vercel_error"
  | "vercel_token_missing";

export class PipelineError extends Error {
  code: PipelineErrorCode;
  status: number;
  hint: string;
  stage?: string;
  partial?: { projectId?: string; serviceId?: string; appName?: string };

  constructor(opts: {
    code: PipelineErrorCode;
    status: number;
    message: string;
    hint: string;
    stage?: string;
    partial?: { projectId?: string; serviceId?: string; appName?: string };
  }) {
    super(opts.message);
    this.name = "PipelineError";
    this.code = opts.code;
    this.status = opts.status;
    this.hint = opts.hint;
    this.stage = opts.stage;
    this.partial = opts.partial;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.partial ? { partial: this.partial } : {}),
    };
  }
}

// ─── Event stream types ──────────────────────────────────────────────────────

export type PipelineStage =
  | "generate"
  | "github_push"
  // Railway-specific stages
  | "railway_project"
  | "railway_env"
  | "railway_service"
  | "railway_variables"
  | "railway_domain"
  // Render-specific stages
  | "render_owner"
  | "render_service"
  // Fly-specific stages
  | "fly_org"
  | "fly_app"
  | "fly_secrets"
  | "fly_handoff"
  // Vercel-specific stages
  | "vercel_project"
  | "vercel_env"
  | "vercel_domain"
  | "done";

export type PipelineEvent =
  | { type: "stage"; stage: PipelineStage; message: string }
  | { type: "progress"; message: string; detail?: string }
  | { type: "warn"; message: string }
  | { type: "done"; result: DeployResult }
  | { type: "error"; error: ReturnType<PipelineError["toJSON"]> & { status: number } };

// One unified result shape across providers. Provider-specific fields are
// optional so the client can render whichever it has — Railway returns a
// projectId + serviceId, Render returns serviceId, Fly returns appName.
export type DeployResult = {
  provider: DeployProvider;
  projectUrl: string; // dashboard URL for the provisioned resource
  domain: string | null; // primary hostname when known
  fullName: string; // GitHub repo full name
  githubUrl: string;
  commitUrl?: string;
  fileCount: number;
  // Provider-specific identifiers — present on whichever provider applies.
  projectId?: string;
  serviceId?: string;
  appName?: string;
  // Optional next-step instruction (used by Fly when build is user-driven).
  nextStep?: { message: string; command?: string };
};

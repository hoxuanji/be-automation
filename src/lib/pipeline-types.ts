// Shared error + event types for the push → deploy pipeline.
// These are returned to the client verbatim, so keep the shape stable.

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
  // Other
  | "invalid_request"
  | "unauthorized"
  | "railway_token_missing"
  | "github_not_connected";

export class PipelineError extends Error {
  code: PipelineErrorCode;
  status: number;
  hint: string;
  stage?: string;
  partial?: { projectId?: string; serviceId?: string };

  constructor(opts: {
    code: PipelineErrorCode;
    status: number;
    message: string;
    hint: string;
    stage?: string;
    partial?: { projectId?: string; serviceId?: string };
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
  | "railway_project"
  | "railway_env"
  | "railway_service"
  | "railway_variables"
  | "railway_domain"
  | "done";

export type PipelineEvent =
  | { type: "stage"; stage: PipelineStage; message: string }
  | { type: "progress"; message: string; detail?: string }
  | { type: "warn"; message: string }
  | { type: "done"; result: DeployResult }
  | { type: "error"; error: ReturnType<PipelineError["toJSON"]> & { status: number } };

export type DeployResult = {
  projectUrl: string;
  projectId: string;
  serviceId: string;
  domain: string | null;
  fullName: string;
  githubUrl: string;
  commitUrl?: string;
  fileCount: number;
};

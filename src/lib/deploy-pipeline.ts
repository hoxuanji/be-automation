import { pushGeneratedRepo, type PushResult } from "@/lib/github-push";
import {
  getDefaultTeamId,
  createRailwayProject,
  getRailwayProject,
  createRailwayService,
  setRailwayVariables,
  createRailwayDomain,
  RailwayError,
} from "@/lib/railway";
import type { StackConfig, Endpoint, Entity } from "@/lib/generators/types";
import {
  PipelineError,
  type DeployResult,
  type PipelineEvent,
} from "./pipeline-types";

export type DeployParams = {
  githubToken: string;
  railwayToken: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  repoName: string;
  isPrivate?: boolean;
};

function classifyRailwayErr(
  err: unknown,
  stage: string,
  partial?: { projectId?: string; serviceId?: string }
): PipelineError {
  if (err instanceof RailwayError) {
    switch (err.code) {
      case "not_authorized":
        return new PipelineError({
          code: "railway_not_authorized",
          status: 401,
          message: "Railway rejected the saved token.",
          hint: "Go to Settings → Integrations → Railway and replace the token with a fresh Personal API Token.",
          stage,
          partial,
        });
      case "rate_limited":
        return new PipelineError({
          code: "railway_rate_limited",
          status: 429,
          message: "Railway rate-limited the request.",
          hint: "Wait a minute and retry.",
          stage,
          partial,
        });
      case "validation":
        return new PipelineError({
          code: "railway_validation",
          status: 400,
          message: "Railway rejected the request as invalid.",
          hint: err.message,
          stage,
          partial,
        });
      case "network_error":
        return new PipelineError({
          code: "railway_network",
          status: 503,
          message: "Couldn't reach Railway.",
          hint: "backboard.railway.app wasn't reachable. Check connectivity and retry.",
          stage,
          partial,
        });
      default:
        return new PipelineError({
          code: "railway_error",
          status: err.httpStatus,
          message: `Railway call failed during ${stage}.`,
          hint: err.message,
          stage,
          partial,
        });
    }
  }
  return new PipelineError({
    code: "railway_error",
    status: 502,
    message: `Unexpected error during ${stage}.`,
    hint: err instanceof Error ? err.message : String(err),
    stage,
    partial,
  });
}

/**
 * Runs the full push → Railway deploy pipeline, yielding progress events
 * along the way. Throws `PipelineError` on failure.
 *
 * Consumers:
 * - `/api/railway/deploy` drains the generator and returns the final `DeployResult` as JSON.
 * - `/api/deploy/stream` relays each event as an SSE frame for the UI.
 */
export async function* runDeployPipeline(
  params: DeployParams
): AsyncGenerator<PipelineEvent, DeployResult, void> {
  const { githubToken, railwayToken, config, endpoints, entities, repoName, isPrivate } = params;

  // ─── Stage 1: generate + push to GitHub ─────────────────────────────────────
  yield { type: "stage", stage: "generate", message: "Generating repository files" };

  let pushed: PushResult;
  try {
    yield { type: "stage", stage: "github_push", message: "Pushing code to GitHub" };
    pushed = await pushGeneratedRepo({
      token: githubToken,
      config,
      endpoints,
      entities,
      repoName,
      isPrivate,
    });
    yield {
      type: "progress",
      message: `Pushed ${pushed.fileCount} files to ${pushed.fullName}`,
      detail: pushed.url,
    };
  } catch (err) {
    if (err instanceof PipelineError) {
      err.stage = err.stage ?? "github_push";
      throw err;
    }
    throw new PipelineError({
      code: "commit_failed",
      status: 502,
      message: "GitHub push failed.",
      hint: err instanceof Error ? err.message : String(err),
      stage: "github_push",
    });
  }

  // ─── Stage 2: Railway provisioning ──────────────────────────────────────────
  let projectId: string | undefined;
  let serviceId: string | undefined;
  let envId: string | undefined;

  try {
    yield { type: "stage", stage: "railway_project", message: "Creating Railway project" };
    const teamId = await getDefaultTeamId(railwayToken);
    const project = await createRailwayProject(railwayToken, config.name, teamId);
    projectId = project.id;
    yield { type: "progress", message: `Project ready`, detail: `https://railway.app/project/${projectId}` };

    yield { type: "stage", stage: "railway_env", message: "Resolving production environment" };
    const projectData = await getRailwayProject(railwayToken, projectId);
    const env = projectData.environments.find((e) => e.name === "production") ?? projectData.environments[0];
    if (!env) {
      throw new PipelineError({
        code: "railway_env_not_found",
        status: 502,
        message: "Railway project has no environment.",
        hint: "Open the Railway dashboard and create a production environment, then retry.",
        stage: "railway_env",
        partial: { projectId },
      });
    }
    envId = env.id;

    yield { type: "stage", stage: "railway_service", message: "Linking GitHub repo as a service" };
    const service = await createRailwayService(railwayToken, projectId, config.name, pushed.fullName);
    serviceId = service.id;
    yield { type: "progress", message: `Service created`, detail: pushed.fullName };

    const vars: Record<string, string> = {};
    for (const v of config.envVars) {
      if (v.key && v.value && !v.value.includes("••")) {
        vars[v.key] = v.value;
      }
    }
    if (Object.keys(vars).length > 0) {
      yield { type: "stage", stage: "railway_variables", message: `Setting ${Object.keys(vars).length} environment variables` };
      await setRailwayVariables(railwayToken, projectId, serviceId, envId, vars);
    }

    // Domain creation is best-effort.
    yield { type: "stage", stage: "railway_domain", message: "Provisioning public domain" };
    let domain: string | null = null;
    try {
      const rawDomain = await createRailwayDomain(railwayToken, serviceId, envId);
      domain = `https://${rawDomain}`;
      yield { type: "progress", message: "Domain ready", detail: domain };
    } catch (domainErr) {
      yield {
        type: "warn",
        message: `Domain creation skipped: ${domainErr instanceof Error ? domainErr.message : String(domainErr)}. Create it manually from the Railway dashboard.`,
      };
    }

    const result: DeployResult = {
      projectUrl: `https://railway.app/project/${projectId}`,
      projectId,
      serviceId,
      domain,
      fullName: pushed.fullName,
      githubUrl: pushed.url,
      commitUrl: pushed.commitUrl ?? undefined,
      fileCount: pushed.fileCount,
    };

    yield { type: "stage", stage: "done", message: "Deployment provisioned" };
    return result;
  } catch (err) {
    const stage = !projectId ? "railway_project" : !serviceId ? "railway_service" : "railway_variables";
    if (err instanceof PipelineError) throw err;
    throw classifyRailwayErr(err, stage, { projectId, serviceId });
  }
}

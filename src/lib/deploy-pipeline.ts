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
import {
  getVercelUser,
  createVercelProject,
  setVercelEnvVars,
  vercelProjectUrl,
  vercelDeploymentUrl,
  VercelError,
} from "@/lib/vercel";
import {
  listRenderOwners,
  createRenderService,
  renderDashboardUrl,
  RenderError,
} from "@/lib/render";
import {
  listFlyOrgs,
  createFlyApp,
  setFlySecrets,
  flyDashboardUrl,
  FlyError,
} from "@/lib/fly";
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
      provider: "railway",
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

// ─── Render pipeline ─────────────────────────────────────────────────────────

export type RenderDeployParams = {
  githubToken: string;
  renderToken: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  repoName: string;
  isPrivate?: boolean;
  // Optional explicit owner — if absent we pick the first one the token has.
  ownerId?: string;
  region?: string;
};

function renderEnvForLanguage(language: string): "node" | "python" | "go" | "rust" | "docker" {
  // We always have a Dockerfile in the generated repo, so "docker" is the
  // safest default for anything Render doesn't natively recognize. Native
  // envs have faster cold starts, so use them where the language matches.
  switch (language) {
    case "typescript":
      return "node";
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
    default:
      // java, kotlin → docker (Render's JVM detection is flaky).
      return "docker";
  }
}

function renderCommandsFor(language: string, framework: string): {
  build?: string;
  start?: string;
} {
  // For docker env, build/start commands come from the Dockerfile and Render
  // ignores anything we set here. For native envs we hand it the same
  // commands a developer would run locally.
  switch (language) {
    case "typescript":
      return {
        build: "npm install && npm run build",
        // NestJS/Express/Fastify/Hono all bind PORT from env when generated.
        start: "npm run start",
      };
    case "python":
      return {
        build: "pip install poetry && poetry install --no-root --without dev",
        start:
          framework === "django"
            ? "poetry run gunicorn app.wsgi:application --bind 0.0.0.0:$PORT"
            : "poetry run uvicorn app.main:app --host 0.0.0.0 --port $PORT",
      };
    case "go":
      return {
        build: "go build -o bin/server ./cmd/api",
        start: "./bin/server",
      };
    case "rust":
      return {
        build: "cargo build --release",
        start: "./target/release/server",
      };
    default:
      return {};
  }
}

function classifyRenderErr(
  err: unknown,
  stage: string,
  partial?: { serviceId?: string }
): PipelineError {
  if (err instanceof RenderError) {
    switch (err.code) {
      case "not_authorized":
        return new PipelineError({
          code: "render_not_authorized",
          status: 401,
          message: "Render rejected the saved API key.",
          hint: "Replace the key in Settings → Integrations → Render with a fresh Personal API Key from render.com/u/settings#api-keys.",
          stage,
          partial,
        });
      case "rate_limited":
        return new PipelineError({
          code: "render_rate_limited",
          status: 429,
          message: "Render rate-limited the request.",
          hint: "Wait a minute and retry.",
          stage,
          partial,
        });
      case "validation":
        return new PipelineError({
          code: "render_validation",
          status: 400,
          message: "Render rejected the request as invalid.",
          hint: err.message,
          stage,
          partial,
        });
      case "conflict":
        return new PipelineError({
          code: "render_conflict",
          status: 409,
          message: "Render service name is already taken.",
          hint: "Pick a unique repo name on the Deploy screen and retry.",
          stage,
          partial,
        });
      case "network_error":
        return new PipelineError({
          code: "render_network",
          status: 503,
          message: "Couldn't reach Render.",
          hint: "api.render.com wasn't reachable. Check connectivity and retry.",
          stage,
          partial,
        });
      default:
        return new PipelineError({
          code: "render_error",
          status: err.httpStatus,
          message: `Render call failed during ${stage}.`,
          hint: err.message,
          stage,
          partial,
        });
    }
  }
  return new PipelineError({
    code: "render_error",
    status: 502,
    message: `Unexpected error during ${stage}.`,
    hint: err instanceof Error ? err.message : String(err),
    stage,
    partial,
  });
}

export async function* runRenderDeployPipeline(
  params: RenderDeployParams
): AsyncGenerator<PipelineEvent, DeployResult, void> {
  const { githubToken, renderToken, config, endpoints, entities, repoName, isPrivate, ownerId, region } = params;

  // ─── Stage 1: generate + push to GitHub ────────────────────────────────────
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

  // ─── Stage 2: Render provisioning ──────────────────────────────────────────
  let serviceId: string | undefined;

  try {
    let resolvedOwnerId = ownerId;
    if (!resolvedOwnerId) {
      yield { type: "stage", stage: "render_owner", message: "Resolving Render account" };
      const owners = await listRenderOwners(renderToken);
      if (owners.length === 0) {
        throw new PipelineError({
          code: "render_no_owner",
          status: 400,
          message: "Render API key has no associated owner.",
          hint: "Create a Render account at render.com/register and re-issue the API key, or pass an explicit owner.",
          stage: "render_owner",
        });
      }
      // Prefer a user owner; fall back to the first team.
      resolvedOwnerId = (owners.find((o) => o.type === "user") ?? owners[0]).id;
    }

    yield { type: "stage", stage: "render_service", message: "Creating Render web service" };
    const env = renderEnvForLanguage(config.language);
    const cmds = env === "docker" ? {} : renderCommandsFor(config.language, config.framework);

    // Pass through saved env vars; redact any masked-in-place values that may
    // leak in from the UI (the credentials masker uses a "••" prefix).
    const envVars: Record<string, string> = {};
    for (const v of config.envVars) {
      if (v.key && v.value && !v.value.includes("••")) {
        envVars[v.key] = v.value;
      }
    }

    const service = await createRenderService(renderToken, {
      ownerId: resolvedOwnerId,
      name: repoName,
      repo: pushed.url, // Render accepts the github.com URL directly
      branch: "main",
      env,
      buildCommand: cmds.build,
      startCommand: cmds.start,
      region,
      isPrivate,
      envVars,
    });
    serviceId = service.id;
    const domain = service.serviceDetails?.url ?? null;
    yield {
      type: "progress",
      message: "Service created — Render is building the first deploy",
      detail: renderDashboardUrl(serviceId),
    };

    yield { type: "stage", stage: "done", message: "Deployment provisioned" };
    return {
      provider: "render",
      projectUrl: renderDashboardUrl(serviceId),
      serviceId,
      domain,
      fullName: pushed.fullName,
      githubUrl: pushed.url,
      commitUrl: pushed.commitUrl ?? undefined,
      fileCount: pushed.fileCount,
      nextStep: domain
        ? undefined
        : {
            message:
              "Render is provisioning the public URL — open the service dashboard to monitor the build.",
          },
    };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    const stage = serviceId ? "render_service" : "render_owner";
    throw classifyRenderErr(err, stage, { serviceId });
  }
}

// ─── Fly pipeline ────────────────────────────────────────────────────────────

export type FlyDeployParams = {
  githubToken: string;
  flyToken: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  repoName: string;
  isPrivate?: boolean;
  // Optional explicit org slug; falls back to "personal".
  orgSlug?: string;
};

function classifyFlyErr(
  err: unknown,
  stage: string,
  partial?: { appName?: string }
): PipelineError {
  if (err instanceof FlyError) {
    switch (err.code) {
      case "not_authorized":
        return new PipelineError({
          code: "fly_not_authorized",
          status: 401,
          message: "Fly rejected the saved API token.",
          hint: "Replace the token in Settings → Integrations → Fly with a fresh Personal Access Token from fly.io/user/personal_access_tokens.",
          stage,
          partial,
        });
      case "rate_limited":
        return new PipelineError({
          code: "fly_rate_limited",
          status: 429,
          message: "Fly rate-limited the request.",
          hint: "Wait a minute and retry.",
          stage,
          partial,
        });
      case "validation":
        return new PipelineError({
          code: "fly_validation",
          status: 400,
          message: "Fly rejected the request as invalid.",
          hint: err.message,
          stage,
          partial,
        });
      case "conflict":
        return new PipelineError({
          code: "fly_conflict",
          status: 409,
          message: "Fly app name is already taken.",
          hint: "Pick a unique repo name on the Deploy screen and retry — Fly app names are globally unique.",
          stage,
          partial,
        });
      case "network_error":
        return new PipelineError({
          code: "fly_network",
          status: 503,
          message: "Couldn't reach Fly.",
          hint: "api.machines.dev or api.fly.io wasn't reachable. Check connectivity and retry.",
          stage,
          partial,
        });
      default:
        return new PipelineError({
          code: "fly_error",
          status: err.httpStatus,
          message: `Fly call failed during ${stage}.`,
          hint: err.message,
          stage,
          partial,
        });
    }
  }
  return new PipelineError({
    code: "fly_error",
    status: 502,
    message: `Unexpected error during ${stage}.`,
    hint: err instanceof Error ? err.message : String(err),
    stage,
    partial,
  });
}

export async function* runFlyDeployPipeline(
  params: FlyDeployParams
): AsyncGenerator<PipelineEvent, DeployResult, void> {
  const { githubToken, flyToken, config, endpoints, entities, repoName, isPrivate, orgSlug } = params;

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

  let appName: string | undefined;

  try {
    let resolvedOrg = orgSlug;
    if (!resolvedOrg) {
      yield { type: "stage", stage: "fly_org", message: "Resolving Fly organization" };
      const orgs = await listFlyOrgs(flyToken);
      if (orgs.length === 0) {
        throw new PipelineError({
          code: "fly_no_org",
          status: 400,
          message: "Fly token has no organization access.",
          hint: "Sign in at fly.io and accept the personal org auto-creation, then re-issue the token.",
          stage: "fly_org",
        });
      }
      resolvedOrg =
        orgs.find((o) => o.slug === "personal")?.slug ?? orgs[0].slug;
    }

    // Fly app names are globally unique — collide-safely, append the repo
    // name verbatim and let the conflict bubble up if the user picked one
    // already in use. The error handler surfaces a friendly message.
    appName = repoName;

    yield { type: "stage", stage: "fly_app", message: "Creating Fly app" };
    await createFlyApp(flyToken, appName, resolvedOrg);
    yield {
      type: "progress",
      message: `App ${appName} created in org ${resolvedOrg}`,
      detail: flyDashboardUrl(appName),
    };

    const secrets: Record<string, string> = {};
    for (const v of config.envVars) {
      if (v.key && v.value && !v.value.includes("••")) {
        secrets[v.key] = v.value;
      }
    }
    if (Object.keys(secrets).length > 0) {
      yield { type: "stage", stage: "fly_secrets", message: `Setting ${Object.keys(secrets).length} secrets` };
      await setFlySecrets(flyToken, appName, secrets);
    }

    // The Fly REST machines API does not (yet) build an image from a GitHub
    // repo — that part is `flyctl deploy` from a checkout. Surface a
    // one-line instruction so the deploy doesn't appear to silently stall.
    yield { type: "stage", stage: "fly_handoff", message: "Awaiting first build" };
    yield {
      type: "warn",
      message:
        "Run `flyctl deploy` once locally (or via the generated GitHub Action) to build and ship the first image.",
    };

    yield { type: "stage", stage: "done", message: "App provisioned" };
    return {
      provider: "fly",
      projectUrl: flyDashboardUrl(appName),
      appName,
      domain: `https://${appName}.fly.dev`,
      fullName: pushed.fullName,
      githubUrl: pushed.url,
      commitUrl: pushed.commitUrl ?? undefined,
      fileCount: pushed.fileCount,
      nextStep: {
        message:
          "Run `flyctl deploy` from the cloned repo to build and ship the first image. The hostname will activate once the first build succeeds.",
        command: `git clone ${pushed.url} && cd ${repoName} && flyctl deploy`,
      },
    };
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    const stage = appName ? "fly_secrets" : "fly_app";
    throw classifyFlyErr(err, stage, { appName });
  }
}

// ─── Vercel pipeline ─────────────────────────────────────────────────────────

export type VercelDeployParams = {
  githubToken: string;
  vercelToken: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  repoName: string;
  isPrivate?: boolean;
};

function classifyVercelErr(
  err: unknown,
  stage: string,
  partial?: { projectId?: string }
): PipelineError {
  if (err instanceof VercelError) {
    switch (err.code) {
      case "not_authorized":
        return new PipelineError({
          code: "vercel_not_authorized",
          status: 401,
          message: "Vercel rejected the saved token.",
          hint: "Go to Settings → Integrations → Vercel and replace the token with a fresh Personal Access Token from vercel.com/account/tokens.",
          stage,
          partial,
        });
      case "no_github":
        return new PipelineError({
          code: "vercel_no_github",
          status: 400,
          message: "Vercel can't access the GitHub repo.",
          hint: "Install the Vercel GitHub App at vercel.com/integrations/github, grant access to your account or org, then retry.",
          stage,
          partial,
        });
      case "conflict":
        return new PipelineError({
          code: "vercel_conflict",
          status: 409,
          message: "A Vercel project with this name already exists.",
          hint: "Rename your project in the builder and retry, or delete the existing Vercel project at vercel.com.",
          stage,
          partial,
        });
      case "rate_limited":
        return new PipelineError({
          code: "vercel_rate_limited",
          status: 429,
          message: "Vercel rate-limited the request.",
          hint: "Wait a minute and retry.",
          stage,
          partial,
        });
      case "network_error":
        return new PipelineError({
          code: "vercel_network",
          status: 503,
          message: "Couldn't reach Vercel.",
          hint: "api.vercel.com wasn't reachable. Check connectivity and retry.",
          stage,
          partial,
        });
      default:
        return new PipelineError({
          code: "vercel_error",
          status: err.httpStatus,
          message: `Vercel call failed during ${stage}.`,
          hint: err.message,
          stage,
          partial,
        });
    }
  }
  return new PipelineError({
    code: "vercel_error",
    status: 502,
    message: `Unexpected error during ${stage}.`,
    hint: err instanceof Error ? err.message : String(err),
    stage,
    partial,
  });
}

/**
 * Runs the full push → Vercel deploy pipeline.
 *
 * Stages:
 * 1. Push generated repo to GitHub.
 * 2. Create a Vercel project linked to that GitHub repo (triggers auto-deploy).
 * 3. Set environment variables.
 * 4. Surface project URL + expected deployment hostname.
 *
 * Prerequisite: the Vercel GitHub App must be installed on the account/org
 * that owns the repo. If it isn't, a "vercel_no_github" error is thrown with
 * the install link in the hint.
 */
export async function* runVercelDeployPipeline(
  params: VercelDeployParams
): AsyncGenerator<PipelineEvent, DeployResult, void> {
  const { githubToken, vercelToken, config, endpoints, entities, repoName, isPrivate } = params;

  // ─── Stage 1: generate + push to GitHub ─────────────────────────────────────
  yield { type: "stage", stage: "github_push", message: "Pushing code to GitHub" };

  let pushed: PushResult;
  try {
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

  // ─── Stage 2: get Vercel user identity ──────────────────────────────────────
  let vercelUsername: string;
  try {
    const user = await getVercelUser(vercelToken);
    vercelUsername = user.username;
  } catch (err) {
    throw classifyVercelErr(err, "vercel_project");
  }

  // ─── Stage 3: create Vercel project linked to GitHub ────────────────────────
  let projectId: string | undefined;
  try {
    yield { type: "stage", stage: "vercel_project", message: "Creating Vercel project" };
    const project = await createVercelProject(vercelToken, config.name, pushed.fullName);
    projectId = project.id;
    yield {
      type: "progress",
      message: "Project created — Vercel is building the first deployment",
      detail: vercelProjectUrl(vercelUsername, config.name),
    };
  } catch (err) {
    throw classifyVercelErr(err, "vercel_project");
  }

  // ─── Stage 4: set environment variables ─────────────────────────────────────
  try {
    const vars: Record<string, string> = {};
    for (const v of config.envVars) {
      if (v.key && v.value && !v.value.includes("••")) {
        vars[v.key] = v.value;
      }
    }
    if (Object.keys(vars).length > 0) {
      yield {
        type: "stage",
        stage: "vercel_env",
        message: `Setting ${Object.keys(vars).length} environment variables`,
      };
      await setVercelEnvVars(vercelToken, projectId!, vars);
      yield { type: "progress", message: "Environment variables set" };
    }
  } catch (err) {
    throw classifyVercelErr(err, "vercel_env", { projectId });
  }

  // ─── Stage 5: surface URLs ───────────────────────────────────────────────────
  yield { type: "stage", stage: "vercel_domain", message: "Resolving deployment URL" };
  const deploymentUrl = vercelDeploymentUrl(config.name);
  yield {
    type: "progress",
    message: "First build in progress on Vercel",
    detail: deploymentUrl,
  };

  const result: DeployResult = {
    provider: "vercel",
    projectUrl: vercelProjectUrl(vercelUsername, config.name),
    domain: deploymentUrl,
    fullName: pushed.fullName,
    githubUrl: pushed.url,
    commitUrl: pushed.commitUrl ?? undefined,
    fileCount: pushed.fileCount,
    projectId,
  };

  yield { type: "stage", stage: "done", message: "Vercel project provisioned" };
  return result;
}

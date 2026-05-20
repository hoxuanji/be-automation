import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds } from "@/lib/db";
import { stackConfigSchema, endpointSchema, entitySchema, relationSchema } from "@/lib/schema";
import { runRenderDeployPipeline } from "@/lib/deploy-pipeline";
import { PipelineError } from "@/lib/pipeline-types";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  config: stackConfigSchema,
  endpoints: z.array(endpointSchema),
  entities: z.array(entitySchema).optional().default([]),
  relations: z.array(relationSchema).optional().default([]),
  repoName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  private: z.boolean().optional().default(false),
  ownerId: z.string().min(1).max(64).optional(),
  region: z.enum(["oregon", "frankfurt", "singapore", "ohio", "virginia"]).optional(),
});

export async function POST(req: NextRequest) {
  const claims = await getCurrentUser(req);
  if (!claims) {
    return Response.json(
      { error: "unauthorized", message: "You must be signed in to deploy.", hint: "Sign in with GitHub, then try again." },
      { status: 401 }
    );
  }

  const cookieStore = await cookies();
  const githubToken = cookieStore.get("github_token")?.value;
  if (!githubToken) {
    return Response.json(
      {
        error: "github_not_connected",
        message: "GitHub isn't connected.",
        hint: "Connect GitHub in Settings → Integrations, then retry deployment.",
      },
      { status: 400 }
    );
  }

  const allCreds = getDeployCreds(claims.sub);
  const renderToken = allCreds.render?.token;
  if (!renderToken) {
    return Response.json(
      {
        error: "render_token_missing",
        message: "No Render API key saved.",
        hint: "Save a Render Personal API Key under Settings → Integrations first.",
      },
      { status: 400 }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Malformed request body.", hint: "Refresh the page and retry." },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", message: "Request body failed validation.", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { config, endpoints, entities, ownerId, region } = parsed.data;
  const slugged = config.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "helios-app";
  const repoName = parsed.data.repoName ?? slugged;

  try {
    const gen = runRenderDeployPipeline({
      githubToken,
      renderToken,
      config,
      endpoints,
      entities,
      repoName,
      isPrivate: parsed.data.private,
      ownerId,
      region,
    });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return Response.json(next.value);
  } catch (err) {
    if (err instanceof PipelineError) {
      return Response.json(err.toJSON(), { status: err.status });
    }
    console.error("[render/deploy] unexpected error:", err);
    return Response.json(
      {
        error: "render_error",
        message: "Deployment failed unexpectedly.",
        hint: err instanceof Error ? err.message : "Check server logs.",
      },
      { status: 502 }
    );
  }
}

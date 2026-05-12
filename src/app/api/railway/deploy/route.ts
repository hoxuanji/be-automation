import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds } from "@/lib/db";
import { stackConfigSchema, endpointSchema, entitySchema, relationSchema } from "@/lib/schema";
import { runDeployPipeline } from "@/lib/deploy-pipeline";
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
  const railwayToken = allCreds.railway?.token;
  if (!railwayToken) {
    return Response.json(
      {
        error: "railway_token_missing",
        message: "No Railway token saved.",
        hint: "Save a Railway Personal API Token under Settings → Integrations first.",
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

  const { config, endpoints, entities } = parsed.data;
  const slugged = config.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "helios-app";
  const repoName = parsed.data.repoName ?? slugged;

  try {
    const gen = runDeployPipeline({
      githubToken,
      railwayToken,
      config,
      endpoints,
      entities,
      repoName,
      isPrivate: parsed.data.private,
    });
    // Drain events; only the final return value matters for the JSON adapter.
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return Response.json(next.value);
  } catch (err) {
    if (err instanceof PipelineError) {
      return Response.json(err.toJSON(), { status: err.status });
    }
    console.error("[railway/deploy] unexpected error:", err);
    return Response.json(
      {
        error: "railway_error",
        message: "Deployment failed unexpectedly.",
        hint: err instanceof Error ? err.message : "Check server logs.",
      },
      { status: 502 }
    );
  }
}

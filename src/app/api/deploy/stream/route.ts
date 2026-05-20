import { type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds } from "@/lib/db";
import { stackConfigSchema, endpointSchema, entitySchema, relationSchema } from "@/lib/schema";
import {
  runDeployPipeline,
  runRenderDeployPipeline,
  runFlyDeployPipeline,
  runVercelDeployPipeline,
} from "@/lib/deploy-pipeline";
import {
  PipelineError,
  type DeployProvider,
  type PipelineEvent,
} from "@/lib/pipeline-types";
import { z } from "zod";

export const runtime = "nodejs";
// SSE streams must stay open for the duration of the deploy, which can exceed
// the default edge/serverless timeout on some providers. Disable any caching.
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // Provider is optional with a railway default — keeps the existing client
  // contract working unchanged for current callers.
  provider: z.enum(["railway", "render", "fly", "vercel"]).optional().default("railway"),
  config: stackConfigSchema,
  endpoints: z.array(endpointSchema),
  entities: z.array(entitySchema).optional().default([]),
  relations: z.array(relationSchema).optional().default([]),
  repoName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  private: z.boolean().optional().default(false),
  // Optional provider-specific knobs.
  ownerId: z.string().min(1).max(64).optional(), // render
  orgSlug: z.string().min(1).max(64).optional(), // fly
  region: z.string().min(1).max(32).optional(),  // render
});

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ProviderTokens = {
  github: string;
  railway?: string;
  render?: string;
  fly?: string;
  vercel?: string;
};

function tokenForProvider(p: DeployProvider, tokens: ProviderTokens): string | undefined {
  switch (p) {
    case "railway": return tokens.railway;
    case "render":  return tokens.render;
    case "fly":     return tokens.fly;
    case "vercel":  return tokens.vercel;
  }
}

function tokenMissingError(p: DeployProvider) {
  switch (p) {
    case "railway":
      return { error: "railway_token_missing", message: "No Railway token saved.", hint: "Save a Railway Personal API Token under Settings → Integrations first." };
    case "render":
      return { error: "render_token_missing", message: "No Render API key saved.", hint: "Save a Render Personal API Key under Settings → Integrations first." };
    case "fly":
      return { error: "fly_token_missing", message: "No Fly API token saved.", hint: "Save a Fly Personal Access Token under Settings → Integrations first." };
    case "vercel":
      return { error: "vercel_token_missing", message: "No Vercel token saved.", hint: "Save a Vercel Personal Access Token under Settings → Integrations first." };
  }
}

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

  const provider = parsed.data.provider as DeployProvider;
  const allCreds = getDeployCreds(claims.sub);
  const tokens: ProviderTokens = {
    github: githubToken,
    railway: allCreds.railway?.token,
    render: allCreds.render?.token,
    fly: allCreds.fly?.token,
    vercel: allCreds.vercel?.token,
  };
  const providerToken = tokenForProvider(provider, tokens);
  if (!providerToken) {
    return Response.json(tokenMissingError(provider), { status: 400 });
  }

  const { config, endpoints, entities } = parsed.data;
  const slugged = config.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "helios-app";
  const repoName = parsed.data.repoName ?? slugged;

  const encoder = new TextEncoder();
  const abortSignal = req.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (abortSignal.aborted) return;
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      };

      // Heartbeat every 15s so intermediaries (proxies, load balancers)
      // don't silently close the connection.
      const heartbeat = setInterval(() => {
        if (abortSignal.aborted) return;
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);

      try {
        // Build the right pipeline generator for the chosen provider.
        const gen =
          provider === "railway"
            ? runDeployPipeline({
                githubToken,
                railwayToken: providerToken,
                config, endpoints, entities, repoName, isPrivate: parsed.data.private,
              })
            : provider === "render"
            ? runRenderDeployPipeline({
                githubToken,
                renderToken: providerToken,
                config, endpoints, entities, repoName, isPrivate: parsed.data.private,
                ownerId: parsed.data.ownerId,
                region: parsed.data.region,
              })
            : provider === "vercel"
            ? runVercelDeployPipeline({
                githubToken,
                vercelToken: providerToken,
                config, endpoints, entities, repoName, isPrivate: parsed.data.private,
              })
            : runFlyDeployPipeline({
                githubToken,
                flyToken: providerToken,
                config, endpoints, entities, repoName, isPrivate: parsed.data.private,
                orgSlug: parsed.data.orgSlug,
              });

        let next = await gen.next();
        while (!next.done) {
          if (abortSignal.aborted) {
            // Client closed the tab / navigated away.
            break;
          }
          const evt: PipelineEvent = next.value;
          send(evt.type, evt);
          next = await gen.next();
        }

        if (!next.done) {
          // Loop exited via abort
          return;
        }
        send("done", { type: "done", result: next.value });
      } catch (err) {
        const fallbackCode =
          provider === "railway" ? "railway_error"
          : provider === "render" ? "render_error"
          : provider === "vercel" ? "vercel_error"
          : "fly_error";
        const pe =
          err instanceof PipelineError
            ? err
            : new PipelineError({
                code: fallbackCode,
                status: 502,
                message: "Deployment failed unexpectedly.",
                hint: err instanceof Error ? err.message : String(err),
              });
        send("error", { type: "error", error: { ...pe.toJSON(), status: pe.status } });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by abort — ignore.
        }
      }
    },
    cancel() {
      // No resources held outside the `start` closure; abortSignal handles the rest.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

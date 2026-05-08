import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDeployCreds } from "@/lib/db";
import { stackConfigSchema, endpointSchema, entitySchema, relationSchema } from "@/lib/schema";
import {
  getDefaultWorkspaceId,
  createRailwayProject,
  getRailwayProject,
  createRailwayService,
  setRailwayVariables,
  createRailwayDomain,
} from "@/lib/railway";
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
  if (!claims) return Response.json({ error: "unauthorized" }, { status: 401 });

  // 1. Load saved Railway token
  const allCreds = getDeployCreds(claims.sub);
  const railwayToken = allCreds.railway?.token;
  if (!railwayToken) {
    return Response.json({ error: "railway_token_missing", hint: "Save a Railway API token in the Credentials panel first." }, { status: 400 });
  }

  // 2. Parse request body
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { config, endpoints, entities } = parsed.data;
  const slugged = config.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "helios-app";
  const repoName = parsed.data.repoName ?? slugged;

  // 3. Push generated code to GitHub (forwards github_token cookie automatically)
  const pushRes = await fetch(new URL("/api/github/push", req.nextUrl.origin).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: req.headers.get("cookie") ?? "",
    },
    body: JSON.stringify({
      config,
      endpoints,
      entities,
      repoName,
      private: parsed.data.private,
    }),
  });

  if (!pushRes.ok) {
    const err = (await pushRes.json()) as { error?: string };
    if (err.error === "not_authenticated") {
      return Response.json({ error: "github_not_connected", hint: "Connect GitHub in the builder CI/CD tab first." }, { status: 400 });
    }
    return Response.json({ error: "github_push_failed", detail: err }, { status: 502 });
  }

  const pushData = (await pushRes.json()) as { fullName: string; url: string };
  const fullName = pushData.fullName; // "owner/repo-name"

  // 4–8. Railway provisioning
  try {
    // 4. Resolve workspace ID then create Railway project
    const workspaceId = await getDefaultWorkspaceId(railwayToken);
    console.log("[railway/deploy] workspace:", workspaceId);

    const project = await createRailwayProject(railwayToken, config.name, workspaceId);
    console.log("[railway/deploy] project:", project.id);

    // 5. Get the default (production) environment ID
    const projectData = await getRailwayProject(railwayToken, project.id);
    const env = projectData.environments.find((e) => e.name === "production") ?? projectData.environments[0];
    if (!env) {
      return Response.json({ error: "railway_env_not_found" }, { status: 502 });
    }
    console.log("[railway/deploy] env:", env.id);

    // 6. Create a service linked to the GitHub repo
    const service = await createRailwayService(railwayToken, project.id, config.name, fullName);
    console.log("[railway/deploy] service:", service.id);

    // 7. Set environment variables from stack config
    const vars: Record<string, string> = {};
    for (const v of config.envVars) {
      if (v.key && v.value && !v.value.includes("••")) {
        vars[v.key] = v.value;
      }
    }
    if (Object.keys(vars).length > 0) {
      await setRailwayVariables(railwayToken, project.id, service.id, env.id, vars);
    }

    // 8. Generate a public domain (best-effort)
    let domain: string | null = null;
    try {
      const rawDomain = await createRailwayDomain(railwayToken, service.id, env.id);
      domain = `https://${rawDomain}`;
    } catch (domainErr) {
      console.warn("[railway/deploy] domain creation skipped:", domainErr instanceof Error ? domainErr.message : domainErr);
    }

    return Response.json({
      projectUrl: `https://railway.app/project/${project.id}`,
      domain,
      fullName,
      githubUrl: pushData.url,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[railway/deploy] error:", msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { pushGeneratedRepo } from "@/lib/github-push";
import { PipelineError } from "@/lib/pipeline-types";
import { stackConfigSchema, endpointSchema, entitySchema } from "@/lib/schema";

export const runtime = "nodejs";

const bodySchema = z.object({
  config: stackConfigSchema,
  endpoints: z.array(endpointSchema),
  entities: z.array(entitySchema),
  repoName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/),
  private: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get("github_token")?.value;
  if (!token) {
    return NextResponse.json(
      {
        error: "token_invalid",
        message: "GitHub token is missing or expired.",
        hint: "Reconnect GitHub from Settings → Integrations.",
      },
      { status: 401 }
    );
  }

  const body = await req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", message: "Request body failed validation.", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const result = await pushGeneratedRepo({
      token,
      config: parsed.data.config,
      endpoints: parsed.data.endpoints,
      entities: parsed.data.entities,
      repoName: parsed.data.repoName,
      isPrivate: parsed.data.private,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json(err.toJSON(), { status: err.status });
    }
    console.error("[github/push] unexpected error:", err);
    return NextResponse.json(
      {
        error: "unexpected",
        message: "Push failed unexpectedly.",
        hint: err instanceof Error ? err.message : "Check server logs.",
      },
      { status: 500 }
    );
  }
}

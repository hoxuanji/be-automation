import { NextRequest } from "next/server";
import { z } from "zod";
import { architectureProposalSchema } from "@/lib/architect-schema";
import { publish, recordFork } from "@/lib/share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const publishRequestSchema = z.object({
  intent: z.string().min(1).max(2000).default("(no brief)"),
  proposal: architectureProposalSchema,
});

const forkRequestSchema = z.object({
  slug: z.string().min(1).max(80),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "fork") {
    const parsed = forkRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "validation_error", issues: parsed.error.flatten() },
        { status: 400 }
      );
    }
    recordFork(parsed.data.slug);
    return Response.json({ ok: true });
  }

  const parsed = publishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const shared = publish(parsed.data.intent, parsed.data.proposal);
  const origin = req.headers.get("origin") ?? url.origin;
  return Response.json({
    slug: shared.slug,
    url: `${origin}/show/${shared.slug}`,
    createdAt: shared.createdAt,
  });
}

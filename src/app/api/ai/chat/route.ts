import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiChatRequestSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are "Helios", an expert backend infrastructure architect embedded in a visual stack generator.

You help developers:
- choose languages, frameworks, databases, caches, queues, auth, deployment targets
- explain trade-offs (cost, latency, operability, team fit)
- audit their current stack and recommend concrete upgrades
- design API contracts and data models

Rules:
- Be concise. Short paragraphs, bullets where it helps.
- Prefer concrete recommendations over abstract advice.
- When you recommend a change, state the *why* and the *trade-off*.
- If the user's stack config is in context, reason from it.
- Never invent private APIs, pricing, or benchmarks you are not sure about.`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "missing_api_key",
        detail:
          "Set ANTHROPIC_API_KEY in .env.local to enable the real assistant.",
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = aiChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { messages, config } = parsed.data;
  const client = new Anthropic();

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT },
  ];

  if (config) {
    systemBlocks.push({
      type: "text",
      text: `Current stack configuration (cached):\n\n\`\`\`json\n${JSON.stringify(
        config,
        null,
        2
      )}\n\`\`\``,
      cache_control: { type: "ephemeral" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        const response = client.messages.stream({
          model: MODEL,
          max_tokens: 1024,
          system: systemBlocks,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        });

        response.on("text", (text) => send("text", { text }));
        response.on("error", (err) =>
          send("error", { message: (err as Error).message })
        );

        const final = await response.finalMessage();
        send("done", {
          usage: final.usage,
          stopReason: final.stop_reason,
        });
        controller.close();
      } catch (err) {
        send("error", { message: (err as Error).message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

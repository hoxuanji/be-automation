import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { PATTERN_CATALOG } from "@/lib/generators/patterns/index";

export const runtime = "nodejs";

const requestSchema = z.object({
  endpoint: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().max(256),
    pattern: z.string().max(64).optional(),
    logic: z.string().max(2000).optional(),
    summary: z.string().max(200).optional(),
  }),
  config: z.object({
    language: z.string(),
    framework: z.string(),
    database: z.string().optional(),
    cache: z.string().optional(),
  }),
});

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "missing_api_key" }, { status: 503 });
  }

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await req.json());
  } catch (_err) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { endpoint, config } = parsed;
  const patternInfo = PATTERN_CATALOG.find((p) => p.id === endpoint.pattern);

  const langHint: Record<string, string> = {
    go: "Go",
    typescript: "TypeScript",
    python: "Python",
    rust: "Rust",
    java: "Java",
    kotlin: "Kotlin",
  };

  const frameworkHint = config.framework || "default framework";
  const langDisplay = langHint[config.language] ?? config.language;

  const prompt = `Generate a production-ready, hardened ${langDisplay} (${frameworkHint}) handler function for the following API endpoint.

**Endpoint:** ${endpoint.method} ${endpoint.path}
**Summary:** ${endpoint.summary || "(none provided)"}
**Pattern:** ${patternInfo ? `${patternInfo.name} — ${patternInfo.desc}` : endpoint.pattern || "custom"}
**Business logic description:** ${endpoint.logic || "(use the pattern's standard implementation)"}
**Database:** ${config.database || "none"}
**Cache:** ${config.cache || "none"}

Requirements:
- Return ONLY the handler function code — no markdown fences, no explanations, no surrounding file structure
- Include proper error handling (400 bad request, 404 not found, 500 internal error)
- Include input validation
- Use the idiomatic style and patterns for ${langDisplay} with ${frameworkHint}
- If the pattern is CRUD, use the ORM appropriate for the stack (${config.database === "mongodb" ? "MongoDB driver" : config.language === "go" ? "GORM" : config.language === "typescript" ? "Prisma" : "SQLAlchemy"})
- If auth patterns: use bcrypt for password hashing, JWT for tokens
- Make the code security-hardened (prevent SQL injection, timing attacks on auth, MIME validation for uploads)
- Use structured logging
- Do not include import statements — only the function body`;

  const client = new Anthropic({ apiKey });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const stream = await client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
        });

        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event.delta.text)}\n\n`)
            );
          }
        }
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`
          )
        );
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

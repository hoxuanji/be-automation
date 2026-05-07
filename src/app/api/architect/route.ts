import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  architectRequestSchema,
  architectureProposalSchema,
} from "@/lib/architect-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are "Helios" — an expert AI platform engineer that designs production-grade backend architectures from a one-line product intent.

Your job: read the user's brief, infer their workload shape, and design the optimal stack. Then call the propose_architecture tool ONCE with a complete proposal.

While you reason out loud (before the tool call), narrate the key trade-offs in short, punchy sentences. Don't lecture. Skip preamble. The user is watching this stream live.

Decision principles:
- Default to boring, battle-tested choices unless the workload demands otherwise.
- Postgres unless there is a real reason not to.
- Pick managed services (Neon, Upstash, Clerk) for sub-Series-B teams; self-hosted for compliance-heavy enterprise.
- Choose the simplest deployment that meets the SLA. Railway/Vercel/Fly < AWS < Kubernetes.
- Realtime / streaming / fanout → NATS or Kafka. Job queues → BullMQ (TS) / RabbitMQ.
- Compliance flags (HIPAA, PCI, SOC2, GDPR) drive auth, region, audit, and provider choices.
- Cost matters — prefer serverless / scale-to-zero for early-stage; reserved capacity for steady-state.

When you call the tool, every decision must include a concrete *tradeoff* — what you gave up by choosing it. Predictions should reflect typical traffic for the inferred workload at year-1 scale, not best/worst case.

Tool field constraints (must match exactly):
- language: one of "go", "typescript", "python", "rust", "java", "kotlin"
- framework: scoped to language. Go: gin|fiber|echo|chi. TS: nestjs|express|fastify|hono. Python: fastapi|django|litestar. Rust: axum|actix. Java: spring|quarkus. Kotlin: ktor|spring-kt.
- database: postgres|mysql|mongodb|dynamodb|cockroach|planetscale|supabase|neon
- cache: redis|memcached|dragonfly|upstash
- queue: rabbitmq|kafka|sqs|nats|bullmq
- api: rest|grpc|graphql|trpc
- auth: clerk|auth0|supabase-auth|cognito|firebase|keycloak
- deployment: vercel|railway|render|fly|aws|gcp|azure|k8s
- scaling: horizontal|vertical|serverless|hybrid
- monitoring: grafana|datadog|sentry|newrelic|otel
- cicd: gh-actions|gitlab-ci|circleci|argo
- region: e.g. "us-east-1", "eu-west-2", "ap-south-1"
- name: lowercase-kebab, max 32 chars, derived from the intent
- replicas: 1-12
- envVars: 3-8 entries; mark passwords/keys as secret: true.
`;

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_architecture",
  description:
    "Submit the final, complete architecture proposal. Call exactly once after reasoning.",
  input_schema: {
    type: "object",
    required: ["summary", "decisions", "config", "predictions"],
    properties: {
      summary: {
        type: "string",
        description:
          "2-3 sentence executive summary of the proposed architecture and why it fits this workload.",
      },
      decisions: {
        type: "array",
        minItems: 4,
        maxItems: 20,
        items: {
          type: "object",
          required: ["topic", "choice", "reasoning"],
          properties: {
            topic: {
              type: "string",
              enum: [
                "language",
                "framework",
                "database",
                "cache",
                "queue",
                "api",
                "auth",
                "deployment",
                "scaling",
                "monitoring",
                "security",
              ],
            },
            choice: { type: "string" },
            reasoning: { type: "string" },
            tradeoff: { type: "string" },
          },
        },
      },
      config: {
        type: "object",
        required: [
          "name",
          "language",
          "framework",
          "database",
          "cache",
          "queue",
          "api",
          "auth",
          "deployment",
          "scaling",
          "monitoring",
          "cicd",
          "docker",
          "kubernetes",
          "helm",
          "tracing",
          "rateLimit",
          "audit",
          "autoscale",
          "replicas",
          "region",
          "envVars",
        ],
        properties: {
          name: { type: "string" },
          language: {
            type: "string",
            enum: ["go", "typescript", "python", "rust", "java", "kotlin"],
          },
          framework: { type: "string" },
          database: { type: "string" },
          cache: { type: "string" },
          queue: { type: "string" },
          api: { type: "string", enum: ["rest", "grpc", "graphql", "trpc"] },
          auth: { type: "string" },
          deployment: { type: "string" },
          scaling: { type: "string" },
          monitoring: { type: "string" },
          cicd: { type: "string" },
          docker: { type: "boolean" },
          kubernetes: { type: "boolean" },
          helm: { type: "boolean" },
          tracing: { type: "boolean" },
          rateLimit: { type: "boolean" },
          audit: { type: "boolean" },
          autoscale: { type: "boolean" },
          replicas: { type: "integer", minimum: 1, maximum: 12 },
          region: { type: "string" },
          envVars: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "value"],
              properties: {
                key: { type: "string" },
                value: { type: "string" },
                secret: { type: "boolean" },
              },
            },
          },
        },
      },
      predictions: {
        type: "object",
        required: [
          "monthlyCostUsd",
          "p99LatencyMs",
          "maxRpsPerReplica",
          "vendorLockInScore",
          "compliance",
        ],
        properties: {
          monthlyCostUsd: { type: "number" },
          p99LatencyMs: { type: "number" },
          maxRpsPerReplica: { type: "number" },
          vendorLockInScore: {
            type: "number",
            minimum: 0,
            maximum: 10,
          },
          compliance: {
            type: "array",
            items: { type: "string" },
            description:
              'e.g. ["GDPR", "SOC2-ready"]. Empty if no compliance posture.',
          },
        },
      },
    },
  },
};

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "missing_api_key",
        detail:
          "Set ANTHROPIC_API_KEY in .env.local to enable the AI architect.",
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

  const parsed = architectRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { intent } = parsed.data;
  const client = new Anthropic();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        send("status", { phase: "thinking" });

        const response = client.messages.stream({
          model: MODEL,
          max_tokens: 3000,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          tools: [PROPOSE_TOOL],
          tool_choice: { type: "tool", name: "propose_architecture" },
          messages: [{ role: "user", content: intent }],
        });

        response.on("text", (text) => {
          if (text.trim()) send("narration", { text });
        });

        const final = await response.finalMessage();

        const toolUse = final.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );
        if (!toolUse) {
          send("error", { message: "Model did not produce a proposal." });
          controller.close();
          return;
        }

        const validated = architectureProposalSchema.safeParse(toolUse.input);
        if (!validated.success) {
          send("error", {
            message: "Proposal failed validation.",
            issues: validated.error.flatten(),
          });
          controller.close();
          return;
        }

        send("proposal", validated.data);
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

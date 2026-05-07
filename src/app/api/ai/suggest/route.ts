import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiSuggestRequestSchema } from "@/lib/schema";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Helios, an expert backend architect. Given a project description, return ONLY a valid JSON object — no markdown, no code fences, no extra text.

Available values:
- language: "go" | "typescript" | "python" | "rust" | "java" | "kotlin"
- framework: go→["gin","fiber","echo","chi"], typescript→["nestjs","express","fastify","hono"], python→["fastapi","django","litestar"], rust→["axum","actix"], java→["spring","quarkus"], kotlin→["ktor","spring-kt"]
- database: "postgres" | "mongodb" | "mysql" | "sqlite" | "cockroachdb" | "neon" | "supabase" | "dynamodb"
- cache: "redis" | "memcached" | "upstash" | "dragonfly" | "none"
- queue: "rabbitmq" | "kafka" | "nats" | "bullmq" | "sqs" | "temporal" | "none"
- api: "rest" | "grpc" | "graphql" | "trpc"
- auth: "clerk" | "auth0" | "supabase-auth" | "cognito" | "firebase-auth" | "custom-jwt" | "none"
- deployment: "vercel" | "railway" | "render" | "fly" | "aws" | "gcp" | "azure" | "k8s" | "local"
- scaling: "horizontal" | "vertical" | "serverless" | "edge"
- monitoring: "grafana" | "datadog" | "sentry" | "newrelic" | "honeycomb" | "prometheus"
- cicd: "gh-actions" | "gitlab-ci" | "circle-ci" | "jenkins"
- field type: "string" | "text" | "number" | "boolean" | "date" | "uuid" | "json"

Return exactly this JSON shape:
{
  "config": {
    "language": "...",
    "framework": "...",
    "database": "...",
    "cache": "...",
    "queue": "...",
    "api": "rest",
    "auth": "...",
    "deployment": "...",
    "scaling": "horizontal",
    "monitoring": "...",
    "cicd": "gh-actions",
    "docker": true,
    "kubernetes": false,
    "helm": false,
    "tracing": true,
    "rateLimit": true,
    "audit": false,
    "autoscale": false,
    "replicas": 2,
    "region": "us-east-1"
  },
  "entities": [
    {
      "id": "e1",
      "name": "PascalCaseName",
      "fields": [
        { "id": "f1", "name": "id", "type": "uuid", "required": true, "unique": true, "primaryKey": true },
        { "id": "f2", "name": "fieldName", "type": "string", "required": true, "unique": false }
      ]
    }
  ],
  "endpoints": [
    {
      "id": "ep1",
      "method": "GET",
      "path": "/resource",
      "summary": "What this does",
      "auth": false,
      "requestSchema": "InputType",
      "responseSchema": "OutputType"
    }
  ],
  "explanation": "2-3 sentence explanation of key choices."
}

Guidelines:
- Always include an "id" field (uuid, primaryKey) and "createdAt" (date) on each entity
- Create 2–5 entities with realistic fields
- Create 5–10 RESTful endpoints covering CRUD + domain operations
- For real-time: prefer Go/TypeScript + Redis + NATS/Kafka
- For data pipelines: prefer Python + Postgres/MongoDB
- For SaaS: prefer TypeScript/Go + Postgres + Redis + Clerk auth`;

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 10)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "missing_api_key",
        detail: "Set ANTHROPIC_API_KEY in .env.local to enable AI suggestions.",
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

  const parsed = aiSuggestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const client = new Anthropic();

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Project description: ${parsed.data.prompt}`,
        },
      ],
    });

    const raw =
      message.content[0]?.type === "text" ? message.content[0].text : "";

    let suggestion: unknown;
    try {
      // Strip potential markdown code fences Claude might emit despite the prompt
      const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
      suggestion = JSON.parse(cleaned);
    } catch {
      return Response.json(
        { error: "parse_error", detail: "AI returned non-JSON response", raw },
        { status: 422 }
      );
    }

    return Response.json(suggestion, { status: 200 });
  } catch (err) {
    return Response.json(
      { error: "upstream_error", detail: (err as Error).message },
      { status: 502 }
    );
  }
}

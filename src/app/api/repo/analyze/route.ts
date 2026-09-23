import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { analyzeRepo } from "@/lib/repo-analyzer";
import { checkRateLimit, getRateLimitKey } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/auth";
import { findUserById, decryptApiKey } from "@/lib/db";
import type { StackConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  url: z.string().min(1).max(500),
  token: z.string().max(300).optional(),
});

// Files to attempt fetching from the repo root
const PROBE_PATHS = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "README.md",
];

function parseGitHubUrl(raw: string): { owner: string; repo: string } | null {
  // Normalize: strip protocol, trailing .git, whitespace
  const cleaned = raw.trim()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  const match = /^(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/.exec(cleaned);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

// Fetch using raw.githubusercontent.com — no API rate-limit bucket, works for public repos.
// Falls back to the REST API (needed for private repos where the token authorises downloads).
async function fetchFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  token: string | null
): Promise<string | null> {
  // Try raw.githubusercontent.com first (no rate-limit concern for public repos)
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const rawHeaders: Record<string, string> = { "User-Agent": "Helios/1.0" };
  if (token) rawHeaders["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(rawUrl, { headers: rawHeaders });
    if (res.ok) {
      const text = await res.text();
      return text.slice(0, 32_000);
    }
  } catch {}

  // Fallback: REST API (required for private repos)
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github.v3.raw",
    "User-Agent": "Helios/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) apiHeaders["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: apiHeaders }
    );
    if (!res.ok) return null;
    const text = await res.text();
    if (text.startsWith("[") || (text.startsWith("{") && text.includes('"type":"dir"'))) return null;
    return text.slice(0, 32_000);
  } catch {
    return null;
  }
}

async function listWorkflows(owner: string, repo: string, branch: string, token: string | null): Promise<boolean> {
  // Check raw — if .github/workflows/ci.yml or similar exists, the directory is present
  const commonWorkflowNames = ["ci.yml", "ci.yaml", "main.yml", "main.yaml", "build.yml", "test.yml"];
  for (const name of commonWorkflowNames) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/.github/workflows/${name}`;
    const headers: Record<string, string> = { "User-Agent": "Helios/1.0" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return true;
    } catch {}
  }
  // Fallback: REST API directory listing
  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Helios/1.0",
  };
  if (token) apiHeaders["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows`,
      { headers: apiHeaders }
    );
    if (!res.ok) return false;
    const data = await res.json() as unknown;
    return Array.isArray(data) && (data as unknown[]).length > 0;
  } catch {
    return false;
  }
}

async function resolveApiKey(req: NextRequest): Promise<string | null> {
  const claims = await getCurrentUser(req);
  if (claims) {
    const user = findUserById(claims.sub);
    if (user?.llm_api_key_enc) return decryptApiKey(user.llm_api_key_enc);
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}

const ENRICH_SYSTEM = `You are a backend stack analyzer. Given a partial StackConfig (detected heuristically) and a list of raw project files, fill in any missing or uncertain fields with your best inference.

Return ONLY a valid JSON object with these exact keys (use null for unknown fields):
{
  "api": "rest" | "grpc" | "graphql" | "trpc" | null,
  "deployment": string | null,
  "monitoring": string | null,
  "scaling": string | null,
  "auth": string | null,
  "queue": string | null,
  "database": string | null,
  "cache": string | null,
  "rateLimit": boolean | null,
  "tracing": boolean | null
}

Only include fields you can reasonably infer from the files. Do not hallucinate.`;

export async function POST(req: NextRequest) {
  if (!checkRateLimit(getRateLimitKey(req), 10)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "validation_error", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { url, token: reqToken } = parsed.data;

  const coords = parseGitHubUrl(url);
  if (!coords) {
    return Response.json({ error: "invalid_github_url", hint: "Expected https://github.com/owner/repo" }, { status: 400 });
  }
  const { owner, repo } = coords;

  // Prefer request token, then OAuth cookie token
  const cookieStore = await cookies();
  const githubToken = reqToken ?? cookieStore.get("github_token")?.value ?? null;

  // Get repo metadata first (we need the default branch for raw.githubusercontent.com)
  let defaultBranch = "main";
  let repoExists = false;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Helios/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (r.ok) {
      const data = await r.json() as { default_branch?: string };
      defaultBranch = data.default_branch ?? "main";
      repoExists = true;
    } else if (r.status === 404) {
      return Response.json({
        error: "repo_not_found",
        hint: "Repository not found or not accessible. For private repos, provide a personal access token.",
      }, { status: 404 });
    }
  } catch {}

  // Fetch all probe files using raw.githubusercontent.com (no API rate-limit bucket)
  const [fileResults, hasWorkflows] = await Promise.all([
    Promise.all(PROBE_PATHS.map(async (p) => [p, await fetchFile(owner, repo, defaultBranch, p, githubToken)] as const)),
    listWorkflows(owner, repo, defaultBranch, githubToken),
  ]);

  // Check if any files were accessible
  const fetchedCount = fileResults.filter(([, c]) => c !== null).length;
  if (fetchedCount === 0 && !repoExists) {
    return Response.json({
      error: "repo_not_found",
      hint: "Repository not found or not accessible. For private repos, provide a personal access token.",
    }, { status: 404 });
  }

  const files: Record<string, string> = {};
  for (const [path, content] of fileResults) {
    if (content) files[path] = content;
  }
  if (hasWorkflows) files[".github/workflows"] = "present";

  // Heuristic analysis
  const heuristics = analyzeRepo(files, repo);

  // LLM enrichment (optional — skipped if no API key)
  const llmEnrichment: Partial<StackConfig> = {};
  const apiKey = await resolveApiKey(req);

  if (apiKey) {
    try {
      const client = new Anthropic({ apiKey });

      // Compact file summary for the LLM (stay well under token budget)
      const fileSummary = Object.entries(files)
        .map(([path, content]) => `## ${path}\n${content.slice(0, 2000)}`)
        .join("\n\n")
        .slice(0, 12_000);

      const promptBody = `Heuristic detections:
${JSON.stringify(heuristics.config, null, 2)}

Raw project files:
${fileSummary}

Fill in the missing or uncertain fields. Return ONLY the JSON object.`;

      const message = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: ENRICH_SYSTEM,
        messages: [{ role: "user", content: promptBody }],
      });

      const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
      // Extract JSON from the response (strip any markdown fences)
      const jsonMatch = /\{[\s\S]+\}/.exec(text);
      if (jsonMatch) {
        const enriched = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        // Only accept non-null values that aren't already high-confidence heuristics
        for (const [k, v] of Object.entries(enriched)) {
          const key = k as keyof StackConfig;
          if (v !== null && heuristics.confidence[key] !== "high") {
            (llmEnrichment as Record<string, unknown>)[k] = v;
          }
        }
      }
    } catch {
      // LLM enrichment is best-effort; don't fail the request
    }
  }

  // Merge: heuristics win on high-confidence fields; LLM fills gaps
  const mergedConfig: Partial<StackConfig> = {
    ...llmEnrichment,
    ...heuristics.config,
  };

  return Response.json({
    repo: { owner, repo, defaultBranch },
    config: mergedConfig,
    signals: heuristics.signals,
    confidence: {
      ...heuristics.confidence,
      // Flag LLM-sourced fields as medium confidence if not already set
      ...Object.fromEntries(
        Object.keys(llmEnrichment)
          .filter((k) => !heuristics.confidence[k as keyof StackConfig])
          .map((k) => [k, "medium" as const])
      ),
    },
    enrichedByLLM: Object.keys(llmEnrichment).length > 0,
    filesAnalyzed: Object.keys(files).length,
  });
}

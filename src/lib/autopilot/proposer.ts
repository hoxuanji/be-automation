import Anthropic from "@anthropic-ai/sdk";
import type {
  Audit,
  Finding,
  PrProposal,
  FileChange,
} from "./schema";
import { prProposalSchema } from "./schema";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Helios Autopilot — a senior platform engineer that drafts pull requests for real repositories.

You will be given:
- A static audit of a GitHub repository (detected stack, existing files, gaps)
- A subset of findings the user selected to fix in this PR
- The current contents of any files that would be modified

Your job: call the propose_pr tool EXACTLY ONCE with a coherent pull request that addresses the selected findings. The PR should feel like it came from a thoughtful staff engineer, not a linter bot.

Rules:
- Produce full, correct, production-ready file contents. No placeholders. No TODOs.
- Match the detected stack. If the repo is Go + gin, don't hand them a Node Dockerfile.
- Use distroless or slim bases. Multi-stage builds. Non-root user.
- CI should be minimal but real: install, lint (if a linter is configured), test, build.
- Dependabot config: weekly schedule, group minor/patch updates, label PRs.
- README updates should preserve existing content if there is any; append or enhance.
- LICENSE should be MIT with the current year and the owner's name.
- Keep the PR body punchy: 3-6 bullets. Mention the impact of each change.
- Use conventional-commit style titles: "ci:", "docs:", "build:", "chore:", etc.
- Branch name: "helios/autopilot-<short-slug>" (kebab case, <40 chars).

Every change must include a short summary (one line) explaining what it does and why.`;

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_pr",
  description: "Submit the final pull request proposal. Call exactly once.",
  input_schema: {
    type: "object",
    required: ["title", "body", "branch", "changes"],
    properties: {
      title: { type: "string", maxLength: 72 },
      body: { type: "string", maxLength: 4000 },
      branch: { type: "string", maxLength: 60 },
      changes: {
        type: "array",
        minItems: 1,
        maxItems: 25,
        items: {
          type: "object",
          required: ["path", "action", "content", "summary"],
          properties: {
            path: { type: "string" },
            action: { type: "string", enum: ["create", "update"] },
            content: { type: "string" },
            summary: { type: "string", maxLength: 200 },
          },
        },
      },
    },
  },
};

export type ProposerContext = {
  audit: Audit;
  findings: Finding[];
  /** Existing file contents for any file any finding wants to modify. */
  existingFiles: Record<string, string>;
};

export async function proposePr(ctx: ProposerContext): Promise<PrProposal> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const client = new Anthropic();

  const userBrief = renderBrief(ctx);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [PROPOSE_TOOL],
    tool_choice: { type: "tool", name: "propose_pr" },
    messages: [{ role: "user", content: userBrief }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (!toolUse) throw new Error("Model did not produce a PR proposal.");

  const parsed = prProposalSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    throw new Error(
      "PR proposal failed validation: " +
        JSON.stringify(parsed.error.flatten())
    );
  }
  return normalize(parsed.data);
}

function normalize(p: PrProposal): PrProposal {
  return {
    ...p,
    branch: p.branch
      .toLowerCase()
      .replace(/[^a-z0-9/_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "helios/autopilot",
    changes: p.changes.map((c: FileChange) => ({
      ...c,
      path: c.path.replace(/^\/+/, ""),
    })),
  };
}

function renderBrief(ctx: ProposerContext): string {
  const { audit, findings, existingFiles } = ctx;
  const lines: string[] = [];
  lines.push(`# Repo: ${audit.repo.owner}/${audit.repo.name}`);
  if (audit.repo.description) lines.push(`> ${audit.repo.description}`);
  lines.push("");
  lines.push("## Detected stack");
  lines.push("```json");
  lines.push(JSON.stringify(audit.stack, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Findings to fix in this PR");
  for (const f of findings) {
    lines.push(`- **${f.title}** (${f.severity}, ${f.category})`);
    lines.push(`  ${f.description}`);
    lines.push(`  Impact: ${f.impact}`);
    for (const pf of f.proposedFiles) {
      lines.push(`  - \`${pf.path}\` (${pf.action}) — ${pf.reason}`);
    }
  }
  lines.push("");
  if (Object.keys(existingFiles).length) {
    lines.push("## Existing file contents (verbatim)");
    for (const [path, content] of Object.entries(existingFiles)) {
      lines.push(`### \`${path}\``);
      lines.push("```");
      lines.push(content.slice(0, 4000));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

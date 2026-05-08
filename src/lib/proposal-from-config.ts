import type { StackConfig } from "@/lib/generators/types";
import type { ArchitectureProposal, Decision } from "@/lib/architect-schema";

/**
 * Build a minimal, valid ArchitectureProposal from a StackConfig — used when
 * the user reaches the publish/preview surface without going through the AI
 * architect (e.g. they configured manually in /builder).
 *
 * Predictions are simple heuristics. Decisions are synthesized one-liners
 * marked as user-configured. The intent is to keep the public /show page
 * useful even for manual configurations.
 */
export function proposalFromConfig(config: StackConfig): ArchitectureProposal {
  const decisions: Decision[] = [
    {
      topic: "language",
      choice: config.language,
      reasoning: `Backend implemented in ${config.language} with the ${config.framework} framework.`,
    },
    {
      topic: "database",
      choice: config.database,
      reasoning: `Primary datastore: ${config.database}.`,
    },
    {
      topic: "cache",
      choice: config.cache,
      reasoning: `Cache layer: ${config.cache}, used for hot reads and session storage.`,
    },
    {
      topic: "queue",
      choice: config.queue,
      reasoning: `Async + event work routed through ${config.queue}.`,
    },
    {
      topic: "api",
      choice: config.api,
      reasoning: `Primary transport: ${config.api.toUpperCase()}.`,
    },
    {
      topic: "auth",
      choice: config.auth,
      reasoning: `Identity managed by ${config.auth}.`,
    },
    {
      topic: "deployment",
      choice: config.deployment,
      reasoning: `Deployed to ${config.deployment} in ${config.region} with ${config.replicas} baseline replica${config.replicas === 1 ? "" : "s"}.`,
      tradeoff: config.kubernetes
        ? "Kubernetes adds operational complexity in exchange for portability."
        : undefined,
    },
    ...(config.audit || config.tracing || config.rateLimit
      ? [
          {
            topic: "security" as const,
            choice: [
              config.audit ? "audit logs" : null,
              config.tracing ? "tracing" : null,
              config.rateLimit ? "rate limiting" : null,
            ]
              .filter(Boolean)
              .join(" + "),
            reasoning: "Production security defaults enabled.",
          },
        ]
      : []),
  ];

  const replicas = Math.max(1, config.replicas);
  const baselineCost = 38 * replicas;
  const k8sOverhead = config.kubernetes ? 80 : 0;
  const monthlyCostUsd = Math.round(baselineCost * (config.autoscale ? 1.1 : 1) + k8sOverhead + 42);

  const compliance: string[] = [];
  if (config.audit) compliance.push("Audit-ready");
  if (config.tracing) compliance.push("Observability");
  if (config.deployment !== "k8s") compliance.push("Managed runtime");

  return {
    summary: `${config.name} — ${config.language} on ${config.framework}, backed by ${config.database} and ${config.cache}, deployed to ${config.deployment}.`,
    decisions,
    config,
    predictions: {
      monthlyCostUsd,
      p99LatencyMs: 40 + (replicas < 3 ? 15 : 0),
      maxRpsPerReplica: 1200,
      vendorLockInScore: lockInScore(config),
      compliance,
    },
  };
}

function lockInScore(config: StackConfig): number {
  // Higher = more locked in to a single vendor.
  let score = 0;
  if (["aws", "gcp", "azure"].includes(config.deployment)) score += 4;
  if (["dynamodb", "cognito"].includes(config.database)) score += 2;
  if (["dynamodb", "sqs", "cognito"].includes(config.auth)) score += 1;
  if (["sqs"].includes(config.queue)) score += 1;
  if (["firebase", "cognito"].includes(config.auth)) score += 1;
  if (config.deployment === "k8s") score = Math.max(score - 2, 0); // portable
  return Math.min(score, 10);
}

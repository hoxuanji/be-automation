import { z } from "zod";
import { stackConfigSchema } from "@/lib/schema";

export const architectRequestSchema = z.object({
  intent: z.string().min(8).max(2000),
});

export type ArchitectRequest = z.infer<typeof architectRequestSchema>;

export const decisionSchema = z.object({
  topic: z.enum([
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
  ]),
  choice: z.string(),
  reasoning: z.string(),
  tradeoff: z.string().optional(),
});

export const predictionsSchema = z.object({
  monthlyCostUsd: z.number().nonnegative(),
  p99LatencyMs: z.number().nonnegative(),
  maxRpsPerReplica: z.number().nonnegative(),
  vendorLockInScore: z.number().min(0).max(10),
  compliance: z.array(z.string()),
});

export const architectureProposalSchema = z.object({
  summary: z.string().max(600),
  decisions: z.array(decisionSchema).min(0).max(20),
  config: stackConfigSchema,
  predictions: predictionsSchema,
});

export type Decision = z.infer<typeof decisionSchema>;
export type ArchitectureProposal = z.infer<typeof architectureProposalSchema>;
export type Predictions = z.infer<typeof predictionsSchema>;

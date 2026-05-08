import { z } from "zod";

export const repoRefSchema = z.object({
  owner: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9-]+$/, "invalid owner"),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, "invalid repo name"),
});

export const githubTokenSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^(ghp_|github_pat_|gho_)/, "looks wrong — expected a GitHub PAT");

export const analyzeRequestSchema = z.object({
  token: githubTokenSchema,
  repo: repoRefSchema,
});

export const severitySchema = z.enum(["info", "warning", "critical"]);
export const categorySchema = z.enum([
  "security",
  "ops",
  "quality",
  "cost",
  "docs",
]);

export const findingSchema = z.object({
  id: z.string(),
  severity: severitySchema,
  category: categorySchema,
  title: z.string(),
  description: z.string(),
  impact: z.string(),
  proposedFiles: z.array(
    z.object({
      path: z.string(),
      action: z.enum(["create", "update"]),
      reason: z.string(),
    })
  ),
});

export const detectedStackSchema = z.object({
  language: z
    .enum(["go", "typescript", "javascript", "python", "rust", "java", "kotlin", "unknown"])
    .default("unknown"),
  framework: z.string().optional(),
  packageManager: z
    .enum(["npm", "pnpm", "yarn", "bun", "cargo", "pip", "poetry", "go", "maven", "gradle", "unknown"])
    .default("unknown"),
  nodeVersion: z.string().optional(),
  goVersion: z.string().optional(),
  pythonVersion: z.string().optional(),
  hasDockerfile: z.boolean(),
  hasCI: z.boolean(),
  hasTests: z.boolean(),
  hasReadme: z.boolean(),
  hasLicense: z.boolean(),
  hasEnvExample: z.boolean(),
  hasGitignore: z.boolean(),
  hasDependabot: z.boolean(),
});

export const auditSchema = z.object({
  repo: z.object({
    owner: z.string(),
    name: z.string(),
    defaultBranch: z.string(),
    stars: z.number(),
    description: z.string().nullable(),
    htmlUrl: z.string().url(),
  }),
  stack: detectedStackSchema,
  findings: z.array(findingSchema),
  score: z.number().min(0).max(100),
});

export type RepoRef = z.infer<typeof repoRefSchema>;
export type DetectedStack = z.infer<typeof detectedStackSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Audit = z.infer<typeof auditSchema>;

export const proposeRequestSchema = z.object({
  token: githubTokenSchema,
  repo: repoRefSchema,
  audit: auditSchema,
  findingIds: z.array(z.string()).min(1).max(10),
});

export const fileChangeSchema = z.object({
  path: z.string(),
  action: z.enum(["create", "update"]),
  content: z.string(),
  summary: z.string(),
});

export const prProposalSchema = z.object({
  title: z.string(),
  body: z.string(),
  branch: z.string(),
  changes: z.array(fileChangeSchema).min(1).max(25),
});

export type FileChange = z.infer<typeof fileChangeSchema>;
export type PrProposal = z.infer<typeof prProposalSchema>;

export const openPrRequestSchema = z.object({
  token: githubTokenSchema,
  repo: repoRefSchema,
  baseBranch: z.string(),
  proposal: prProposalSchema,
});

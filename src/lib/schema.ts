import { z } from "zod";

export const envVarSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().optional(),
});

export const stackConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "lowercase letters, digits, - or _ only"),
  language: z.enum([
    "go",
    "typescript",
    "python",
    "rust",
    "java",
    "kotlin",
  ]),
  framework: z.string(),
  database: z.string(),
  cache: z.string(),
  queue: z.string(),
  api: z.enum(["rest", "grpc", "graphql", "trpc"]),
  auth: z.string(),
  deployment: z.string(),
  scaling: z.string(),
  monitoring: z.string(),
  cicd: z.string(),
  docker: z.boolean(),
  kubernetes: z.boolean(),
  helm: z.boolean(),
  tracing: z.boolean(),
  rateLimit: z.boolean(),
  audit: z.boolean(),
  autoscale: z.boolean(),
  replicas: z.number().int().min(1).max(64),
  region: z.string(),
  envVars: z.array(envVarSchema).max(64),
});

export const endpointSchema = z.object({
  id: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\//, "path must start with /"),
  summary: z.string().max(200),
  auth: z.boolean(),
  requestSchema: z.string().optional(),
  responseSchema: z.string().optional(),
});

export const generateRequestSchema = z.object({
  config: stackConfigSchema,
  endpoints: z.array(endpointSchema).max(200),
});

export const aiChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(20),
  config: stackConfigSchema.optional(),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

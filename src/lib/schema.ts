import { z } from "zod";

export const envVarSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  secret: z.boolean().optional(),
});

export const fieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "uuid",
  "json",
]);

export const entityFieldSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "must start with a letter"),
  type: fieldTypeSchema,
  required: z.boolean(),
  unique: z.boolean(),
  primaryKey: z.boolean().optional(),
});

export const entitySchema = z.object({
  id: z.string(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][a-zA-Z0-9]*$/, "must be PascalCase"),
  fields: z.array(entityFieldSchema).min(1).max(32),
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
  entities: z.array(entitySchema).max(50).optional(),
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

export const aiSuggestRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
});

// ─── Auth schemas ─────────────────────────────────────────────────────────────

export const signupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(64),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

export const updateSettingsSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).max(128).optional(),
  apiKey: z.string().max(200).optional().nullable(),
});

// ─── Project API schema ───────────────────────────────────────────────────────

export const relationSchema = z.object({
  id: z.string(),
  fromEntity: z.string(),
  toEntity: z.string(),
  type: z.enum(["one-to-many", "many-to-many", "one-to-one"]),
  label: z.string().optional(),
});

export const projectPayloadSchema = z.object({
  name: z.string().min(1).max(128),
  data: z.object({
    config: stackConfigSchema,
    endpoints: z.array(endpointSchema).max(200),
    entities: z.array(entitySchema).max(50).optional(),
    relations: z.array(relationSchema).max(200).optional(),
  }),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;
export type AiSuggestRequest = z.infer<typeof aiSuggestRequestSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type EntityField = z.infer<typeof entityFieldSchema>;

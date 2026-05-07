"use client";

import { create } from "zustand";

export type StackConfig = {
  name: string;
  language: string;
  framework: string;
  database: string;
  cache: string;
  queue: string;
  api: "rest" | "grpc" | "graphql" | "trpc";
  auth: string;
  deployment: string;
  scaling: string;
  monitoring: string;
  cicd: string;
  docker: boolean;
  kubernetes: boolean;
  helm: boolean;
  tracing: boolean;
  rateLimit: boolean;
  audit: boolean;
  autoscale: boolean;
  replicas: number;
  region: string;
  envVars: { key: string; value: string; secret?: boolean }[];
};

export type Endpoint = {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  auth: boolean;
  requestSchema?: string;
  responseSchema?: string;
};

type State = {
  config: StackConfig;
  endpoints: Endpoint[];
  workspace: string;
  workspaces: string[];
  setWorkspace: (w: string) => void;
  set: <K extends keyof StackConfig>(k: K, v: StackConfig[K]) => void;
  patch: (p: Partial<StackConfig>) => void;
  addEndpoint: (e: Endpoint) => void;
  removeEndpoint: (id: string) => void;
  updateEndpoint: (id: string, e: Partial<Endpoint>) => void;
  addEnvVar: (v: { key: string; value: string; secret?: boolean }) => void;
  removeEnvVar: (key: string) => void;
  applyProposal: (config: StackConfig) => void;
  lastProposalAt?: string;
};

const initialEndpoints: Endpoint[] = [
  {
    id: "e1",
    method: "GET",
    path: "/users/:id",
    summary: "Get a user by ID",
    auth: true,
    requestSchema: "UserIdParams",
    responseSchema: "User",
  },
  {
    id: "e2",
    method: "POST",
    path: "/users",
    summary: "Create a new user",
    auth: false,
    requestSchema: "CreateUserInput",
    responseSchema: "User",
  },
  {
    id: "e3",
    method: "POST",
    path: "/auth/login",
    summary: "Login and issue JWT",
    auth: false,
    requestSchema: "LoginInput",
    responseSchema: "AuthToken",
  },
  {
    id: "e4",
    method: "GET",
    path: "/health",
    summary: "Liveness probe",
    auth: false,
    responseSchema: "HealthStatus",
  },
];

export const useStackStore = create<State>((set) => ({
  workspace: "Acme Co.",
  workspaces: ["Acme Co.", "Helios Labs", "Personal"],
  setWorkspace: (w) => set({ workspace: w }),
  config: {
    name: "helios-api",
    language: "go",
    framework: "gin",
    database: "postgres",
    cache: "redis",
    queue: "rabbitmq",
    api: "rest",
    auth: "clerk",
    deployment: "railway",
    scaling: "horizontal",
    monitoring: "grafana",
    cicd: "gh-actions",
    docker: true,
    kubernetes: true,
    helm: false,
    tracing: true,
    rateLimit: true,
    audit: false,
    autoscale: true,
    replicas: 3,
    region: "us-east-1",
    envVars: [
      { key: "DATABASE_URL", value: "postgres://user:pass@db:5432/helios", secret: true },
      { key: "REDIS_URL", value: "redis://cache:6379" },
      { key: "JWT_SECRET", value: "••••••••••••••••", secret: true },
      { key: "LOG_LEVEL", value: "info" },
    ],
  },
  endpoints: initialEndpoints,
  set: (k, v) =>
    set((s) => ({ config: { ...s.config, [k]: v } })),
  patch: (p) => set((s) => ({ config: { ...s.config, ...p } })),
  addEndpoint: (e) => set((s) => ({ endpoints: [...s.endpoints, e] })),
  removeEndpoint: (id) =>
    set((s) => ({ endpoints: s.endpoints.filter((e) => e.id !== id) })),
  updateEndpoint: (id, patch) =>
    set((s) => ({
      endpoints: s.endpoints.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  addEnvVar: (v) =>
    set((s) => ({
      config: {
        ...s.config,
        envVars: [...s.config.envVars.filter((x) => x.key !== v.key), v],
      },
    })),
  removeEnvVar: (key) =>
    set((s) => ({
      config: {
        ...s.config,
        envVars: s.config.envVars.filter((v) => v.key !== key),
      },
    })),
  applyProposal: (config) =>
    set(() => ({
      config,
      lastProposalAt: new Date().toISOString(),
    })),
}));

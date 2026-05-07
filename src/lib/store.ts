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

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "uuid"
  | "json";

export type EntityField = {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  primaryKey?: boolean;
};

export type Entity = {
  id: string;
  name: string;
  fields: EntityField[];
};

export type SavedProject = {
  id: string;
  name: string;
  savedAt: string;
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
};

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  hasApiKey: boolean;
};

const STORAGE_KEY = "helios:projects";

function readStoredProjects(): SavedProject[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as SavedProject[];
  } catch {
    return [];
  }
}

function writeStoredProjects(projects: SavedProject[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // quota exceeded or private browsing
  }
}

type State = {
  config: StackConfig;
  endpoints: Endpoint[];
  entities: Entity[];
  workspace: string;
  workspaces: string[];
  savedProjects: SavedProject[];
  authUser: AuthUser | null;

  // Config mutations
  setWorkspace: (w: string) => void;
  set: <K extends keyof StackConfig>(k: K, v: StackConfig[K]) => void;
  patch: (p: Partial<StackConfig>) => void;

  // Endpoint mutations
  setEndpoints: (endpoints: Endpoint[]) => void;
  addEndpoint: (e: Endpoint) => void;
  removeEndpoint: (id: string) => void;
  updateEndpoint: (id: string, e: Partial<Endpoint>) => void;

  // Env var mutations
  addEnvVar: (v: { key: string; value: string; secret?: boolean }) => void;
  removeEnvVar: (key: string) => void;

  // Entity mutations
  setEntities: (entities: Entity[]) => void;
  addEntity: (entity: Entity) => void;
  removeEntity: (id: string) => void;
  updateEntity: (id: string, updates: Partial<Omit<Entity, "id" | "fields">>) => void;
  addEntityField: (entityId: string, field: EntityField) => void;
  removeEntityField: (entityId: string, fieldId: string) => void;
  updateEntityField: (
    entityId: string,
    fieldId: string,
    updates: Partial<EntityField>
  ) => void;

  // Auth
  loadAuth: () => Promise<void>;
  logout: () => Promise<void>;

  // Project persistence
  loadSavedProjects: () => Promise<void>;
  saveCurrentProject: () => Promise<void>;
  loadProject: (id: string) => void;
  deleteProject: (id: string) => Promise<void>;
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

const initialEntities: Entity[] = [
  {
    id: "entity-1",
    name: "User",
    fields: [
      { id: "f1-1", name: "id", type: "uuid", required: true, unique: true, primaryKey: true },
      { id: "f1-2", name: "email", type: "string", required: true, unique: true },
      { id: "f1-3", name: "name", type: "string", required: true, unique: false },
      { id: "f1-4", name: "createdAt", type: "date", required: true, unique: false },
    ],
  },
  {
    id: "entity-2",
    name: "Post",
    fields: [
      { id: "f2-1", name: "id", type: "uuid", required: true, unique: true, primaryKey: true },
      { id: "f2-2", name: "title", type: "string", required: true, unique: false },
      { id: "f2-3", name: "body", type: "text", required: true, unique: false },
      { id: "f2-4", name: "published", type: "boolean", required: true, unique: false },
      { id: "f2-5", name: "createdAt", type: "date", required: true, unique: false },
    ],
  },
];

export const useStackStore = create<State>((set, get) => ({
  workspace: "Acme Co.",
  workspaces: ["Acme Co.", "Helios Labs", "Personal"],
  setWorkspace: (w) => set({ workspace: w }),
  savedProjects: [],
  authUser: null,
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
  entities: initialEntities,

  set: (k, v) =>
    set((s) => ({ config: { ...s.config, [k]: v } })),
  patch: (p) => set((s) => ({ config: { ...s.config, ...p } })),

  setEndpoints: (endpoints) => set({ endpoints }),
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

  setEntities: (entities) => set({ entities }),
  addEntity: (entity) =>
    set((s) => ({ entities: [...s.entities, entity] })),
  removeEntity: (id) =>
    set((s) => ({ entities: s.entities.filter((e) => e.id !== id) })),
  updateEntity: (id, updates) =>
    set((s) => ({
      entities: s.entities.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    })),
  addEntityField: (entityId, field) =>
    set((s) => ({
      entities: s.entities.map((e) =>
        e.id === entityId
          ? { ...e, fields: [...e.fields, field] }
          : e
      ),
    })),
  removeEntityField: (entityId, fieldId) =>
    set((s) => ({
      entities: s.entities.map((e) =>
        e.id === entityId
          ? { ...e, fields: e.fields.filter((f) => f.id !== fieldId) }
          : e
      ),
    })),
  updateEntityField: (entityId, fieldId, updates) =>
    set((s) => ({
      entities: s.entities.map((e) =>
        e.id === entityId
          ? {
              ...e,
              fields: e.fields.map((f) =>
                f.id === fieldId ? { ...f, ...updates } : f
              ),
            }
          : e
      ),
    })),

  loadAuth: async () => {
    try {
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      set({ authUser: data.user ?? null });
    } catch {
      set({ authUser: null });
    }
  },

  logout: async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    set({ authUser: null, savedProjects: [] });
    window.location.href = "/login";
  },

  loadSavedProjects: async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        const projects: SavedProject[] = (data.projects ?? []).map(
          (p: {
            id: string;
            name: string;
            savedAt: string;
            config: StackConfig;
            endpoints: Endpoint[];
            entities?: Entity[];
          }) => ({
            id: p.id,
            name: p.name,
            savedAt: p.savedAt,
            config: p.config,
            endpoints: p.endpoints,
            entities: p.entities ?? [],
          })
        );
        set({ savedProjects: projects });
        return;
      }
    } catch {}
    // 401 or network error → fall back to localStorage
    set({ savedProjects: readStoredProjects() });
  },

  saveCurrentProject: async () => {
    const s = get();
    const payload = {
      name: s.config.name,
      data: {
        config: s.config,
        endpoints: s.endpoints,
        entities: s.entities,
      },
    };

    if (s.authUser) {
      const existing = s.savedProjects.find((p) => p.name === s.config.name);
      const url = existing ? `/api/projects/${existing.id}` : "/api/projects";
      const method = existing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Server save failed");
      await get().loadSavedProjects();
      return;
    }

    // localStorage path
    const existing = readStoredProjects();
    const id = `proj-${Date.now()}`;
    const project: SavedProject = {
      id,
      name: s.config.name,
      savedAt: new Date().toISOString(),
      config: s.config,
      endpoints: s.endpoints,
      entities: s.entities,
    };
    const updated = [
      project,
      ...existing.filter((p) => p.name !== s.config.name),
    ].slice(0, 20);
    writeStoredProjects(updated);
    set({ savedProjects: updated });
  },

  loadProject: (id) => {
    const project = get().savedProjects.find((p) => p.id === id);
    if (!project) return;
    set({
      config: project.config,
      endpoints: project.endpoints,
      entities: project.entities,
    });
  },

  deleteProject: async (id) => {
    if (get().authUser) {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      set((s) => ({ savedProjects: s.savedProjects.filter((p) => p.id !== id) }));
      return;
    }
    const updated = readStoredProjects().filter((p) => p.id !== id);
    writeStoredProjects(updated);
    set({ savedProjects: updated });
  },
}));

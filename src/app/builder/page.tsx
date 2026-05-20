"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  Download,
  Loader2,
  Network,
  Rocket,
  Save,
  Scale,
  ShieldCheck,
  Share2,
  Sparkles,
  Terminal,
  Trash2,
  Workflow,
  Zap,
  GitBranch,
  PackageCheck,
  Eye,
  Star,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { SelectableCard } from "@/components/ui/selectable-card";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { ArchitecturePreview } from "@/components/builder/architecture-preview";
import { StackSummary } from "@/components/builder/stack-summary";
import { GitHubConnectPanel } from "@/components/builder/github-connect-panel";
import { NLPrompt } from "@/components/builder/nl-prompt";
import { EntityBuilder } from "@/components/builder/entity-builder";
import { OnboardingWizard } from "@/components/builder/onboarding-wizard";
import { useStackStore } from "@/lib/store";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { BrandIcon } from "@/components/shared/brand-icon";
import {
  authProviders,
  caches,
  cicd,
  databases,
  deployments,
  frameworks,
  languages,
  monitoring,
  queues,
  scalingStrategies,
} from "@/data/stack-options";

function StackUrlLoader() {
  const { patch, setEndpoints, setEntities } = useStackStore();
  const searchParams = useSearchParams();

  React.useEffect(() => {
    const encoded = searchParams.get("stack");
    if (!encoded) return;
    try {
      const decoded = JSON.parse(atob(encoded)) as {
        config?: Partial<import("@/lib/store").StackConfig>;
        endpoints?: import("@/lib/store").Endpoint[];
        entities?: import("@/lib/store").Entity[];
      };
      if (decoded.config) patch(decoded.config);
      if (decoded.endpoints) setEndpoints(decoded.endpoints);
      if (decoded.entities) setEntities(decoded.entities);
      window.history.replaceState({}, "", "/builder");
    } catch {
      // Malformed share link — silently ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function MyProjectsMenu() {
  const { savedProjects, loadProject, loadSavedProjects } = useStackStore();
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState("");
  const [projects, setProjects] = React.useState(savedProjects);

  React.useEffect(() => {
    void loadSavedProjects();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => { setProjects(savedProjects); }, [savedProjects]);

  async function handleRename(id: string) {
    const name = renameVal.trim();
    if (!name) return;
    try {
      await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, name } : p));
      toast({ title: "Renamed", kind: "success" });
    } catch {
      toast({ title: "Rename failed", kind: "error" });
    }
    setRenamingId(null);
  }

  async function handleDelete(id: string, name: string) {
    try {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast({ title: `"${name}" deleted`, kind: "success" });
    } catch {
      toast({ title: "Delete failed", kind: "error" });
    }
  }

  if (projects.length === 0) return null;

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <Button variant="ghost" size="sm">
          <Star className="h-3.5 w-3.5" />
          Projects
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownTrigger>
      <DropdownContent align="end" className="w-64">
        <DropdownLabel>Saved projects</DropdownLabel>
        <DropdownSeparator />
        {projects.slice(0, 10).map((p) => (
          <div key={p.id} className="px-1 py-0.5">
            {renamingId === p.id ? (
              <div className="flex gap-1 px-2 py-1">
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleRename(p.id); if (e.key === "Escape") setRenamingId(null); }}
                  className="flex-1 bg-white/[0.04] border border-white/[0.1] rounded px-2 py-1 text-xs focus:outline-none"
                />
                <button onClick={() => void handleRename(p.id)} className="text-xs text-brand-300 hover:text-brand-200 px-1">Save</button>
              </div>
            ) : (
              <div className="flex items-center gap-1 group rounded px-2 py-1.5 hover:bg-white/[0.04]">
                <button
                  className="flex-1 text-left"
                  onClick={() => { loadProject(p.id); toast({ title: `Loaded "${p.name}"`, kind: "success" }); }}
                >
                  <div className="text-xs font-medium">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground">{new Date(p.savedAt).toLocaleDateString()} · {p.endpoints.length} endpoints</div>
                </button>
                <button
                  onClick={() => { setRenamingId(p.id); setRenameVal(p.name); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity p-0.5"
                  title="Rename"
                >
                  <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5A2 2 0 016.5 15.5h-2a.5.5 0 01-.5-.5v-2a2 2 0 01.586-1.414l8.5-8.5z"/></svg>
                </button>
                <button
                  onClick={() => void handleDelete(p.id, p.name)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-opacity p-0.5"
                  title="Delete"
                >
                  <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2a1 1 0 000 2h4a1 1 0 100-2H6zM2 5a1 1 0 011-1h10a1 1 0 110 2H3a1 1 0 01-1-1zM4 8a1 1 0 012 0v5a1 1 0 01-2 0V8zm6 0a1 1 0 012 0v5a1 1 0 01-2 0V8z"/></svg>
                </button>
              </div>
            )}
          </div>
        ))}
      </DropdownContent>
    </Dropdown>
  );
}

const TABS = [
  { id: "runtime",    label: "Runtime",    icon: Cpu },
  { id: "database",   label: "Database",   icon: Database },
  { id: "cache",      label: "Cache",      icon: Zap },
  { id: "queue",      label: "Queue",      icon: Workflow },
  { id: "api",        label: "APIs",       icon: Network },
  { id: "security",   label: "Security",   icon: ShieldCheck },
  { id: "deploy",     label: "Deployment", icon: Rocket },
  { id: "scaling",    label: "Scaling",    icon: Scale },
  { id: "cicd",       label: "CI/CD",      icon: GitBranch },
  { id: "monitoring", label: "Monitoring", icon: Terminal },
];

export default function BuilderPage() {
  const { config, gitConfig, endpoints, entities, set, saveCurrentProject } = useStackStore();
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState("runtime");

  const saveRef = React.useRef(saveCurrentProject);
  React.useEffect(() => { saveRef.current = saveCurrentProject; });
  // Auto-save on unmount
  React.useEffect(() => {
    return () => { void saveRef.current().catch(() => {}); };
  }, []);
  // Debounced auto-save: fire 2s after any config/endpoint/entity change
  React.useEffect(() => {
    const timer = setTimeout(() => {
      void saveRef.current().catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [config, endpoints, entities]);

  async function saveStack(silent = false) {
    setSaving(true);
    try {
      await saveCurrentProject();
      if (!silent) {
        toast({
          title: "Project saved",
          description: `${config.name} · ${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} · ${entities.length} model${entities.length === 1 ? "" : "s"}`,
          kind: "success",
        });
      }
    } catch {
      if (!silent) toast({ title: "Couldn't save", kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function downloadRepo() {
    setDownloading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, endpoints, entities, gitConfig }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${config.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: `${config.name}.zip downloaded`, kind: "success" });
    } catch {
      toast({ title: "Download failed", kind: "error" });
    } finally {
      setDownloading(false);
    }
  }

  async function previewRepo() {
    await saveStack(true);
    router.push("/preview");
  }

  function shareStack() {
    try {
      const payload = btoa(JSON.stringify({ config, endpoints, entities }));
      const url = `${window.location.origin}/builder?stack=${payload}`;
      void navigator.clipboard.writeText(url).then(() => {
        toast({ title: "Share link copied", description: "Send this URL to load your exact stack configuration.", kind: "success" });
      });
    } catch {
      toast({ title: "Couldn't copy link", kind: "error" });
    }
  }

  return (
    <>
    <OnboardingWizard />
    <React.Suspense fallback={null}><StackUrlLoader /></React.Suspense>
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: config.name },
        { label: "Builder" },
      ]}
      actions={
        <>
          <MyProjectsMenu />
          <Button variant="ghost" size="sm" onClick={shareStack}>
            <Share2 className="h-3.5 w-3.5" /> Share
          </Button>
          <Button variant="ghost" size="sm" onClick={() => saveStack()} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" size="sm" onClick={downloadRepo} disabled={downloading}>
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {downloading ? "Building…" : "Download"}
          </Button>
          <Button variant="secondary" size="sm" onClick={previewRepo} disabled={saving}>
            <Eye className="h-3.5 w-3.5" /> Review &amp; Download
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[1200px] p-6 md:p-8 space-y-6">
        <BuilderHeader />

        <NLPrompt />

        <ArchitecturePreview />

        <QuickStart />

        <div className="grid gap-6 lg:grid-cols-[1fr,320px]">
          <div className="min-w-0 space-y-4">
            <div className="flex overflow-x-auto no-scrollbar border-b border-white/[0.06]">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-xs font-medium transition-colors",
                    activeTab === tab.id
                      ? "border-brand-400 text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  <tab.icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "runtime" && <RuntimePanel />}
            {activeTab === "database" && (
              <OptionPanel
                title="Database"
                description="Pick your primary datastore. Helios will generate migrations, typed clients, and connection pooling for you."
                options={databases}
                selected={config.database}
                onSelect={(id) => set("database", id)}
                icon={<Database className="h-4 w-4" />}
              />
            )}
            {activeTab === "cache" && (
              <OptionPanel
                title="Cache"
                description="Accelerate hot paths — sessions, rate limiting, pub/sub."
                options={caches}
                selected={config.cache}
                onSelect={(id) => set("cache", id)}
                icon={<Zap className="h-4 w-4" />}
              />
            )}
            {activeTab === "queue" && (
              <OptionPanel
                title="Message Queue"
                description="Decouple services with durable messaging, pub/sub or streaming."
                options={queues}
                selected={config.queue}
                onSelect={(id) => set("queue", id)}
                icon={<Workflow className="h-4 w-4" />}
              />
            )}
            {activeTab === "api" && (
              <div className="space-y-6">
                {config.language === "python" &&
                  (config.framework === "django" || config.framework === "litestar") &&
                  entities.length > 0 && (
                  <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs">
                    <span className="text-amber-400 mt-0.5">⚠</span>
                    <div>
                      <span className="font-medium text-amber-300">Full CRUD generation is FastAPI-only right now.</span>
                      <span className="text-amber-300/70 ml-1">
                        {config.framework === "django" ? "Django" : "Litestar"} will generate models but no route handlers. Switch to FastAPI for complete output.
                      </span>
                    </div>
                  </div>
                )}
                <EntityBuilder />
                <ApiPanel />
              </div>
            )}
            {activeTab === "security" && <SecurityPanel />}
            {activeTab === "deploy" && (
              <OptionPanel
                title="Deployment target"
                description="Where should Helios ship this stack? One-click deploy included."
                options={deployments}
                selected={config.deployment}
                onSelect={(id) => set("deployment", id)}
                icon={<Rocket className="h-4 w-4" />}
              />
            )}
            {activeTab === "scaling" && <ScalingPanel />}
            {activeTab === "cicd" && (
              <div className="space-y-4">
                <OptionPanel
                  title="CI / CD"
                  description="Pipeline generated with security scans, matrix tests, and preview deploys."
                  options={cicd}
                  selected={config.cicd}
                  onSelect={(id) => set("cicd", id)}
                  icon={<GitBranch className="h-4 w-4" />}
                />
                {config.cicd === "gh-actions" && <GitHubConnectPanel />}
                <a
                  href="/git-settings"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-brand-300 transition-colors"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  Configure branch rules & PR strategy →
                </a>
              </div>
            )}
            {activeTab === "monitoring" && (
              <OptionPanel
                title="Monitoring"
                description="Traces, metrics, logs — wired in with sensible defaults."
                options={monitoring}
                selected={config.monitoring}
                onSelect={(id) => set("monitoring", id)}
                icon={<Terminal className="h-4 w-4" />}
              />
            )}
          </div>

          <div className="space-y-4">
            <CompletenessCard />
            <StackSummary />
            <RecommendationsCard />
            <ResourceUtilizationCard />
          </div>
        </div>

        <GenerateCTA />
      </div>
    </WorkspaceShell>
    </>
  );
}

const QUICK_LANGUAGES = [
  { id: "go", label: "Go", accent: "#00ADD8" },
  { id: "typescript", label: "TypeScript", accent: "#3178C6" },
  { id: "python", label: "Python", accent: "#3776AB" },
  { id: "rust", label: "Rust", accent: "#DEA584" },
] as const;

const QUICK_DATABASES = [
  { id: "postgres", label: "Postgres" },
  { id: "mongodb", label: "MongoDB" },
  { id: "mysql", label: "MySQL" },
  { id: "sqlite", label: "SQLite" },
] as const;

function QuickStart() {
  const { config, set, patch } = useStackStore();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(config.name);

  function go() {
    patch({ name: name || config.name });
    router.push("/preview");
  }

  return (
    <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2.5">
          <Sparkles className="h-4 w-4 text-brand-400" />
          <div>
            <span className="text-sm font-semibold">Quick start</span>
            <span className="ml-2 text-xs text-muted-foreground">name + language + database → preview in one click</span>
          </div>
        </div>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-brand-500/10 px-4 py-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground font-medium">Project name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-api"
                className="text-sm h-8"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground font-medium">Language</label>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_LANGUAGES.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => set("language", l.id as import("@/lib/store").StackConfig["language"])}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      config.language === l.id
                        ? "border-brand-500/50 bg-brand-500/10 text-foreground"
                        : "border-white/[0.08] text-muted-foreground hover:text-foreground hover:border-white/[0.15]"
                    )}
                    style={config.language === l.id ? { color: l.accent } : {}}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground font-medium">Database</label>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_DATABASES.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => set("database", d.id)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                      config.database === d.id
                        ? "border-brand-500/50 bg-brand-500/10 text-brand-300"
                        : "border-white/[0.08] text-muted-foreground hover:text-foreground hover:border-white/[0.15]"
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Button variant="glow" size="sm" onClick={go}>
            <Eye className="h-3.5 w-3.5" /> Preview & download
          </Button>
        </div>
      )}
    </div>
  );
}

function CompletenessCard() {
  const { config, endpoints } = useStackStore();

  const checks = [
    { label: "Language & framework", done: !!config.language && !!config.framework },
    { label: "Database", done: !!config.database && config.database !== "none" },
    { label: "Auth provider", done: !!config.auth && config.auth !== "none" },
    { label: "API endpoints", done: endpoints.length > 0 },
    { label: "Deployment target", done: !!config.deployment && config.deployment !== "none" },
    { label: "CI/CD pipeline", done: !!config.cicd && config.cicd !== "none" },
  ];

  const done = checks.filter((c) => c.done).length;
  const pct = Math.round((done / checks.length) * 100);

  return (
    <Card>
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Stack completeness</span>
          <span className="text-xs font-mono text-muted-foreground">{done}/{checks.length}</span>
        </div>
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-purple-500 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="space-y-1.5">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-[11px]">
              {c.done ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : (
                <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/[0.12]" />
              )}
              <span className={c.done ? "text-foreground/80" : "text-muted-foreground"}>{c.label}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function BuilderHeader() {
  const { config, patch, workspace, workspaces, setWorkspace } = useStackStore();

  function forkTemplate() {
    const base = config.name.replace(/-fork(-[a-z0-9]+)?$/, "");
    patch({ name: `${base}-fork-${Math.random().toString(36).slice(2, 6)}` });
  }

  function recommendStack() {
    const byLang: Record<string, Partial<typeof config>> = {
      go: { framework: "gin", database: "postgres", cache: "redis", queue: "nats", api: "rest" },
      typescript: { framework: "nestjs", database: "postgres", cache: "redis", queue: "bullmq", api: "rest" },
      python: { framework: "fastapi", database: "postgres", cache: "redis", queue: "rabbitmq", api: "rest" },
      rust: { framework: "axum", database: "postgres", cache: "redis", queue: "nats", api: "rest" },
      java: { framework: "spring", database: "postgres", cache: "redis", queue: "kafka", api: "rest" },
      kotlin: { framework: "ktor", database: "postgres", cache: "redis", queue: "kafka", api: "rest" },
    };
    patch({
      ...(byLang[config.language] ?? {}),
      auth: "clerk",
      deployment: "railway",
      scaling: "horizontal",
      monitoring: "grafana",
      cicd: "gh-actions",
      docker: true,
      kubernetes: true,
      tracing: true,
      rateLimit: true,
      audit: true,
      autoscale: true,
      replicas: Math.max(config.replicas, 3),
    });
  }

  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="brand">
            <Sparkles className="h-3 w-3" /> AI-assisted
          </Badge>
          <Badge variant="outline">Draft</Badge>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Input
            value={config.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="max-w-sm text-lg h-11 font-semibold bg-transparent border-white/10"
          />
          <Dropdown>
            <DropdownTrigger>
              <Button variant="ghost" size="sm">
                <ChevronDown className="h-3.5 w-3.5" />
                {workspace}
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownLabel>Workspaces</DropdownLabel>
              {workspaces.map((w) => (
                <DropdownItem
                  key={w}
                  onSelect={() => setWorkspace(w)}
                  className={
                    workspace === w
                      ? "bg-white/[0.04] text-foreground"
                      : undefined
                  }
                >
                  <span className="h-5 w-5 rounded-md bg-gradient-to-br from-brand-500 to-purple-500 grid place-items-center text-[9px] font-semibold text-white">
                    {w.slice(0, 2).toUpperCase()}
                  </span>
                  {w}
                  {workspace === w ? (
                    <span className="ml-auto text-[10px] text-brand-300">
                      current
                    </span>
                  ) : null}
                </DropdownItem>
              ))}
              <DropdownSeparator />
              <DropdownItem onSelect={() => {}}>
                <Sparkles className="h-3.5 w-3.5" />
                Create new workspace
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Design your infra visually. Every change re-streams recommendations
          and cost in the sidebar.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={forkTemplate}>
          <Star className="h-3.5 w-3.5" /> Fork template
        </Button>
        <Button variant="glow" size="sm" onClick={recommendStack}>
          <Sparkles className="h-3.5 w-3.5" />
          Recommend stack
        </Button>
      </div>
    </div>
  );
}

function RuntimePanel() {
  const { config, set } = useStackStore();
  const frameworksForLang = frameworks[config.language] ?? [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4" /> Language
          </CardTitle>
          <CardDescription>
            Runtimes tuned for production — each comes with idiomatic
            scaffolding, linter rules and test harnesses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            const COMING_SOON_LANGS = new Set(["java", "kotlin"]);
            return (
              <div className="grid gap-3 sm:grid-cols-2">
                {languages.map((l) => {
                  const comingSoon = COMING_SOON_LANGS.has(l.id);
                  return (
                    <div key={l.id} className="relative">
                      <SelectableCard
                        selected={config.language === l.id}
                        label={l.label}
                        description={l.description}
                        onClick={comingSoon ? undefined : () => set("language", l.id)}
                        icon={<BrandIcon id={l.id} size={22} />}
                        badge={
                          l.popular ? (
                            <Badge variant="brand" className="ml-1">
                              <Sparkles className="h-2.5 w-2.5" /> popular
                            </Badge>
                          ) : null
                        }
                        meta={l.tags?.map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                        className={comingSoon ? "opacity-50 cursor-not-allowed pointer-events-none" : undefined}
                      />
                      {comingSoon && (
                        <span className="pointer-events-none absolute top-2 right-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                          Coming soon
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageCheck className="h-4 w-4" /> Framework
          </CardTitle>
          <CardDescription>
            We generate idiomatic boilerplate, middleware and test scaffolds
            tuned for each framework.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {frameworksForLang.map((f) => (
              <SelectableCard
                key={f.id}
                selected={config.framework === f.id}
                label={f.label}
                description={f.description}
                onClick={() => set("framework", f.id)}
                icon={<BrandIcon id={f.id} size={22} />}
                badge={
                  f.popular ? (
                    <Badge variant="brand" className="ml-1">
                      popular
                    </Badge>
                  ) : null
                }
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function OptionPanel({
  title,
  description,
  options,
  selected,
  onSelect,
  icon,
}: {
  title: string;
  description: string;
  options: { id: string; label: string; description: string; accent?: string; popular?: boolean; tags?: string[] }[];
  selected: string;
  onSelect: (id: string) => void;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <SelectableCard
              key={o.id}
              selected={selected === o.id}
              label={o.label}
              description={o.description}
              onClick={() => onSelect(o.id)}
              icon={<BrandIcon id={o.id} size={22} />}
              badge={
                o.popular ? (
                  <Badge variant="brand" className="ml-1">popular</Badge>
                ) : null
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const COMING_SOON_APIS = new Set<string>();

function ApiPanel() {
  const { config, set } = useStackStore();
  const apis: { id: "rest" | "grpc" | "graphql" | "trpc"; label: string; description: string }[] = [
    { id: "rest", label: "REST", description: "Resource HTTP APIs with OpenAPI specs." },
    { id: "grpc", label: "gRPC", description: "Protobuf, HTTP/2, bidirectional streaming." },
    { id: "graphql", label: "GraphQL", description: "Typed queries with a single endpoint." },
    { id: "trpc", label: "tRPC", description: "Full-stack type-safety for TS monorepos." },
  ];
  const isTsOnly = (id: string) => id === "trpc" && config.language !== "typescript";
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" /> API style
          </CardTitle>
          <CardDescription>
            Pick your primary transport. Helios generates contracts, server
            stubs and client SDKs for each.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {apis.map((a) => (
              <div key={a.id} className="relative">
                <SelectableCard
                  selected={config.api === a.id}
                  label={a.label}
                  description={a.description}
                  onClick={isTsOnly(a.id) ? undefined : () => set("api", a.id)}
                  icon={<Network className="h-4 w-4" />}
                  className={isTsOnly(a.id) ? "opacity-50 cursor-not-allowed pointer-events-none" : undefined}
                />
                {isTsOnly(a.id) && (
                  <span className="pointer-events-none absolute top-2 right-2 rounded-full border border-white/20 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                    TS only
                  </span>
                )}
                {COMING_SOON_APIS.has(a.id) && (
                  <span className="pointer-events-none absolute top-2 right-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
                    coming soon
                  </span>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auth</CardTitle>
          <CardDescription>
            Drop-in identity — we wire middleware, JWKS, token refresh and
            callbacks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {authProviders.map((a) => (
              <SelectableCard
                key={a.id}
                selected={config.auth === a.id}
                label={a.label}
                description={a.description}
                onClick={() => set("auth", a.id)}
                icon={<BrandIcon id={a.id} size={22} />}
                badge={
                  a.popular ? (
                    <Badge variant="brand" className="ml-1">popular</Badge>
                  ) : null
                }
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endpoint design</CardTitle>
          <CardDescription>
            Jump to the contract builder to define schemas, auth and examples.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/api-builder"
            className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 hover:bg-white/[0.04] transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="grid h-8 w-8 place-items-center rounded-md border border-white/10 bg-white/[0.03]">
                <Network className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium">Open API Contract Builder</div>
                <div className="text-xs text-muted-foreground">
                  4 endpoints defined · OpenAPI 3.1
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function SecurityPanel() {
  const { config, patch, addEnvVar, removeEnvVar } = useStackStore();
  const [newKey, setNewKey] = React.useState("");
  const [newValue, setNewValue] = React.useState("");
  const [newSecret, setNewSecret] = React.useState(false);

  function commitVar() {
    const k = newKey.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
    if (!k) {
      toast({ title: "Key required", kind: "error" });
      return;
    }
    addEnvVar({ key: k, value: newValue, secret: newSecret });
    toast({
      title: `Added ${k}`,
      description: newSecret ? "Stored as secret." : "Stored as env.",
      kind: "success",
    });
    setNewKey("");
    setNewValue("");
    setNewSecret(false);
  }

  const toggles = [
    {
      k: "rateLimit" as const,
      title: "Rate limiting",
      desc: "Per-IP and per-token throttles with exponential backoff.",
    },
    {
      k: "tracing" as const,
      title: "Distributed tracing",
      desc: "OpenTelemetry wired in with context propagation.",
    },
    {
      k: "audit" as const,
      title: "Audit logs",
      desc: "Immutable audit trail for every mutating endpoint.",
    },
  ];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Security
          </CardTitle>
          <CardDescription>
            Production defaults, toggled per service. Everything is SOC2 +
            GDPR-ready.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {toggles.map((t) => (
            <div
              key={t.k}
              className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-3.5"
            >
              <div>
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-xs text-muted-foreground">{t.desc}</div>
              </div>
              <Switch
                checked={config[t.k]}
                onCheckedChange={(v) =>
                  patch({ [t.k]: v } as Partial<typeof config>)
                }
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Environment variables</CardTitle>
          <CardDescription>
            Secrets encrypted at rest; previewed on repo generation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {config.envVars.map((v) => (
            <div
              key={v.key}
              className="group flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <Badge variant={v.secret ? "purple" : "outline"}>
                {v.secret ? "secret" : "env"}
              </Badge>
              <span className="text-xs font-mono text-foreground">{v.key}</span>
              <span className="ml-auto text-xs font-mono text-muted-foreground">
                {v.secret ? "••••••••" : v.value}
              </span>
              <button
                type="button"
                onClick={() => {
                  removeEnvVar(v.key);
                  toast({ title: `Removed ${v.key}`, kind: "info" });
                }}
                className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-300 transition-opacity"
                aria-label={`Remove ${v.key}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <div className="grid grid-cols-[1fr,1fr,auto,auto] gap-2 pt-2">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="KEY"
              className="font-mono uppercase text-xs"
            />
            <Input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="value"
              className="font-mono text-xs"
              type={newSecret ? "password" : "text"}
            />
            <button
              type="button"
              onClick={() => setNewSecret((v) => !v)}
              className={`rounded-md border px-2.5 text-[11px] transition-colors ${
                newSecret
                  ? "border-purple-500/40 bg-purple-500/10 text-purple-200"
                  : "border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:text-foreground"
              }`}
            >
              {newSecret ? "secret" : "env"}
            </button>
            <Button
              variant="secondary"
              size="sm"
              onClick={commitVar}
              disabled={!newKey.trim()}
            >
              + Add
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ScalingPanel() {
  const { config, set, patch } = useStackStore();
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4" /> Scaling strategy
          </CardTitle>
          <CardDescription>
            Pick how your service scales with load. Autoscaler config is
            generated for your target.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {scalingStrategies.map((s) => (
              <SelectableCard
                key={s.id}
                selected={config.scaling === s.id}
                label={s.label}
                description={s.description}
                onClick={() => set("scaling", s.id)}
                icon={<Scale className="h-4 w-4" />}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Capacity</CardTitle>
          <CardDescription>
            Replicas, autoscaling thresholds, deployment region.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm">Baseline replicas</span>
              <span className="text-sm font-mono">{config.replicas}</span>
            </div>
            <Slider
              value={[config.replicas]}
              min={1}
              max={12}
              step={1}
              onValueChange={(v) => patch({ replicas: v[0] })}
              className="mt-3"
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Autoscale</div>
              <div className="text-xs text-muted-foreground">
                HPA / KEDA target: CPU &gt; 65%
              </div>
            </div>
            <Switch
              checked={config.autoscale}
              onCheckedChange={(v) => patch({ autoscale: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Docker</div>
              <div className="text-xs text-muted-foreground">
                Multi-stage Dockerfile, distroless runtime
              </div>
            </div>
            <Switch checked={config.docker} onCheckedChange={(v) => patch({ docker: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Kubernetes</div>
              <div className="text-xs text-muted-foreground">
                Helm chart + Kustomize overlays per env
              </div>
            </div>
            <Switch checked={config.kubernetes} onCheckedChange={(v) => patch({ kubernetes: v })} />
          </div>
          <div>
            <div className="text-sm mb-2">Region</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                "us-east-1",
                "us-west-2",
                "eu-west-2",
                "ap-south-1",
                "sa-east-1",
                "ap-southeast-2",
              ].map((r) => (
                <button
                  key={r}
                  onClick={() => patch({ region: r })}
                  className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    config.region === r
                      ? "border-brand-500/50 bg-brand-500/[0.08] text-foreground"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RecommendationsCard() {
  const { config, patch } = useStackStore();

  type Rec = {
    id: string;
    icon: typeof Sparkles;
    title: string;
    desc: string;
    tone: "brand" | "purple" | "emerald";
    show: boolean;
    apply: () => void;
  };

  const recs: Rec[] = [
    {
      id: "docker",
      icon: Sparkles,
      title: "Enable Docker artifacts",
      desc: "Multi-stage Dockerfile + compose for local dev.",
      tone: "brand",
      show: !config.docker,
      apply: () => patch({ docker: true }),
    },
    {
      id: "audit",
      icon: ShieldCheck,
      title: "Enable audit logs",
      desc: "Recommended for SOC2 Type II evidence.",
      tone: "purple",
      show: !config.audit,
      apply: () => patch({ audit: true }),
    },
    {
      id: "tracing",
      icon: Sparkles,
      title: "Turn on distributed tracing",
      desc: "OpenTelemetry, wired into your framework middleware.",
      tone: "brand",
      show: !config.tracing,
      apply: () => patch({ tracing: true }),
    },
    {
      id: "replicas",
      icon: Scale,
      title: "Scale min replicas to 3",
      desc: "Avoid cold starts on traffic bursts.",
      tone: "emerald",
      show: config.replicas < 3,
      apply: () => patch({ replicas: 3 }),
    },
    {
      id: "autoscale",
      icon: Scale,
      title: "Enable autoscaling",
      desc: "HPA with CPU target at 65%.",
      tone: "emerald",
      show: !config.autoscale,
      apply: () => patch({ autoscale: true }),
    },
    {
      id: "rate-limit",
      icon: ShieldCheck,
      title: "Add rate limiting",
      desc: "Per-IP throttle with exponential backoff.",
      tone: "purple",
      show: !config.rateLimit,
      apply: () => patch({ rateLimit: true }),
    },
  ];

  const visible = recs.filter((r) => r.show).slice(0, 4);

  return (
    <Card>
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-brand-300" />
          <span className="text-xs font-semibold">AI Recommendations</span>
        </div>
        <Badge variant="outline">{visible.length}</Badge>
      </div>
      {visible.length === 0 ? (
        <div className="px-4 pb-4 text-[11px] text-muted-foreground">
          All suggestions applied — your stack is production-ready.
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {visible.map((it) => {
            const Icon = it.icon;
            return (
              <div key={it.id} className="flex gap-3 p-3">
                <div
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border ${
                    it.tone === "brand"
                      ? "border-brand-500/30 bg-brand-500/10 text-brand-300"
                      : it.tone === "purple"
                      ? "border-purple-500/30 bg-purple-500/10 text-purple-300"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium">{it.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {it.desc}
                  </div>
                  <button
                    type="button"
                    onClick={it.apply}
                    className="mt-1 text-[11px] text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"
                  >
                    Apply <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ResourceUtilizationCard() {
  const rows = [
    { label: "CPU", pct: 36, tone: "from-brand-500 to-brand-400" },
    { label: "Memory", pct: 52, tone: "from-purple-500 to-purple-400" },
    { label: "Network", pct: 28, tone: "from-emerald-500 to-emerald-400" },
    { label: "Storage", pct: 18, tone: "from-amber-500 to-amber-400" },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Projected utilization</CardTitle>
        <CardDescription>Based on similar workloads at 10k DAU.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{r.label}</span>
              <span className="font-mono">{r.pct}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`h-full rounded-full bg-gradient-to-r ${r.tone}`}
                style={{ width: `${r.pct}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function GenerateCTA() {
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-40" />
      <div className="relative flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-6">
        <div>
          <div className="text-xs text-muted-foreground">Ready to generate</div>
          <div className="mt-1 text-lg font-semibold">
            Produce a typed, tested, deployable repository
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            48 files · Dockerfile · Helm chart · GitHub Actions · OpenAPI spec
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="secondary" size="lg">
            <Link href="/preview">
              <Eye className="h-4 w-4" /> Preview
            </Link>
          </Button>
          <Button asChild variant="glow" size="lg">
            <Link href="/deploy">
              <Rocket className="h-4 w-4" />
              Generate &amp; deploy
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

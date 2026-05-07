"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Sparkles,
  ArrowUpRight,
  Boxes,
  GitBranch,
  Rocket,
  Clock,
  TrendingUp,
  Activity,
  FolderGit2,
  ArrowRight,
  FileCode2,
  Database,
  Cloud,
  Search,
  Trash2,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AIAssistant } from "@/components/shared/ai-assistant";
import { toast } from "@/components/ui/toast";
import { useStackStore, type SavedProject } from "@/lib/store";
import type { StackConfig } from "@/lib/generators/types";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type Template = {
  id: string;
  name: string;
  desc: string;
  stack: string[];
  color: string;
  patch: Partial<StackConfig>;
};

const templates: Template[] = [
  {
    id: "saas",
    name: "SaaS Starter",
    desc: "Multi-tenant SaaS with Clerk auth, Stripe billing, PG RLS.",
    stack: ["TS", "NestJS", "Postgres", "Redis"],
    color: "from-brand-500/30 to-purple-500/30",
    patch: {
      name: "saas-starter",
      language: "typescript",
      framework: "nestjs",
      database: "postgres",
      cache: "redis",
      queue: "bullmq",
      api: "rest",
      auth: "clerk",
      deployment: "vercel",
    },
  },
  {
    id: "chat",
    name: "Realtime Chat",
    desc: "WebSocket rooms, presence, end-to-end encryption.",
    stack: ["Go", "NATS", "Redis"],
    color: "from-emerald-500/30 to-brand-500/30",
    patch: {
      name: "realtime-chat",
      language: "go",
      framework: "fiber",
      database: "postgres",
      cache: "redis",
      queue: "nats",
      api: "rest",
      auth: "supabase-auth",
      deployment: "fly",
    },
  },
  {
    id: "event",
    name: "Event-Driven API",
    desc: "Outbox pattern, CDC to Kafka, idempotent consumers.",
    stack: ["Go", "Kafka", "Postgres"],
    color: "from-amber-500/30 to-red-500/30",
    patch: {
      name: "event-api",
      language: "go",
      framework: "gin",
      database: "postgres",
      cache: "redis",
      queue: "kafka",
      api: "grpc",
      auth: "auth0",
      deployment: "aws",
    },
  },
  {
    id: "ml",
    name: "ML Inference",
    desc: "FastAPI + gRPC, GPU autoscaling, model registry.",
    stack: ["Python", "Triton", "S3"],
    color: "from-purple-500/30 to-pink-500/30",
    patch: {
      name: "ml-inference",
      language: "python",
      framework: "fastapi",
      database: "postgres",
      cache: "redis",
      queue: "sqs",
      api: "grpc",
      auth: "cognito",
      deployment: "gcp",
    },
  },
];

const quickActions = [
  { label: "New stack", desc: "Start from scratch", icon: Boxes, href: "/builder" },
  { label: "API contract", desc: "Design endpoints", icon: FileCode2, href: "/api-builder" },
  { label: "Connect cloud", desc: "AWS / GCP / Azure", icon: Cloud, href: "/deploy" },
  { label: "Import repo", desc: "Analyze existing", icon: FolderGit2, action: "import" as const },
];

export default function DashboardPage() {
  const { savedProjects, loadSavedProjects, deleteProject, authUser } = useStackStore();
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    void loadSavedProjects();
  }, [loadSavedProjects]);

  const filtered = savedProjects.filter(
    (p) =>
      !filter.trim() ||
      p.name.toLowerCase().includes(filter.toLowerCase()) ||
      p.config.language.toLowerCase().includes(filter.toLowerCase()) ||
      p.config.database.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <WorkspaceShell
      breadcrumb={[{ label: "Dashboard" }]}
      right={<AIAssistant />}
    >
      <div className="mx-auto max-w-6xl p-6 md:p-8 space-y-8">
        <HeaderBlock name={authUser?.name} />

        <MetricsStrip />

        <section>
          <SectionHeader
            title="Quick actions"
            subtitle="Jump back in or kickstart something new"
          />
          <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {quickActions.map((a) => {
              const Icon = a.icon;
              const card = (
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-sm font-medium">{a.label}</div>
                    <div className="text-xs text-muted-foreground">{a.desc}</div>
                  </div>
                  <ArrowUpRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              );
              if ("href" in a && a.href) {
                return (
                  <Link
                    key={a.label}
                    href={a.href}
                    className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover-raise"
                  >
                    {card}
                  </Link>
                );
              }
              return (
                <button
                  key={a.label}
                  type="button"
                  onClick={() =>
                    toast({
                      title: "Import coming soon",
                      description:
                        "Connect a GitHub repo to let Helios analyze and upgrade it.",
                      kind: "info",
                    })
                  }
                  className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover-raise text-left"
                >
                  {card}
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <div className="flex items-end justify-between">
            <SectionHeader
              title="Recent projects"
              subtitle="Your workspace activity across environments"
            />
            <div className="flex items-center gap-2">
              <label className="hidden md:flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 w-56 focus-within:border-brand-500/30">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
                  placeholder="Filter projects"
                />
              </label>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  toast({
                    title: "Import a repository",
                    description:
                      "Paste a GitHub URL in the AI panel to audit it.",
                    kind: "info",
                  })
                }
              >
                <GitBranch className="h-3.5 w-3.5" /> Import
              </Button>
              <Button asChild variant="glow" size="sm">
                <Link href="/builder">
                  <Plus className="h-3.5 w-3.5" /> New
                </Link>
              </Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {savedProjects.length === 0 ? (
              <div className="md:col-span-2 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-8 text-center space-y-2">
                <FolderGit2 className="h-8 w-8 text-muted-foreground mx-auto" />
                <div className="text-sm font-medium">No saved projects yet</div>
                <p className="text-xs text-muted-foreground">
                  Open the builder, configure your stack, and hit Save.
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="md:col-span-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
                <div className="text-sm font-medium">No matches</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Try another search term.
                </p>
              </div>
            ) : (
              filtered.map((p) => (
                <SavedProjectCard key={p.id} project={p} onDelete={() => deleteProject(p.id)} />
              ))
            )}
          </div>
        </section>

        <section>
          <SectionHeader
            title="Templates"
            subtitle="Production-tested blueprints, fully editable"
          />
          <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {templates.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        </section>

        <ActivityFeed />
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({ name }: { name?: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-6 md:p-8">
      <div className="pointer-events-none absolute -right-20 -top-20 h-[320px] w-[420px] aurora animate-aurora opacity-60" />
      <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-5">
        <div>
          <p className="text-xs text-muted-foreground">
            Welcome back{name ? `, ${name.split(" ")[0]}` : ""}
          </p>
          <h1 className="mt-1 text-2xl md:text-3xl font-semibold tracking-tight">
            What will you ship today?
          </h1>
          <p className="mt-1.5 max-w-lg text-sm text-muted-foreground">
            You have 3 active projects and 2 pending deployments. The AI
            copilot suggests upgrading{" "}
            <span className="text-foreground">helios-api</span> to Postgres 16
            — it could cut p99 by ~14%.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="lg"
            onClick={() =>
              toast({
                title: "Helios is listening",
                description:
                  "Open the right sidebar and ask for a stack review.",
                kind: "info",
              })
            }
          >
            <Sparkles className="h-4 w-4" /> Ask Helios
          </Button>
          <Button asChild variant="glow" size="lg">
            <Link href="/builder">
              <Plus className="h-4 w-4" /> New stack
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function MetricsStrip() {
  const items = [
    { label: "Active stacks", value: "12", delta: "+2", icon: Boxes, tone: "text-brand-300" },
    { label: "Deployments this week", value: "48", delta: "+11%", icon: Rocket, tone: "text-emerald-300" },
    { label: "P99 latency", value: "42ms", delta: "−6ms", icon: Activity, tone: "text-emerald-300" },
    { label: "Monthly spend", value: "$1,284", delta: "−$120", icon: TrendingUp, tone: "text-amber-300" },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      {items.map((m) => {
        const Icon = m.icon;
        return (
          <Card key={m.label} className="p-4 hover-raise">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-muted-foreground">{m.label}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-semibold">{m.value}</span>
                  <span className={`text-[11px] ${m.tone}`}>{m.delta}</span>
                </div>
              </div>
              <div className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="mt-3 flex h-8 items-end gap-1">
              {Array.from({ length: 16 }).map((_, i) => {
                const h = 20 + ((i * 37) % 80);
                return (
                  <span
                    key={i}
                    className="flex-1 rounded-sm bg-gradient-to-t from-brand-500/40 to-brand-500/5"
                    style={{ height: `${h}%` }}
                  />
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle ? (
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      ) : null}
    </div>
  );
}

function SavedProjectCard({
  project,
  onDelete,
}: {
  project: SavedProject;
  onDelete: () => void;
}) {
  const { loadProject } = useStackStore();
  const router = useRouter();

  function open() {
    loadProject(project.id);
    toast({
      title: `Loaded "${project.name}"`,
      description: `${project.config.language} · ${project.config.framework} · ${project.config.database}`,
      kind: "success",
    });
    router.push("/builder");
  }

  const stackLine = [
    project.config.language,
    project.config.framework,
    project.config.database,
    project.config.cache !== "none" ? project.config.cache : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="group relative block w-full text-left rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover-raise">
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-gradient-to-br from-brand-500/30 to-purple-500/30 border border-white/10 grid place-items-center">
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <span className="text-sm font-medium truncate">{project.name}</span>
            {project.entities.length > 0 && (
              <Badge variant="outline" className="ml-1 text-[10px]">
                {project.entities.length} model{project.entities.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground font-mono">{stackLine}</p>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
            toast({ title: `Deleted "${project.name}"`, kind: "info" });
          }}
          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-300 transition-opacity"
          aria-label="Delete project"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <button type="button" onClick={open} className="mt-4 w-full flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Cloud className="h-3 w-3" /> {project.config.region}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> {relativeTime(project.savedAt)}
        </span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground/80 group-hover:text-brand-300 transition-colors">
          Open <ArrowRight className="h-3 w-3" />
        </span>
      </button>
    </div>
  );
}

function TemplateCard({ template }: { template: Template }) {
  const { patch } = useStackStore();
  const router = useRouter();

  function applyTemplate() {
    patch(template.patch);
    toast({
      title: `Loaded "${template.name}"`,
      description: "Customize it in the builder or tweak via AI.",
      kind: "success",
    });
    router.push("/builder");
  }

  return (
    <button
      type="button"
      onClick={applyTemplate}
      className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-left hover-raise"
    >
      <div
        className={`pointer-events-none absolute -inset-20 bg-gradient-to-br ${template.color} opacity-0 blur-3xl group-hover:opacity-100 transition-opacity`}
      />
      <div className="relative">
        <div className="flex items-center justify-between">
          <div className="grid h-8 w-8 place-items-center rounded-md border border-white/10 bg-white/[0.03]">
            <Boxes className="h-4 w-4" />
          </div>
          <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <div className="mt-3 text-sm font-medium">{template.name}</div>
        <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
          {template.desc}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {template.stack.map((s) => (
            <Badge key={s} variant="outline" className="text-[10px]">
              {s}
            </Badge>
          ))}
        </div>
      </div>
    </button>
  );
}

function ActivityFeed() {
  const items = [
    { who: "Jee", what: "deployed", target: "helios-api", where: "production", when: "2 minutes ago", tone: "emerald" },
    { who: "AI", what: "recommended", target: "Postgres 16 upgrade", where: "helios-api", when: "14 minutes ago", tone: "brand" },
    { who: "Ana", what: "added endpoint", target: "POST /invoices", where: "ledger-svc", when: "1 hour ago", tone: "purple" },
    { who: "CI", what: "passed", target: "148 tests", where: "notifier", when: "3 hours ago", tone: "emerald" },
  ];
  const toneMap: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    brand: "bg-brand-500/10 text-brand-300 border-brand-500/20",
    purple: "bg-purple-500/10 text-purple-300 border-purple-500/20",
  };
  return (
    <section>
      <SectionHeader title="Activity" subtitle="What happened across your workspace" />
      <Card className="mt-4 divide-y divide-white/[0.04]">
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            onClick={() =>
              toast({
                title: `${it.who} ${it.what} ${it.target}`,
                description: `in ${it.where} · ${it.when}`,
                kind: "info",
              })
            }
            className="flex w-full items-center gap-3 p-3.5 text-left hover:bg-white/[0.02]"
          >
            <span
              className={`grid h-7 w-7 place-items-center rounded-full border text-[10px] font-semibold ${toneMap[it.tone]}`}
            >
              {it.who.slice(0, 2).toUpperCase()}
            </span>
            <div className="flex-1 text-sm">
              <span className="font-medium">{it.who}</span>{" "}
              <span className="text-muted-foreground">{it.what}</span>{" "}
              <span className="font-medium">{it.target}</span>{" "}
              <span className="text-muted-foreground">in</span>{" "}
              <span className="font-mono text-[12px]">{it.where}</span>
            </div>
            <span className="text-[11px] text-muted-foreground">{it.when}</span>
          </button>
        ))}
      </Card>
    </section>
  );
}

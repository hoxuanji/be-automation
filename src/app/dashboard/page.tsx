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
  History,
  Users,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { useStackStore, type SavedProject } from "@/lib/store";
import type { StackConfig } from "@/lib/generators/types";
import { cn } from "@/lib/utils";

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
  { label: "Import repo", desc: "Analyze existing", icon: FolderGit2, href: "/from-repo" },
];

function PersistenceWarning() {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { storage?: string }) => { if (d.storage === "ephemeral") setShow(true); })
      .catch(() => {});
  }, []);

  if (!show) return null;

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/[0.06] px-6 py-3">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-amber-200/80">
          <strong className="font-medium">Storage warning:</strong> Your database is on an ephemeral filesystem and will reset on the next deploy. Mount a persistent volume or connect a managed database to keep your data.
        </p>
        <button onClick={() => setShow(false)} className="text-amber-400/60 hover:text-amber-300 text-sm leading-none shrink-0">✕</button>
      </div>
    </div>
  );
}

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
    >
      <PersistenceWarning />
      <div className="mx-auto max-w-6xl p-6 md:p-8 space-y-8">
        <HeaderBlock name={authUser?.name} projectCount={savedProjects.length} />

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
              <Button asChild variant="secondary" size="sm">
                <Link href="/from-repo">
                  <GitBranch className="h-3.5 w-3.5" /> Import
                </Link>
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
              <div className="md:col-span-2 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-8 space-y-5">
                <div className="text-center space-y-3">
                  <div className="mx-auto h-12 w-12 rounded-xl bg-gradient-to-br from-brand-500/20 to-purple-500/20 border border-white/[0.06] grid place-items-center">
                    <FolderGit2 className="h-6 w-6 text-brand-300" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">No projects yet</div>
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                      Start from a template or configure your own stack from scratch — your first repo takes under 2 minutes.
                    </p>
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <Button asChild variant="glow" size="sm">
                      <Link href="/builder"><Plus className="h-3.5 w-3.5" /> Start from scratch</Link>
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 text-center">Or pick a template</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {templates.map((t) => (
                      <TemplateCard key={t.id} template={t} />
                    ))}
                  </div>
                </div>
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

        <TeamProjectsSection />

        <RecentSaves />
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({ name, projectCount }: { name?: string; projectCount: number }) {
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
            {projectCount > 0
              ? `You have ${projectCount} saved project${projectCount !== 1 ? "s" : ""}. Configure a stack, download the generated repo, or push directly to GitHub.`
              : "Get started by configuring your first stack in the builder."}
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

type Team = { id: string; name: string; role: string; memberCount: number };
type TeamProject = { id: string; name: string; updated_at: number; user_name: string };

function TeamProjectsSection() {
  const { authUser } = useStackStore();
  const [teams, setTeams] = React.useState<Team[]>([]);
  const [projects, setProjects] = React.useState<Record<string, TeamProject[]>>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    if (!authUser) return;
    setLoading(true);
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d: { teams?: Team[] }) => {
        const t = d.teams ?? [];
        setTeams(t);
        // Auto-expand first team, load its projects
        if (t.length > 0) {
          setExpanded({ [t[0].id]: true });
          return fetchTeamProjects(t[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  async function fetchTeamProjects(teamId: string) {
    if (projects[teamId]) return;
    try {
      const r = await fetch(`/api/teams/${teamId}/projects`);
      const d = await r.json() as { projects?: TeamProject[] };
      setProjects((prev) => ({ ...prev, [teamId]: d.projects ?? [] }));
    } catch {}
  }

  function toggle(teamId: string) {
    setExpanded((prev) => {
      const next = { ...prev, [teamId]: !prev[teamId] };
      if (next[teamId]) void fetchTeamProjects(teamId);
      return next;
    });
  }

  if (!authUser || (teams.length === 0 && !loading)) return null;

  return (
    <section>
      <SectionHeader
        title="Team projects"
        subtitle="Projects shared across your team workspaces"
      />
      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading teams…
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {teams.map((team) => (
            <div key={team.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(team.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] group"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
                    <Users className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="text-left">
                    <div className="text-sm font-medium">{team.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {team.memberCount} member{team.memberCount !== 1 ? "s" : ""} · {team.role}
                    </div>
                  </div>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    expanded[team.id] && "rotate-180"
                  )}
                />
              </button>
              {expanded[team.id] && (
                <div className="border-t border-white/[0.04]">
                  {!projects[team.id] ? (
                    <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
                    </div>
                  ) : projects[team.id].length === 0 ? (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                      No projects yet for this team.
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.04]">
                      {projects[team.id].map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            toast({ title: `Opening "${p.name}"`, description: `by ${p.user_name}`, kind: "info" });
                            router.push("/builder");
                          }}
                          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] group"
                        >
                          <div className="grid h-6 w-6 place-items-center rounded-md border border-white/10 bg-white/[0.03] shrink-0">
                            <Database className="h-3 w-3 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium truncate">{p.name}</span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0 text-[11px] text-muted-foreground">
                            <span>{p.user_name}</span>
                            <span>{relativeTime(new Date(p.updated_at * 1000).toISOString())}</span>
                            <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentSaves() {
  const { savedProjects, loadProject } = useStackStore();
  const router = useRouter();

  const recent = [...savedProjects]
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
    .slice(0, 5);

  if (recent.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Recent saves" subtitle="Last 5 projects you worked on" />
      <Card className="mt-4 divide-y divide-white/[0.04]">
        {recent.map((p) => {
          const stackLine = [p.config.language, p.config.framework, p.config.database]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                loadProject(p.id);
                router.push("/builder");
              }}
              className="flex w-full items-center gap-3 p-3.5 text-left hover:bg-white/[0.02] group"
            >
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.03]">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-[11px] text-muted-foreground font-mono truncate">{stackLine}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {p.entities.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {p.entities.length} model{p.entities.length !== 1 ? "s" : ""}
                  </Badge>
                )}
                <span className="text-[11px] text-muted-foreground">{relativeTime(p.savedAt)}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </button>
          );
        })}
      </Card>
    </section>
  );
}

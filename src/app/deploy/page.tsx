"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CloudCog,
  Copy,
  ExternalLink,
  FileText,
  Github,
  Globe2,
  Key,
  Loader2,
  MinusCircle,
  RefreshCw,
  Rocket,
  Sparkles,
  X,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useStackStore, type GithubRepo } from "@/lib/store";
import { deployments } from "@/data/stack-options";
import { toast } from "@/components/ui/toast";
import { BrandIcon } from "@/components/shared/brand-icon";


export default function DeployPage() {
  const { config, patch } = useStackStore();
  const [step, setStep] = React.useState<"configure" | "guide">("configure");

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: config.name },
        { label: "Deployment" },
      ]}
    >
      <div className="max-w-[1200px] mx-auto p-6 md:p-8 space-y-6">
        <HeaderBlock step={step} />

        <div className="grid gap-6 lg:grid-cols-[1fr,360px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CloudCog className="h-4 w-4" /> Deployment provider
                </CardTitle>
                <CardDescription>
                  Connect a provider. Credentials are encrypted end-to-end — we
                  never see them in plain text.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                  {deployments.map((d) => {
                    const isLive = d.id === "railway" || d.id === "render" || d.id === "fly" || d.id === "vercel";
                    if (!isLive) {
                      return (
                        <div
                          key={d.id}
                          className="relative rounded-xl border border-white/[0.04] bg-white/[0.01] p-3 opacity-50 cursor-not-allowed select-none"
                        >
                          <span className="absolute top-2 right-2 rounded-full border border-white/20 bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                            Coming soon
                          </span>
                          <BrandIcon id={d.id} size={32} rounded="lg" />
                          <div className="mt-3 text-sm font-medium">{d.label}</div>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={d.id}
                        onClick={() => patch({ deployment: d.id })}
                        className={`group relative rounded-xl border p-3 text-left hover-raise ${
                          config.deployment === d.id
                            ? "border-brand-500/50 bg-brand-500/[0.06]"
                            : "border-white/[0.06] bg-white/[0.02]"
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <BrandIcon id={d.id} size={32} rounded="lg" />
                          {config.deployment === d.id ? (
                            <Check className="h-4 w-4 text-brand-300" />
                          ) : null}
                        </div>
                        <div className="mt-3 text-sm font-medium">{d.label}</div>
                        <div className="text-[11px] text-muted-foreground line-clamp-1">
                          {d.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <CredentialsPanel provider={liveProvider(config.deployment)} />
          </div>

          {/* right column */}
          <div className="space-y-4">
            <DeployHistoryCard />
            <BranchGateCard />
            {isLiveProvider(config.deployment) ? (
              <DeployPanel provider={liveProvider(config.deployment)} />
            ) : step === "guide" ? (
              <DeployGuide onBack={() => setStep("configure")} />
            ) : (
              <DeployCTA onGenerate={() => setStep("guide")} />
            )}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({ step }: { step: "configure" | "guide" }) {
  const steps = [
    { id: "configure", label: "Configure" },
    { id: "guide", label: "Guide" },
  ];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-6">
      <div className="pointer-events-none absolute -right-20 -top-20 h-[280px] w-[420px] aurora animate-aurora opacity-60" />
      <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="brand">
              <Sparkles className="h-3 w-3" /> Deployment center
            </Badge>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Ship your stack to production
          </h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-lg">
            Pick a provider, configure your deployment settings, then generate a
            step-by-step guide to deploy the generated code yourself.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {steps.map((s, i) => {
            const active = step === s.id;
            const done = steps.findIndex((x) => x.id === step) > i;
            return (
              <React.Fragment key={s.id}>
                <div
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                    done
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : active
                      ? "border-brand-500/40 bg-brand-500/10 text-brand-300"
                      : "border-white/10 bg-white/[0.02] text-muted-foreground"
                  }`}
                >
                  <span
                    className={`grid h-4 w-4 place-items-center rounded-full text-[10px] font-semibold ${
                      done
                        ? "bg-emerald-500/20"
                        : active
                        ? "bg-brand-500/20"
                        : "bg-white/[0.04]"
                    }`}
                  >
                    {done ? <Check className="h-2.5 w-2.5" /> : i + 1}
                  </span>
                  {s.label}
                </div>
                {i < steps.length - 1 ? (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type WorkflowRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | null;
  headBranch: string;
  headSha: string;
  headMessage: string;
  createdAt: string;
  htmlUrl: string;
};

function runStatusBadge(run: WorkflowRun) {
  if (run.status === "queued") return <span className="inline-flex items-center gap-1 text-[10px] text-amber-300"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />queued</span>;
  if (run.status === "in_progress") return <span className="inline-flex items-center gap-1 text-[10px] text-brand-300"><Loader2 className="h-2.5 w-2.5 animate-spin" />running</span>;
  if (run.conclusion === "success") return <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300"><Check className="h-2.5 w-2.5" />success</span>;
  if (run.conclusion === "failure") return <span className="inline-flex items-center gap-1 text-[10px] text-red-400"><X className="h-2.5 w-2.5" />failed</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><MinusCircle className="h-2.5 w-2.5" />{run.conclusion ?? run.status}</span>;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function RepoConnectForm({ onConnect }: { onConnect: (r: GithubRepo) => void }) {
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function parse(v: string): { owner: string; repo: string } | null {
    const c = v.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    const [owner, repo] = c.split("/").filter(Boolean);
    return owner && repo ? { owner, repo } : null;
  }

  async function connect() {
    const p = parse(input);
    if (!p) { setError("Enter owner/repo"); return; }
    setLoading(true); setError(null);
    const res = await fetch(`/api/github/repo?owner=${p.owner}&repo=${p.repo}`).catch(() => null);
    if (!res?.ok) { setError("Cannot access repo — check name and token"); setLoading(false); return; }
    const d = (await res.json()) as { defaultBranch?: string };
    onConnect({ owner: p.owner, repo: p.repo, defaultBranch: d.defaultBranch ?? "main" });
    setLoading(false);
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">Connect a repo to see live workflow status.</p>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={(e) => e.key === "Enter" && connect()}
          placeholder="owner/repo"
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
        />
        <Button variant="secondary" size="sm" onClick={connect} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Connect"}
        </Button>
      </div>
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}

function DeployHistoryCard() {
  const { githubRepo, setGithubRepo } = useStackStore();
  const [runs, setRuns] = React.useState<WorkflowRun[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [lastRefresh, setLastRefresh] = React.useState<Date | null>(null);

  const hasLiveRun = runs.some((r) => r.status !== "completed");

  const fetchRuns = React.useCallback(async () => {
    if (!githubRepo) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/github/runs?owner=${githubRepo.owner}&repo=${githubRepo.repo}&per_page=8`
      );
      if (res.ok) {
        const d = (await res.json()) as { runs: WorkflowRun[] };
        setRuns(d.runs);
        setLastRefresh(new Date());
      }
    } finally {
      setLoading(false);
    }
  }, [githubRepo]);

  React.useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Poll every 10s while a run is live
  React.useEffect(() => {
    if (!hasLiveRun || !githubRepo) return;
    const id = setInterval(fetchRuns, 10_000);
    return () => clearInterval(id);
  }, [hasLiveRun, githubRepo, fetchRuns]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Github className="h-3.5 w-3.5" /> Deploy history
          </CardTitle>
          {githubRepo && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setGithubRepo(null)}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                change
              </button>
              <button
                onClick={fetchRuns}
                disabled={loading}
                className="text-muted-foreground hover:text-foreground"
                title="Refresh"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          )}
        </div>
        {githubRepo && (
          <p className="text-[10px] text-muted-foreground font-mono">
            {githubRepo.owner}/{githubRepo.repo}
            {lastRefresh && <span className="ml-2 not-mono">· {timeAgo(lastRefresh.toISOString())}</span>}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {!githubRepo ? (
          <RepoConnectForm onConnect={(r) => { setGithubRepo(r); }} />
        ) : runs.length === 0 && !loading ? (
          <p className="text-xs text-muted-foreground">No workflow runs found.</p>
        ) : (
          <div className="space-y-2">
            {runs.slice(0, 6).map((run) => (
              <div key={run.id} className="flex items-start justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.02] p-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {runStatusBadge(run)}
                    <span className="text-[10px] text-muted-foreground font-mono">{run.headSha}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{run.headMessage || run.name}</p>
                  <p className="text-[9px] text-muted-foreground/60 mt-0.5 font-mono">{run.headBranch} · {timeAgo(run.createdAt)}</p>
                </div>
                <a
                  href={run.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BranchGateCard() {
  const { gitConfig } = useStackStore();
  const envs = gitConfig.deployEnvironments;
  const prodEnv = envs.find((e) => e.name === "production") ?? envs[0];
  const stagingEnv = envs.find((e) => e.name === "staging");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MinusCircle className="h-3.5 w-3.5 text-amber-400" />
          Branch protection
        </CardTitle>
        <CardDescription className="text-[11px]">
          Only branches matching these patterns can trigger deployments.{" "}
          <Link href="/git-settings" className="underline hover:text-foreground">
            Edit in Git &amp; CI/CD →
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {prodEnv && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Production</p>
            <div className="flex flex-wrap gap-1.5">
              {prodEnv.targetBranches.map((b) => (
                <span key={b} className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/[0.08] px-2 py-0.5 text-[10px] font-mono text-emerald-300">
                  {b}
                </span>
              ))}
            </div>
          </div>
        )}
        {stagingEnv && (
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Staging</p>
            <div className="flex flex-wrap gap-1.5">
              {stagingEnv.targetBranches.map((b) => (
                <span key={b} className="inline-flex items-center rounded-full border border-brand-500/30 bg-brand-500/[0.08] px-2 py-0.5 text-[10px] font-mono text-brand-300">
                  {b}
                </span>
              ))}
            </div>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground pt-1">
          Commits on non-allowed branches will be blocked by the deploy workflow.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Provider-aware helpers ──────────────────────────────────────────────────

type LiveProvider = "railway" | "render" | "fly" | "vercel";

function isLiveProvider(id: string): id is LiveProvider {
  return id === "railway" || id === "render" || id === "fly" || id === "vercel";
}

// Narrows the deployment id to a known live provider, defaulting to railway
// (the canonical first-class provider) when the current selection isn't live.
// Used by CredentialsPanel which always renders something.
function liveProvider(id: string): LiveProvider {
  return isLiveProvider(id) ? id : "railway";
}

const PROVIDER_META: Record<LiveProvider, { label: string; tokenLabel: string }> = {
  railway: { label: "Railway",  tokenLabel: "Railway Personal API Token" },
  render:  { label: "Render",   tokenLabel: "Render Personal API Key" },
  fly:     { label: "Fly",      tokenLabel: "Fly Personal Access Token" },
  vercel:  { label: "Vercel",   tokenLabel: "Vercel Personal Access Token" },
};

// Status-only panel — full token management lives in Settings → Integrations
function CredentialsPanel({ provider }: { provider: LiveProvider }) {
  const [hasToken, setHasToken] = React.useState<boolean | null>(null);
  const meta = PROVIDER_META[provider];

  React.useEffect(() => {
    fetch("/api/deploy/credentials")
      .then((r) => r.json())
      .then((d: { creds?: Record<string, { token?: string }> }) => {
        setHasToken(!!d.creds?.[provider]?.token);
      })
      .catch(() => setHasToken(false));
  }, [provider]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-4 w-4" /> {meta.label} credentials
        </CardTitle>
        <CardDescription>
          Manage your {meta.tokenLabel} in{" "}
          <a href="/settings" className="underline hover:text-foreground">
            Settings → Integrations
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasToken === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
          </div>
        ) : hasToken ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-emerald-300">Token saved</span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">No token saved yet.</p>
            <Button asChild variant="secondary" size="sm">
              <a href="/settings">Add in Settings →</a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


// ─── Deploy panel ───────────────────────────────────────────────────────────

type DeployPhase = "idle" | "deploying" | "done" | "error";

type DeployResult = {
  provider: LiveProvider;
  projectUrl: string;
  domain: string | null;
  fullName: string;
  githubUrl: string;
  nextStep?: { message: string; command?: string };
};

// Per-provider UI stage list. We collapse server-side micro-stages into
// user-facing rows so the timeline is readable at a glance. The keys
// double as a deterministic render order.
const PROVIDER_UI: Record<
  LiveProvider,
  {
    stages: readonly string[];
    labels: Record<string, string>;
    mapServerStage: (s: string) => string | null;
    deployingMessage: string;
    successMessage: string;
  }
> = {
  railway: {
    stages: ["push", "project", "service", "variables", "domain"] as const,
    labels: {
      push: "Pushing code to GitHub",
      project: "Creating Railway project",
      service: "Linking repository",
      variables: "Setting environment variables",
      domain: "Provisioning public domain",
    },
    mapServerStage(s) {
      switch (s) {
        case "generate":
        case "github_push":
          return "push";
        case "railway_project":
        case "railway_env":
          return "project";
        case "railway_service":
          return "service";
        case "railway_variables":
          return "variables";
        case "railway_domain":
          return "domain";
        default:
          return null;
      }
    },
    deployingMessage:
      "Railway is building your Docker image. Check the dashboard to follow build progress.",
    successMessage: "Deployment started",
  },
  render: {
    stages: ["push", "owner", "service"] as const,
    labels: {
      push: "Pushing code to GitHub",
      owner: "Resolving Render account",
      service: "Creating Render web service",
    },
    mapServerStage(s) {
      switch (s) {
        case "generate":
        case "github_push":
          return "push";
        case "render_owner":
          return "owner";
        case "render_service":
          return "service";
        default:
          return null;
      }
    },
    deployingMessage:
      "Render is building your service from the GitHub repo. The first deploy can take a few minutes.",
    successMessage: "Service created",
  },
  fly: {
    stages: ["push", "org", "app", "secrets", "handoff"] as const,
    labels: {
      push: "Pushing code to GitHub",
      org: "Resolving Fly organization",
      app: "Creating Fly app",
      secrets: "Setting secrets",
      handoff: "Awaiting first build",
    },
    mapServerStage(s) {
      switch (s) {
        case "generate":
        case "github_push":
          return "push";
        case "fly_org":
          return "org";
        case "fly_app":
          return "app";
        case "fly_secrets":
          return "secrets";
        case "fly_handoff":
          return "handoff";
        default:
          return null;
      }
    },
    deployingMessage:
      "Fly app provisioned. Run flyctl deploy from the cloned repo to ship the first image.",
    successMessage: "App provisioned",
  },
  vercel: {
    stages: ["push", "project", "env", "domain"] as const,
    labels: {
      push: "Pushing code to GitHub",
      project: "Creating Vercel project",
      env: "Setting environment variables",
      domain: "Resolving deployment URL",
    },
    mapServerStage(s) {
      switch (s) {
        case "generate":
        case "github_push":
          return "push";
        case "vercel_project":
          return "project";
        case "vercel_env":
          return "env";
        case "vercel_domain":
          return "domain";
        default:
          return null;
      }
    },
    deployingMessage:
      "Vercel is building your first deployment from the GitHub repo. It will be live at your .vercel.app URL in moments.",
    successMessage: "Project created",
  },
};

type StageState = "waiting" | "active" | "done" | "skipped";

function initialStages(stages: readonly string[]): Record<string, StageState> {
  const out: Record<string, StageState> = {};
  for (const s of stages) out[s] = "waiting";
  return out;
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.trim() || frame.startsWith(":")) continue;
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function DeployPanel({ provider }: { provider: LiveProvider }) {
  const meta = PROVIDER_META[provider];
  const ui = PROVIDER_UI[provider];
  const stagesList = ui.stages;

  const { config, endpoints, entities } = useStackStore();
  const [phase, setPhase] = React.useState<DeployPhase>("idle");
  const [result, setResult] = React.useState<DeployResult | null>(null);
  const [errorMsg, setErrorMsg] = React.useState("");
  const [errorHint, setErrorHint] = React.useState("");
  const [errorPartial, setErrorPartial] = React.useState<{ projectId?: string; serviceId?: string; appName?: string } | null>(null);
  const [hasToken, setHasToken] = React.useState<boolean | null>(null);
  const [ghConnected, setGhConnected] = React.useState<boolean | null>(null);
  const [stages, setStages] = React.useState<Record<string, StageState>>(() => initialStages(stagesList));
  const [stageDetail, setStageDetail] = React.useState<Record<string, string>>({});
  const [warnings, setWarnings] = React.useState<string[]>([]);

  React.useEffect(() => {
    Promise.all([
      fetch("/api/deploy/credentials").then((r) => r.json()) as Promise<{ creds?: Record<string, { token?: string }> }>,
      fetch("/api/auth/github/status").then((r) => r.json()) as Promise<{ connected: boolean }>,
    ])
      .then(([creds, gh]) => {
        setHasToken(!!creds.creds?.[provider]?.token);
        setGhConnected(gh.connected);
      })
      .catch(() => { setHasToken(false); setGhConnected(false); });
  }, [provider]);

  // Re-init stage map when the provider changes.
  React.useEffect(() => {
    setStages(initialStages(stagesList));
    setStageDetail({});
    setWarnings([]);
  }, [stagesList]);

  async function deploy() {
    setPhase("deploying");
    setErrorMsg("");
    setErrorHint("");
    setErrorPartial(null);
    setStages(initialStages(stagesList));
    setStageDetail({});
    setWarnings([]);

    let currentStage: string | null = null;
    const markActive = (s: string) => {
      setStages((prev) => {
        const next = { ...prev };
        // Any earlier stage that was `active` becomes `done`. Stages we
        // skipped over (still `waiting`) also collapse to `done` so the
        // checklist visibly progresses without flicker.
        for (const key of stagesList) {
          if (key === s) break;
          if (next[key] === "active") next[key] = "done";
          if (next[key] === "waiting") next[key] = "done";
        }
        next[s] = "active";
        return next;
      });
    };
    const markDoneAll = () => {
      setStages((prev) => {
        const next = { ...prev };
        for (const key of stagesList) {
          if (next[key] === "active" || next[key] === "waiting") next[key] = "done";
        }
        return next;
      });
    };

    try {
      const res = await fetch("/api/deploy/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ provider, config, endpoints, entities }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({} as Record<string, unknown>)) as {
          error?: string;
          message?: string;
          hint?: string;
          partial?: { projectId?: string; serviceId?: string; appName?: string };
        };
        setPhase("error");
        setErrorMsg(data.message ?? data.error ?? "Deployment failed");
        setErrorHint(data.hint ?? "");
        setErrorPartial(data.partial ?? null);
        return;
      }

      for await (const frame of parseSseStream(res.body)) {
        let payload: unknown;
        try { payload = JSON.parse(frame.data); } catch { continue; }

        if (frame.event === "stage") {
          const p = payload as { stage: string; message?: string };
          const uiStage = ui.mapServerStage(p.stage);
          if (uiStage) {
            currentStage = uiStage;
            markActive(uiStage);
          }
          continue;
        }
        if (frame.event === "progress") {
          const p = payload as { message?: string; detail?: string };
          if (currentStage && p.detail) {
            setStageDetail((prev) => ({ ...prev, [currentStage!]: p.detail! }));
          }
          continue;
        }
        if (frame.event === "warn") {
          const p = payload as { message?: string };
          if (p.message) setWarnings((w) => [...w, p.message!]);
          // Railway-specific: a domain creation warn means the domain stage
          // was skipped. Other providers don't have an analogous skippable
          // stage, so leave the timeline alone.
          if (provider === "railway" && currentStage === "domain") {
            setStages((prev) => ({ ...prev, domain: "skipped" }));
          }
          continue;
        }
        if (frame.event === "error") {
          const p = payload as {
            error?: {
              error?: string;
              message?: string;
              hint?: string;
              partial?: { projectId?: string; serviceId?: string; appName?: string };
            };
          };
          const err = p.error ?? {};
          setPhase("error");
          setErrorMsg(err.message ?? err.error ?? "Deployment failed");
          setErrorHint(err.hint ?? "");
          setErrorPartial(err.partial ?? null);
          return;
        }
        if (frame.event === "done") {
          const p = payload as {
            result: {
              provider?: LiveProvider;
              projectUrl: string;
              domain: string | null;
              fullName: string;
              githubUrl: string;
              nextStep?: { message: string; command?: string };
            };
          };
          markDoneAll();
          setResult({
            provider: p.result.provider ?? provider,
            projectUrl: p.result.projectUrl,
            domain: p.result.domain,
            fullName: p.result.fullName,
            githubUrl: p.result.githubUrl,
            nextStep: p.result.nextStep,
          });
          setPhase("done");
          return;
        }
      }

      // Stream ended without a `done` or `error` frame — treat as error.
      setPhase("error");
      setErrorMsg("Deployment ended unexpectedly");
      setErrorHint(`The connection closed before the deploy finished. Check the ${meta.label} dashboard and retry.`);
    } catch (err) {
      setPhase("error");
      setErrorMsg("Network error");
      setErrorHint(err instanceof Error ? err.message : "Check your connection and try again.");
    }
  }

  const canDeploy = hasToken && ghConnected;

  // Build a partial-state recovery link when the provider returned one.
  let partialRecovery: { href: string; label: string } | null = null;
  if (errorPartial?.projectId && provider === "railway") {
    partialRecovery = {
      href: `https://railway.app/project/${errorPartial.projectId}`,
      label: "open in Railway",
    };
  } else if (errorPartial?.serviceId && provider === "render") {
    partialRecovery = {
      href: `https://dashboard.render.com/web/${errorPartial.serviceId}`,
      label: "open in Render",
    };
  } else if (errorPartial?.appName && provider === "fly") {
    partialRecovery = {
      href: `https://fly.io/apps/${errorPartial.appName}`,
      label: "open in Fly",
    };
  } else if (errorPartial?.projectId && provider === "vercel") {
    partialRecovery = {
      href: `https://vercel.com/dashboard`,
      label: "open Vercel dashboard",
    };
  }

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-20" />
      <div className="relative p-5 space-y-4">
        <div className="flex items-center gap-2">
          <BrandIcon id={provider} size={20} rounded="sm" />
          <span className="text-sm font-semibold">Deploy to {meta.label}</span>
        </div>

        {/* Prerequisites */}
        {phase === "idle" && (
          <div className="space-y-1.5">
            <PrereqRow
              label="GitHub connected"
              ok={ghConnected === true}
              loading={ghConnected === null}
              action={
                ghConnected === false ? (
                  <a
                    href="/api/auth/github?mode=connect&returnTo=/deploy"
                    className="text-xs text-brand-300 hover:underline"
                  >
                    Connect →
                  </a>
                ) : null
              }
            />
            <PrereqRow
              label={`${meta.label} token saved`}
              ok={hasToken === true}
              loading={hasToken === null}
              action={
                hasToken === false ? (
                  <a href="/settings" className="text-xs text-brand-300 hover:underline">
                    Add in Settings →
                  </a>
                ) : null
              }
            />
          </div>
        )}

        {/* Idle state */}
        {phase === "idle" && (
          <Button
            variant="glow"
            size="lg"
            className="w-full"
            onClick={() => void deploy()}
            disabled={!canDeploy}
          >
            <Rocket className="h-4 w-4" />
            Deploy to {meta.label}
          </Button>
        )}

        {/* Deploying */}
        {phase === "deploying" && (
          <div className="space-y-3">
            {stagesList.map((s) => (
              <DeployStepRowV2
                key={s}
                label={ui.labels[s]}
                state={stages[s] ?? "waiting"}
                detail={stageDetail[s]}
              />
            ))}
            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2 text-[11px] text-amber-200/80 space-y-0.5">
                {warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Success */}
        {phase === "done" && result && (
          <div className="space-y-3">
            {stagesList.map((s) => (
              <DeployStepRowV2
                key={s}
                label={ui.labels[s]}
                state={stages[s] ?? "waiting"}
                detail={stageDetail[s]}
              />
            ))}

            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2 text-[11px] text-amber-200/80 space-y-0.5">
                {warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-3 space-y-2.5">
              <p className="text-xs font-medium text-emerald-300">{ui.successMessage}</p>
              <p className="text-xs text-muted-foreground">{ui.deployingMessage}</p>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <a
                  href={result.projectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-brand-300 hover:underline"
                >
                  <Rocket className="h-3 w-3" /> Open {meta.label} dashboard
                </a>
                <a
                  href={result.githubUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ArrowRight className="h-3 w-3" /> {result.fullName} on GitHub
                </a>
                {result.domain && (
                  <a
                    href={result.domain}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-emerald-300 hover:underline"
                  >
                    <Globe2 className="h-3 w-3" /> {result.domain}
                  </a>
                )}
              </div>
              {result.nextStep && (
                <div className="mt-1 rounded-md border border-white/[0.06] bg-white/[0.02] p-2 text-[11px] text-muted-foreground space-y-1">
                  <p>{result.nextStep.message}</p>
                  {result.nextStep.command && (
                    <code className="block w-full overflow-x-auto rounded bg-black/40 px-2 py-1 font-mono text-[10.5px] text-foreground/90">
                      {result.nextStep.command}
                    </code>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={() => { setPhase("idle"); setResult(null); }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              Deploy again
            </button>
          </div>
        )}

        {/* Error */}
        {phase === "error" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] p-3 flex items-start gap-2">
              <X className="h-3.5 w-3.5 text-red-400 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-red-300">{errorMsg || "Deployment failed"}</p>
                {errorHint && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{errorHint}</p>
                )}
                {partialRecovery && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Partial resource created:{" "}
                    <a
                      className="underline hover:text-foreground"
                      href={partialRecovery.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {partialRecovery.label}
                    </a>
                    {" "}— review or delete before retrying to avoid duplicates.
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => setPhase("idle")}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function PrereqRow({
  label,
  ok,
  loading,
  action,
}: {
  label: string;
  ok: boolean;
  loading?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <div className="flex items-center gap-2">
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : ok ? (
          <Check className="h-3 w-3 text-emerald-400" />
        ) : (
          <X className="h-3 w-3 text-red-400" />
        )}
        <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
      </div>
      {!ok && action}
    </div>
  );
}

function DeployStepRowV2({
  label,
  state,
  detail,
}: {
  label: string;
  state: StageState;
  detail?: string;
}) {
  const isLink = detail?.startsWith("http");
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2.5">
        {state === "done" ? (
          <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
        ) : state === "active" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-300 shrink-0" />
        ) : state === "skipped" ? (
          <MinusCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <span className="h-3.5 w-3.5 rounded-full border border-white/20 shrink-0" />
        )}
        <span className={state === "waiting" || state === "skipped" ? "text-muted-foreground" : "text-foreground"}>
          {label}
          {state === "skipped" && <span className="ml-1 text-[10px] text-muted-foreground">(skipped)</span>}
        </span>
      </div>
      {detail && (
        <div className="ml-6 mt-0.5 truncate text-[11px] text-muted-foreground">
          {isLink ? (
            <a href={detail} target="_blank" rel="noreferrer" className="hover:text-foreground underline-offset-2 hover:underline">
              {detail}
            </a>
          ) : (
            detail
          )}
        </div>
      )}
    </div>
  );
}

function DeployCTA({ onGenerate }: { onGenerate: () => void }) {
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-30" />
      <div className="relative p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-brand-300" />
          Ready to ship
        </div>
        <div className="mt-2 text-sm">
          Get a step-by-step deployment guide for your chosen provider with the
          exact CLI commands to go live.
        </div>
        <Button onClick={onGenerate} variant="glow" size="lg" className="mt-4 w-full">
          <FileText className="h-4 w-4" />
          Generate deployment guide
        </Button>
      </div>
    </Card>
  );
}

// ─── Provider-specific step definitions ──────────────────────────────────────

type GuideStep = {
  text: string;
  code?: string;
};

function getGuideSteps(provider: string, name: string, region: string, envVars: { key: string; value: string; secret?: boolean }[], database: string): GuideStep[] {
  const firstEnvVar = envVars[0]?.key ?? "DATABASE_URL";
  const extraEnvVars = envVars.slice(1).map((v) => v.key);

  switch (provider) {
    case "vercel":
      return [
        { text: "Install Vercel CLI and log in", code: "npm i -g vercel && vercel login" },
        { text: "Link your project in the project root", code: "vercel link" },
        {
          text: `Set environment variables: add each one via the CLI`,
          code: [`vercel env add ${firstEnvVar}`, ...extraEnvVars.map((k) => `vercel env add ${k}`)].join("\n"),
        },
        { text: "Deploy to production", code: "vercel deploy --prod" },
        { text: "Your app will be live at https://your-project.vercel.app" },
      ];

    case "railway":
      return [
        { text: "Install Railway CLI and log in", code: "npm i -g @railway/cli && railway login" },
        { text: "Link your project in the project root", code: "railway link" },
        ...(database === "postgres"
          ? [{ text: "From the Railway dashboard: add a Postgres plugin, then copy the DATABASE_URL it provides" }]
          : []),
        {
          text: "Set environment variables",
          code: [`railway variables set ${firstEnvVar}=...`, ...extraEnvVars.map((k) => `railway variables set ${k}=...`)].join("\n"),
        },
        { text: "Deploy your app", code: "railway up" },
        { text: "Your app will be live at https://your-project.up.railway.app" },
      ];

    case "render":
      return [
        { text: "Push your code to a GitHub repository" },
        { text: "Go to render.com → New → Web Service → connect your repo" },
        {
          text: "Set the Build Command",
          code: database === "postgres" || database === "mysql" || database === "mongodb"
            ? "npm install && npm run build"
            : "go build ./...",
        },
        {
          text: "Set the Start Command — use the binary or entry point for your language (e.g. ./server or node dist/index.js)",
        },
        { text: "Add environment variables from the Environment tab in the Render dashboard" },
        ...(database === "postgres"
          ? [{ text: "Add a Postgres service from the Render dashboard and copy the connection string to DATABASE_URL" }]
          : database === "redis"
          ? [{ text: "Add a Redis service from the Render dashboard and copy the connection string" }]
          : []),
        { text: "Click Deploy — Render will build and start your service automatically" },
      ];

    case "fly":
      return [
        { text: "Install flyctl and authenticate", code: `brew install flyctl && flyctl auth login` },
        { text: `Launch your app — flyctl will create fly.toml and let you choose a region near ${region}`, code: "flyctl launch" },
        {
          text: "Set secrets for your environment variables",
          code: [`flyctl secrets set ${firstEnvVar}=...`, ...extraEnvVars.map((k) => `flyctl secrets set ${k}=...`)].join("\n"),
        },
        { text: "Deploy your app", code: "flyctl deploy" },
        { text: "Your app will be live at https://your-app.fly.dev" },
      ];

    case "aws":
      return [
        { text: "Configure your AWS CLI credentials", code: "aws configure" },
        { text: "Create an ECR repository for your image", code: `aws ecr create-repository --repository-name ${name}` },
        {
          text: "Build and push your Docker image",
          code: [
            `docker build -t ${name} .`,
            `docker tag ${name}:latest {account}.dkr.ecr.${region}.amazonaws.com/${name}:latest`,
            `docker push {account}.dkr.ecr.${region}.amazonaws.com/${name}:latest`,
          ].join("\n"),
        },
        {
          text: "Deploy to AWS App Runner or ECS — visit the AWS Console to create a service pointing to your ECR image",
        },
        {
          text: "Set environment variables as ECS task secrets or App Runner environment variables in the service configuration",
        },
      ];

    case "gcp":
      return [
        { text: "Authenticate with Google Cloud", code: "gcloud auth login" },
        { text: "Set your project", code: "gcloud config set project YOUR_PROJECT_ID" },
        { text: "Build and push your container image", code: `gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/${name}` },
        {
          text: "Deploy to Cloud Run",
          code: `gcloud run deploy ${name} --image gcr.io/YOUR_PROJECT_ID/${name} --platform managed --region ${region} --allow-unauthenticated`,
        },
        {
          text: "Set environment variables on the Cloud Run service",
          code: `gcloud run services update ${name} --set-env-vars ${firstEnvVar}=...`,
        },
      ];

    case "azure":
      return [
        { text: "Log in to Azure", code: "az login" },
        { text: "Create an Azure Container Registry", code: `az acr create --name ${name}acr --resource-group myRG --sku Basic` },
        { text: "Build and push your image to ACR", code: `az acr build --registry ${name}acr --image ${name}:latest .` },
        {
          text: "Deploy to Azure Container Apps",
          code: `az containerapp up --name ${name} --resource-group myRG --image ${name}acr.azurecr.io/${name}:latest`,
        },
      ];

    case "k8s":
      return [
        { text: "Build and push your Docker image to your container registry" },
        { text: `Update the image field in deploy/k8s/deployment.yaml with your actual image URL` },
        { text: "Create a Kubernetes secret from your .env file", code: `kubectl create secret generic ${name}-env --from-env-file=.env` },
        { text: "Apply all Kubernetes manifests", code: "kubectl apply -f deploy/k8s/" },
        { text: "Verify your pods are running", code: "kubectl get pods -n default" },
      ];

    default:
      // Safe default: railway steps
      return [
        { text: "Install Railway CLI and log in", code: "npm i -g @railway/cli && railway login" },
        { text: "Link your project in the project root", code: "railway link" },
        ...(database === "postgres"
          ? [{ text: "From the Railway dashboard: add a Postgres plugin, then copy the DATABASE_URL it provides" }]
          : []),
        {
          text: "Set environment variables",
          code: [`railway variables set ${firstEnvVar}=...`, ...extraEnvVars.map((k) => `railway variables set ${k}=...`)].join("\n"),
        },
        { text: "Deploy your app", code: "railway up" },
        { text: "Your app will be live at https://your-project.up.railway.app" },
      ];
  }
}

// ─── DeployGuide component ───────────────────────────────────────────────────

function DeployGuide({ onBack }: { onBack: () => void }) {
  const { config } = useStackStore();
  const provider = config.deployment;
  const providerLabel = deployments.find((d) => d.id === provider)?.label ?? provider;
  const steps = getGuideSteps(provider, config.name, config.region, config.envVars, config.database);

  async function copyAllSteps() {
    const text = steps
      .map((s, i) => {
        const lines = [`${i + 1}. ${s.text}`];
        if (s.code) {
          lines.push("");
          lines.push(s.code.split("\n").map((l) => `   ${l}`).join("\n"));
          lines.push("");
        }
        return lines.join("\n");
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied all steps", kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  async function copySnippet(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast({ title: "Copied to clipboard", kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <BrandIcon id={provider} size={28} rounded="md" />
          <CardTitle className="text-base">
            Your {providerLabel} deployment guide
          </CardTitle>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Badge variant="purple">
            <FileText className="h-2.5 w-2.5" />
            Download included in your zip as DEPLOY.md
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {steps.map((s, i) => (
          <GuideStepRow
            key={i}
            index={i + 1}
            text={s.text}
            code={s.code}
            onCopy={copySnippet}
          />
        ))}

        <Separator className="my-4" />

        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={copyAllSteps}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy all steps
        </Button>

        <Button asChild variant="glow" size="sm" className="w-full">
          <Link href="/preview">
            <Rocket className="h-3.5 w-3.5" />
            Download your code
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Link>
        </Button>

        <button
          onClick={onBack}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
        >
          ← Back to configure
        </button>
      </CardContent>
    </Card>
  );
}

function GuideStepRow({
  index,
  text,
  code,
  onCopy,
}: {
  index: number;
  text: string;
  code?: string;
  onCopy: (code: string) => void;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-[10px] font-semibold text-brand-300">
        {index}
      </span>
      <div className="flex-1 space-y-1.5">
        <p className="text-sm leading-relaxed">{text}</p>
        {code ? (
          <div className="group relative rounded-lg border border-white/[0.06] bg-black/40 px-3 py-2">
            <pre className="overflow-x-auto font-mono text-[11px] text-emerald-300 whitespace-pre-wrap break-all">
              {code}
            </pre>
            <button
              onClick={() => onCopy(code)}
              className="absolute right-2 top-2 hidden rounded p-1 text-muted-foreground hover:text-foreground hover:bg-white/[0.06] group-hover:flex"
              title="Copy"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

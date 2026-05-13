"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FolderGit2,
  Github,
  GitBranch,
  Loader2,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/shared/brand-icon";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  languages,
  frameworks,
  databases,
  caches,
  queues,
  apis,
  authProviders,
  deployments,
  cicd,
  monitoring,
  scalingStrategies,
} from "@/data/stack-options";
import type { StackConfig } from "@/lib/store";
import type { Confidence } from "@/lib/repo-analyzer";

// ─── Types ────────────────────────────────────────────────────────────────────

type Signal = {
  field: keyof StackConfig;
  value: string;
  source: string;
  confidence: Confidence;
};

type AnalyzeResult = {
  repo: { owner: string; repo: string; defaultBranch: string };
  config: Partial<StackConfig>;
  signals: Signal[];
  confidence: Partial<Record<keyof StackConfig, Confidence>>;
  enrichedByLLM: boolean;
  filesAnalyzed: number;
};

type Phase =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "error"; message: string; hint?: string }
  | { type: "results"; data: AnalyzeResult };

// ─── Option lookups ───────────────────────────────────────────────────────────

function labelFor(options: { id: string; label: string }[], id: string | undefined): string {
  if (!id) return "";
  return options.find((o) => o.id === id)?.label ?? id;
}

function frameworkOptions(lang: string | undefined) {
  return frameworks[lang ?? ""] ?? [];
}

// ─── Field definitions ────────────────────────────────────────────────────────

type FieldDef = {
  key: keyof StackConfig;
  label: string;
  options: { id: string; label: string }[];
  group: "Core" | "Data" | "Infrastructure";
};

function buildFieldDefs(detectedLang: string | undefined): FieldDef[] {
  return [
    { key: "language",   label: "Language",    options: languages,               group: "Core" },
    { key: "framework",  label: "Framework",   options: frameworkOptions(detectedLang), group: "Core" },
    { key: "api",        label: "API Style",   options: apis,                    group: "Core" },
    { key: "auth",       label: "Auth",        options: authProviders,           group: "Core" },
    { key: "database",   label: "Database",    options: databases,               group: "Data" },
    { key: "cache",      label: "Cache",       options: caches,                  group: "Data" },
    { key: "queue",      label: "Queue",       options: queues,                  group: "Data" },
    { key: "deployment", label: "Deployment",  options: deployments,             group: "Infrastructure" },
    { key: "cicd",       label: "CI/CD",       options: cicd,                    group: "Infrastructure" },
    { key: "monitoring", label: "Monitoring",  options: monitoring,              group: "Infrastructure" },
    { key: "scaling",    label: "Scaling",     options: scalingStrategies,       group: "Infrastructure" },
  ];
}

// ─── Confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ level }: { level: Confidence | undefined }) {
  if (!level) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground">
        <CircleHelp className="h-2.5 w-2.5" /> unknown
      </span>
    );
  }
  const map: Record<Confidence, { cls: string; dot: string; label: string }> = {
    high:   { cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", label: "high" },
    medium: { cls: "border-amber-500/30 bg-amber-500/10 text-amber-300",       dot: "bg-amber-400",   label: "medium" },
    low:    { cls: "border-white/10 bg-white/[0.04] text-muted-foreground",    dot: "bg-white/40",    label: "low" },
  };
  const { cls, dot, label } = map[level];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]", cls)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

// ─── Field row ────────────────────────────────────────────────────────────────

function FieldRow({
  def,
  value,
  confidence,
  override,
  onOverride,
}: {
  def: FieldDef;
  value: string | undefined;
  confidence: Confidence | undefined;
  override: string | undefined;
  onOverride: (v: string) => void;
}) {
  const active = override ?? value;
  const displayLabel = labelFor(def.options, active);
  const isUnknown = !active;
  const isEditable = !confidence || confidence !== "high" || !!override;

  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        {active ? (
          <BrandIcon id={active} size={18} />
        ) : (
          <div className="h-[18px] w-[18px] rounded bg-white/[0.06] border border-white/10" />
        )}
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{def.label}</div>
          <div className={cn("text-sm font-medium", isUnknown && "text-muted-foreground/60 italic")}>
            {displayLabel || "Not detected"}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <ConfidenceBadge level={override ? "medium" : confidence} />
        {isEditable && def.options.length > 0 && (
          <select
            value={override ?? value ?? ""}
            onChange={(e) => onOverride(e.target.value)}
            className="rounded-md border border-white/[0.08] bg-black/40 px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-brand-500/40 cursor-pointer"
          >
            {!value && <option value="">— pick —</option>}
            {def.options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

// ─── Results view ─────────────────────────────────────────────────────────────

function ResultsView({
  data,
  onReset,
}: {
  data: AnalyzeResult;
  onReset: () => void;
}) {
  const { patch } = useStackStore();
  const router = useRouter();
  const [overrides, setOverrides] = React.useState<Partial<StackConfig>>({});

  const detectedLang = (overrides.language ?? data.config.language) as string | undefined;
  const fieldDefs = React.useMemo(() => buildFieldDefs(detectedLang), [detectedLang]);

  function setOverride<K extends keyof StackConfig>(key: K, val: string) {
    setOverrides((prev) => ({ ...prev, [key]: val as StackConfig[K] }));
  }

  const groups: Array<"Core" | "Data" | "Infrastructure"> = ["Core", "Data", "Infrastructure"];

  const detectedCount = fieldDefs.filter(
    (d) => data.config[d.key] !== undefined || overrides[d.key] !== undefined
  ).length;

  const highCount = fieldDefs.filter(
    (d) => data.confidence[d.key] === "high"
  ).length;

  function loadIntoBuilder() {
    const finalConfig: Partial<StackConfig> = {
      ...data.config,
      ...overrides,
    };
    patch(finalConfig);
    toast({
      title: `Loaded "${data.repo.repo}"`,
      description: `${detectedCount} fields detected · open builder to refine`,
      kind: "success",
    });
    router.push("/builder");
  }

  function viewPreview() {
    const finalConfig: Partial<StackConfig> = { ...data.config, ...overrides };
    patch(finalConfig);
    router.push("/preview");
  }

  return (
    <div className="space-y-6">
      {/* Repo header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
            <Github className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{data.repo.owner}/{data.repo.repo}</span>
              <a
                href={`https://github.com/${data.repo.owner}/${data.repo.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              <span>{data.repo.defaultBranch}</span>
              <span>·</span>
              <span>{data.filesAnalyzed} files scanned</span>
              {data.enrichedByLLM && (
                <>
                  <span>·</span>
                  <span className="text-brand-300 flex items-center gap-1"><Sparkles className="h-3 w-3" /> AI-enriched</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-xs text-muted-foreground">
            <span className="text-foreground font-medium">{highCount}</span> high-confidence · <span className="text-foreground font-medium">{detectedCount}</span> detected
          </div>
          <Button variant="ghost" size="sm" onClick={onReset}>
            <ArrowLeft className="h-3.5 w-3.5" /> New repo
          </Button>
        </div>
      </div>

      {/* Field groups */}
      {groups.map((group) => {
        const groupFields = fieldDefs.filter((d) => d.group === group);
        return (
          <Card key={group}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{group}</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {groupFields.map((def) => (
                <FieldRow
                  key={def.key}
                  def={def}
                  value={data.config[def.key] as string | undefined}
                  confidence={data.confidence[def.key]}
                  override={overrides[def.key] as string | undefined}
                  onOverride={(v) => setOverride(def.key, v)}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}

      {/* Bool fields */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Features</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          {(
            [
              ["docker", "Docker"],
              ["kubernetes", "Kubernetes"],
              ["helm", "Helm"],
              ["tracing", "Tracing"],
            ] as const
          ).map(([key, label]) => {
            const detected = data.config[key];
            return (
              <div key={key} className="flex items-center gap-2 py-2">
                {detected ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                ) : (
                  <div className="h-4 w-4 rounded-full border border-white/10 shrink-0" />
                )}
                <span className="text-xs">{label}</span>
                {detected !== undefined && (
                  <ConfidenceBadge level={data.confidence[key] ?? "medium"} />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Signals detail (collapsed) */}
      {data.signals.length > 0 && (
        <SignalsDetail signals={data.signals} />
      )}

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
        <Button variant="glow" size="lg" className="flex-1 sm:flex-none" onClick={loadIntoBuilder}>
          <FolderGit2 className="h-4 w-4" />
          Load into builder
          <ArrowRight className="h-4 w-4 ml-1" />
        </Button>
        <Button variant="secondary" size="lg" onClick={viewPreview}>
          <Sparkles className="h-4 w-4" />
          Preview generated files
        </Button>
        <p className="text-xs text-muted-foreground sm:ml-auto self-center">
          Review detections above, then load or override any field before continuing.
        </p>
      </div>
    </div>
  );
}

function SignalsDetail({ signals }: { signals: Signal[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02]"
      >
        <span className="text-xs font-medium">Detection signals ({signals.length})</span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-white/[0.04] divide-y divide-white/[0.04]">
          {signals.map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-xs">
              <span className="text-muted-foreground w-24 shrink-0">{s.field}</span>
              <span className="font-mono text-brand-200">{s.value}</span>
              <span className="text-muted-foreground/60 truncate">from {s.source}</span>
              <ConfidenceBadge level={s.confidence} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── URL input step ────────────────────────────────────────────────────────────

function UrlInputStep({ onResult }: { onResult: (r: AnalyzeResult) => void; onError: (msg: string, hint?: string) => void }) {
  const [url, setUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [showToken, setShowToken] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [ghConnected, setGhConnected] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth/github/status")
      .then((r) => r.json())
      .then((d: { connected?: boolean }) => setGhConnected(d.connected ?? false))
      .catch(() => {});
  }, []);

  async function analyze() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      const res = await fetch("/api/repo/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed, token: token.trim() || undefined }),
      });
      const data = await res.json() as AnalyzeResult & { error?: string; hint?: string };
      if (!res.ok) {
        const msg = data.error === "repo_not_found"
          ? "Repository not found or not accessible"
          : data.error === "invalid_github_url"
          ? "That doesn't look like a valid GitHub URL"
          : data.error === "rate_limited"
          ? "Too many requests — try again in a minute"
          : "Analysis failed";
        toast({ title: msg, description: data.hint, kind: "error" });
        return;
      }
      onResult(data);
    } catch {
      toast({ title: "Network error", description: "Check your connection and try again.", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  const EXAMPLES = [
    "https://github.com/gin-gonic/gin",
    "https://github.com/tiangolo/fastapi",
    "https://github.com/nestjs/nest",
  ];

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-gradient-to-br from-brand-500/20 to-purple-500/20 border border-white/[0.08] grid place-items-center">
          <FolderGit2 className="h-7 w-7 text-brand-300" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Analyze an existing repo</h1>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          Paste a GitHub URL and Helios will detect your stack — language, framework, database, auth, CI/CD and more.
        </p>
      </div>

      {ghConnected && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-xs text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          GitHub connected — private repos accessible
        </div>
      )}

      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">GitHub repository URL</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Github className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
                  placeholder="https://github.com/owner/repo"
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                />
              </div>
              <Button
                variant="glow"
                size="sm"
                onClick={() => void analyze()}
                disabled={loading || !url.trim()}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {loading ? "Scanning…" : "Analyze"}
              </Button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showToken && "rotate-180")} />
            Private repo? Add a GitHub token
          </button>

          {showToken && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Personal access token (PAT)</label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
              />
              <p className="text-[11px] text-muted-foreground">
                Needs <code>repo</code> scope. Not stored — used only for this request.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-2">
        <p className="text-[11px] text-center text-muted-foreground uppercase tracking-wider">Try an example</p>
        <div className="flex flex-col gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setUrl(ex)}
              className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left text-xs hover:bg-white/[0.04] group"
            >
              <Github className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-mono text-muted-foreground group-hover:text-foreground truncate">{ex}</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FromRepoPage() {
  const [phase, setPhase] = React.useState<Phase>({ type: "idle" });

  function handleResult(data: AnalyzeResult) {
    setPhase({ type: "results", data });
  }

  function handleError(message: string, hint?: string) {
    setPhase({ type: "error", message, hint });
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Import from repo" },
      ]}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
        </Button>
      }
    >
      <div className="max-w-[900px] mx-auto p-6 md:p-8 space-y-6">
        {/* Step breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn(phase.type === "idle" ? "text-foreground font-medium" : "")}>Paste URL</span>
          <ChevronRight className="h-3 w-3" />
          <span className={cn(phase.type === "results" ? "text-foreground font-medium" : "")}>Review detections</span>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground/40">Load into builder</span>
        </div>

        {phase.type === "idle" && (
          <UrlInputStep onResult={handleResult} onError={handleError} />
        )}

        {phase.type === "error" && (
          <div className="max-w-xl mx-auto">
            <Card>
              <CardContent className="pt-6 text-center space-y-4">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-red-500/10 border border-red-500/20">
                  <TriangleAlert className="h-6 w-6 text-red-400" />
                </div>
                <div>
                  <div className="font-semibold">{phase.message}</div>
                  {phase.hint && <p className="mt-1 text-xs text-muted-foreground">{phase.hint}</p>}
                </div>
                <Button variant="secondary" size="sm" onClick={() => setPhase({ type: "idle" })}>
                  <ArrowLeft className="h-3.5 w-3.5" /> Try again
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {phase.type === "results" && (
          <ResultsView data={phase.data} onReset={() => setPhase({ type: "idle" })} />
        )}
      </div>
    </WorkspaceShell>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  FileCode,
  GitBranch,
  GitPullRequest,
  Github,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { BrandIcon } from "@/components/shared/brand-icon";
import { toast } from "@/components/ui/toast";
import type { Audit, Finding, PrProposal } from "@/lib/autopilot/schema";
import { cn } from "@/lib/utils";

type Phase =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "audited"; audit: Audit }
  | { kind: "proposing"; audit: Audit; proposal?: PrProposal }
  | { kind: "proposed"; audit: Audit; proposal: PrProposal }
  | { kind: "opening"; audit: Audit; proposal: PrProposal }
  | {
      kind: "opened";
      audit: Audit;
      proposal: PrProposal;
      pr: { number: number; htmlUrl: string };
    }
  | { kind: "error"; message: string };

export default function AutopilotPage() {
  const [token, setToken] = React.useState("");
  const [repoUrl, setRepoUrl] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const repo = React.useMemo(() => parseRepoUrl(repoUrl), [repoUrl]);

  function reset() {
    setPhase({ kind: "idle" });
    setSelected(new Set());
  }

  async function analyze() {
    if (!repo) {
      toast({
        title: "Invalid repo",
        description: "Paste a GitHub URL like https://github.com/owner/repo",
        kind: "error",
      });
      return;
    }
    if (!/^(ghp_|github_pat_|gho_)/.test(token)) {
      toast({
        title: "Token looks wrong",
        description:
          "Paste a GitHub PAT starting with ghp_ or github_pat_.",
        kind: "error",
      });
      return;
    }
    setPhase({ kind: "analyzing" });
    try {
      const res = await fetch("/api/autopilot/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, repo }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      const audit = (await res.json()) as Audit;
      setPhase({ kind: "audited", audit });
      // preselect warnings + criticals by default
      const preselect = new Set(
        audit.findings
          .filter((f) => f.severity !== "info")
          .map((f) => f.id)
      );
      setSelected(preselect);
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }

  async function propose() {
    if (phase.kind !== "audited") return;
    if (selected.size === 0) {
      toast({ title: "Select at least one finding", kind: "info" });
      return;
    }
    setPhase({ kind: "proposing", audit: phase.audit });
    try {
      const res = await fetch("/api/autopilot/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          repo,
          audit: phase.audit,
          findingIds: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      const { proposal } = (await res.json()) as { proposal: PrProposal };
      setPhase({ kind: "proposed", audit: phase.audit, proposal });
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }

  async function openPr() {
    if (phase.kind !== "proposed") return;
    setPhase({
      kind: "opening",
      audit: phase.audit,
      proposal: phase.proposal,
    });
    try {
      const res = await fetch("/api/autopilot/open-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          repo,
          baseBranch: phase.audit.repo.defaultBranch,
          proposal: phase.proposal,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      const pr = (await res.json()) as { number: number; htmlUrl: string };
      setPhase({
        kind: "opened",
        audit: phase.audit,
        proposal: phase.proposal,
        pr,
      });
      toast({
        title: `PR #${pr.number} opened`,
        description: pr.htmlUrl,
        kind: "success",
      });
    } catch (err) {
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: "Autopilot" },
      ]}
    >
      <div className="mx-auto max-w-6xl p-6 md:p-8 space-y-6">
        <HeaderBlock phase={phase} onReset={reset} />

        <StepIndicator phase={phase} />

        <div className="grid gap-6 lg:grid-cols-[1fr,340px]">
          <div className="space-y-6 min-w-0">
            {phase.kind === "idle" || phase.kind === "analyzing" ? (
              <ConnectCard
                token={token}
                onToken={setToken}
                repoUrl={repoUrl}
                onRepoUrl={setRepoUrl}
                onAnalyze={analyze}
                analyzing={phase.kind === "analyzing"}
              />
            ) : null}

            {phase.kind === "audited" ||
            phase.kind === "proposing" ||
            phase.kind === "proposed" ||
            phase.kind === "opening" ||
            phase.kind === "opened" ? (
              <AuditCard
                audit={
                  phase.kind === "audited"
                    ? phase.audit
                    : phase.kind === "proposing"
                    ? phase.audit
                    : phase.kind === "proposed"
                    ? phase.audit
                    : phase.kind === "opening"
                    ? phase.audit
                    : phase.audit
                }
                selected={selected}
                setSelected={setSelected}
                editable={phase.kind === "audited"}
              />
            ) : null}

            {phase.kind === "proposing" ? <ProposalSkeleton /> : null}
            {phase.kind === "proposed" ||
            phase.kind === "opening" ||
            phase.kind === "opened" ? (
              <ProposalCard
                proposal={
                  phase.kind === "proposed"
                    ? phase.proposal
                    : phase.kind === "opening"
                    ? phase.proposal
                    : phase.proposal
                }
                pr={phase.kind === "opened" ? phase.pr : null}
              />
            ) : null}

            {phase.kind === "error" ? (
              <Card className="border-red-500/30 bg-red-500/[0.05] p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-4 w-4 text-red-300 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-red-200">
                      Autopilot hit an error
                    </div>
                    <p className="mt-1 text-xs text-red-300/90">
                      {phase.message}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-3"
                      onClick={reset}
                    >
                      Start over
                    </Button>
                  </div>
                </div>
              </Card>
            ) : null}
          </div>

          {/* right rail */}
          <div className="space-y-4">
            <ActionCard
              phase={phase}
              onAnalyze={analyze}
              onPropose={propose}
              onOpenPr={openPr}
              disabled={!repo || selected.size === 0}
              selectedCount={selected.size}
            />
            <HowItWorks />
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({ phase, onReset }: { phase: Phase; onReset: () => void }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-6">
      <div className="pointer-events-none absolute -right-20 -top-20 h-[280px] w-[420px] aurora animate-aurora opacity-60" />
      <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="brand">
              <Bot className="h-3 w-3" /> Autopilot
            </Badge>
            <Badge variant="outline">Beta</Badge>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Point Helios at a repo. Get a PR.
          </h1>
          <p className="mt-1.5 text-xs text-muted-foreground max-w-xl">
            Autopilot audits any GitHub repo in seconds, proposes concrete
            improvements (Dockerfile, CI, Dependabot, outdated runtimes), and
            opens one pull request with all the fixes.
          </p>
        </div>
        {phase.kind !== "idle" ? (
          <Button variant="secondary" size="sm" onClick={onReset}>
            <RotateCcw className="h-3.5 w-3.5" /> Start over
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function StepIndicator({ phase }: { phase: Phase }) {
  const steps = [
    { id: "connect", label: "Connect" },
    { id: "audit", label: "Audit" },
    { id: "propose", label: "Propose" },
    { id: "ship", label: "Ship" },
  ];
  const current = phaseToStep(phase);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {steps.map((s, i) => {
        const state =
          i < current ? "done" : i === current ? "active" : "idle";
        return (
          <React.Fragment key={s.id}>
            <div
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
                state === "done"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : state === "active"
                  ? "border-brand-500/40 bg-brand-500/10 text-brand-300"
                  : "border-white/10 bg-white/[0.02] text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "grid h-4 w-4 place-items-center rounded-full text-[10px] font-semibold",
                  state === "done"
                    ? "bg-emerald-500/20"
                    : state === "active"
                    ? "bg-brand-500/20"
                    : "bg-white/[0.04]"
                )}
              >
                {state === "done" ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {s.label}
            </div>
            {i < steps.length - 1 ? (
              <span className="text-white/20">›</span>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function phaseToStep(phase: Phase): number {
  switch (phase.kind) {
    case "idle":
    case "analyzing":
      return 0;
    case "audited":
      return 1;
    case "proposing":
    case "proposed":
      return 2;
    case "opening":
      return 2;
    case "opened":
      return 3;
    default:
      return 0;
  }
}

function ConnectCard({
  token,
  onToken,
  repoUrl,
  onRepoUrl,
  onAnalyze,
  analyzing,
}: {
  token: string;
  onToken: (v: string) => void;
  repoUrl: string;
  onRepoUrl: (v: string) => void;
  onAnalyze: () => void;
  analyzing: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github className="h-4 w-4" /> Connect a repository
        </CardTitle>
        <CardDescription>
          Autopilot uses a personal access token with the <code>repo</code>{" "}
          scope. Tokens are used server-side for this request only and never
          stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs text-muted-foreground mb-1.5 block">
            GitHub repository URL
          </label>
          <Input
            value={repoUrl}
            onChange={(e) => onRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs text-muted-foreground">
              Personal access token
            </label>
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=Helios+Autopilot"
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-brand-300 hover:text-brand-200 inline-flex items-center gap-1"
            >
              Create one <ArrowRight className="h-3 w-3" />
            </a>
          </div>
          <Input
            type="password"
            value={token}
            onChange={(e) => onToken(e.target.value.trim())}
            placeholder="ghp_••••••••••••••••"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button
          variant="glow"
          size="lg"
          onClick={onAnalyze}
          disabled={analyzing || !token || !repoUrl}
          className="w-full"
        >
          {analyzing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {analyzing ? "Auditing…" : "Audit this repo"}
        </Button>
      </CardContent>
    </Card>
  );
}

function AuditCard({
  audit,
  selected,
  setSelected,
  editable,
}: {
  audit: Audit;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  editable: boolean;
}) {
  const scoreTone =
    audit.score >= 80
      ? "text-emerald-300"
      : audit.score >= 60
      ? "text-amber-300"
      : "text-red-300";
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <a
              href={audit.repo.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-mono hover:text-brand-300"
            >
              {audit.repo.owner}/{audit.repo.name}
            </a>
            <Badge variant="outline">
              <GitBranch className="h-3 w-3" /> {audit.repo.defaultBranch}
            </Badge>
            <Badge variant="outline">★ {audit.repo.stars}</Badge>
          </div>
          {audit.repo.description ? (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {audit.repo.description}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <BrandIcon id={audit.stack.language} size={22} />
            <span className="text-xs font-medium capitalize">
              {audit.stack.language}
            </span>
            {audit.stack.framework ? (
              <>
                <span className="text-white/20">·</span>
                <span className="text-xs font-mono">
                  {audit.stack.framework}
                </span>
              </>
            ) : null}
            {audit.stack.nodeVersion ? (
              <Badge variant="outline">Node {audit.stack.nodeVersion}</Badge>
            ) : null}
            {audit.stack.goVersion ? (
              <Badge variant="outline">Go {audit.stack.goVersion}</Badge>
            ) : null}
            {audit.stack.pythonVersion ? (
              <Badge variant="outline">Python {audit.stack.pythonVersion}</Badge>
            ) : null}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Architecture score
          </div>
          <div className={`mt-0.5 text-2xl font-semibold ${scoreTone}`}>
            {audit.score}
            <span className="text-xs text-muted-foreground font-normal">
              /100
            </span>
          </div>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <StackFlag ok={audit.stack.hasDockerfile} label="Docker" />
          <StackFlag ok={audit.stack.hasCI} label="CI" />
          <StackFlag ok={audit.stack.hasTests} label="Tests" />
          <StackFlag ok={audit.stack.hasReadme} label="README" />
          <StackFlag ok={audit.stack.hasLicense} label="License" />
          <StackFlag ok={audit.stack.hasEnvExample} label=".env.example" />
          <StackFlag ok={audit.stack.hasGitignore} label=".gitignore" />
          <StackFlag ok={audit.stack.hasDependabot} label="Dependabot" />
        </div>
        <Separator />
        <div className="mt-4 space-y-2">
          {audit.findings.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No findings — this repo is in good shape.
            </div>
          ) : null}
          {audit.findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              checked={selected.has(f.id)}
              disabled={!editable}
              onToggle={() => {
                const next = new Set(selected);
                if (next.has(f.id)) next.delete(f.id);
                else next.add(f.id);
                setSelected(next);
              }}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function StackFlag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
        ok
          ? "border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-300"
          : "border-white/[0.06] bg-white/[0.02] text-muted-foreground"
      )}
    >
      {ok ? (
        <Check className="h-3 w-3" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {label}
    </div>
  );
}

function FindingRow({
  finding,
  checked,
  disabled,
  onToggle,
}: {
  finding: Finding;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tone =
    finding.severity === "critical"
      ? "border-red-500/30 bg-red-500/[0.05]"
      : finding.severity === "warning"
      ? "border-amber-500/20 bg-amber-500/[0.04]"
      : "border-white/[0.06] bg-white/[0.02]";
  const sevIcon =
    finding.severity === "critical" ? (
      <CircleAlert className="h-3.5 w-3.5 text-red-300" />
    ) : finding.severity === "warning" ? (
      <AlertCircle className="h-3.5 w-3.5 text-amber-300" />
    ) : (
      <Sparkles className="h-3.5 w-3.5 text-brand-300" />
    );
  return (
    <div className={cn("rounded-lg border p-3", tone)}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Switch
            checked={checked}
            onCheckedChange={onToggle}
            disabled={disabled}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {sevIcon}
            <span className="text-sm font-medium">{finding.title}</span>
            <Badge variant="outline" className="text-[10px] uppercase">
              {finding.category}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {finding.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {finding.proposedFiles.map((pf) => (
              <span
                key={pf.path}
                className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                <FileCode className="h-3 w-3" />
                {pf.action === "create" ? "+ " : "~ "}
                {pf.path}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProposalSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-brand-300" />
          <CardTitle>Drafting your pull request…</CardTitle>
        </div>
        <CardDescription>
          Claude is writing the code. This usually takes 8–20 seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
          >
            <div className="h-3 w-1/3 rounded bg-white/[0.04] animate-pulse" />
            <div className="mt-2 h-3 w-2/3 rounded bg-white/[0.04] animate-pulse" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ProposalCard({
  proposal,
  pr,
}: {
  proposal: PrProposal;
  pr: { number: number; htmlUrl: string } | null;
}) {
  return (
    <Card className={pr ? "border-emerald-500/30 bg-emerald-500/[0.03]" : undefined}>
      <div className="flex items-start justify-between gap-3 p-4 border-b border-white/[0.06]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-3.5 w-3.5 text-brand-300" />
            <span className="text-sm font-medium truncate">
              {proposal.title}
            </span>
            {pr ? (
              <Badge variant="success">
                <span className="h-1.5 w-1.5 rounded-full bg-current" /> #{pr.number}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{proposal.branch}</span>
            <span className="text-white/20">·</span>
            <span>{proposal.changes.length} file changes</span>
          </div>
        </div>
        {pr ? (
          <Button asChild variant="glow" size="sm">
            <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </Button>
        ) : null}
      </div>
      <div className="p-4 space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            PR description
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-foreground/90 leading-relaxed font-sans">
            {proposal.body}
          </pre>
        </div>
        <Separator />
        <div className="space-y-2">
          {proposal.changes.map((c) => (
            <details
              key={c.path}
              className="rounded-lg border border-white/[0.06] bg-white/[0.02] group"
            >
              <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-white/[0.03] rounded-lg">
                <span
                  className={cn(
                    "inline-flex h-5 items-center rounded border px-1.5 font-mono text-[9px] font-semibold tracking-wider",
                    c.action === "create"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                  )}
                >
                  {c.action === "create" ? "NEW" : "EDIT"}
                </span>
                <span className="font-mono text-xs">{c.path}</span>
                <span className="ml-auto text-[11px] text-muted-foreground truncate hidden md:block">
                  {c.summary}
                </span>
              </summary>
              <pre className="p-4 text-[12px] font-mono leading-relaxed text-white/85 overflow-auto max-h-[360px] border-t border-white/[0.04]">
                {c.content}
              </pre>
            </details>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ActionCard({
  phase,
  onAnalyze,
  onPropose,
  onOpenPr,
  selectedCount,
}: {
  phase: Phase;
  onAnalyze: () => void;
  onPropose: () => void;
  onOpenPr: () => void;
  disabled: boolean;
  selectedCount: number;
}) {
  let cta: React.ReactNode = null;
  if (phase.kind === "idle") {
    cta = (
      <Button variant="glow" size="lg" onClick={onAnalyze} className="w-full">
        <Sparkles className="h-4 w-4" /> Audit repo
      </Button>
    );
  } else if (phase.kind === "analyzing") {
    cta = (
      <Button variant="glow" size="lg" disabled className="w-full">
        <Loader2 className="h-4 w-4 animate-spin" /> Auditing…
      </Button>
    );
  } else if (phase.kind === "audited") {
    cta = (
      <Button
        variant="glow"
        size="lg"
        onClick={onPropose}
        disabled={selectedCount === 0}
        className="w-full"
      >
        <Zap className="h-4 w-4" /> Draft PR ({selectedCount})
      </Button>
    );
  } else if (phase.kind === "proposing") {
    cta = (
      <Button variant="glow" size="lg" disabled className="w-full">
        <Loader2 className="h-4 w-4 animate-spin" /> Drafting…
      </Button>
    );
  } else if (phase.kind === "proposed") {
    cta = (
      <Button variant="glow" size="lg" onClick={onOpenPr} className="w-full">
        <GitPullRequest className="h-4 w-4" /> Open pull request
      </Button>
    );
  } else if (phase.kind === "opening") {
    cta = (
      <Button variant="glow" size="lg" disabled className="w-full">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening PR…
      </Button>
    );
  } else if (phase.kind === "opened") {
    cta = (
      <Button asChild variant="glow" size="lg" className="w-full">
        <a
          href={phase.pr.htmlUrl}
          target="_blank"
          rel="noreferrer"
        >
          View PR #{phase.pr.number} <ArrowRight className="h-4 w-4" />
        </a>
      </Button>
    );
  }

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-30" />
      <div className="relative p-4">
        <div className="flex items-center gap-2 text-xs">
          <ShieldCheck className="h-3.5 w-3.5 text-brand-300" />
          <span className="font-semibold">Next step</span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {phaseCopy(phase)}
        </div>
        <div className="mt-4">
          <AnimatePresence mode="wait">
            <motion.div
              key={phase.kind}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              {cta}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Card>
  );
}

function phaseCopy(phase: Phase): string {
  switch (phase.kind) {
    case "idle":
      return "Paste a repo URL and a GitHub PAT to start an audit.";
    case "analyzing":
      return "Fetching repo manifests + inferring your stack…";
    case "audited":
      return "Pick the findings to fix — Claude will draft a single PR.";
    case "proposing":
      return "Writing file contents for your selected fixes.";
    case "proposed":
      return "Review the diff, then open the PR on GitHub.";
    case "opening":
      return "Creating branch, committing files, opening PR…";
    case "opened":
      return "Done. The PR is live on GitHub.";
    case "error":
      return "Something went wrong — check the error panel.";
  }
}

function HowItWorks() {
  const steps = [
    { icon: Github, text: "Connect with a GitHub PAT (repo scope)." },
    { icon: Sparkles, text: "Static audit runs — no repo clone, <3s." },
    { icon: Zap, text: "Pick what to fix. Claude writes production code." },
    { icon: GitPullRequest, text: "One PR, one branch, one commit." },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>How it works</CardTitle>
        <CardDescription>Audit → Propose → Ship. No surprises.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={i} className="flex items-start gap-3">
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.03] text-brand-300">
                <Icon className="h-3 w-3" />
              </div>
              <span className="text-xs text-muted-foreground leading-relaxed">
                {s.text}
              </span>
            </div>
          );
        })}
        <Separator />
        <div className="pt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3 w-3 text-emerald-300" />
          Tokens are used for one request and never stored.
        </div>
        <Link
          href="/start"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand-300 hover:text-brand-200"
        >
          Or architect a new project from scratch{" "}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}

function parseRepoUrl(
  url: string
): { owner: string; name: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // support owner/repo shorthand
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(trimmed);
  if (short) return { owner: short[1], name: short[2] };

  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return {
      owner: parts[0],
      name: parts[1].replace(/\.git$/, ""),
    };
  } catch {
    return null;
  }
}

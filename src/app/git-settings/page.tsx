"use client";

import * as React from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  GitBranch,
  GitMerge,
  Github,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { PRCreator } from "@/components/git/pr-creator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useStackStore } from "@/lib/store";
import { toast } from "@/components/ui/toast";
import {
  WORKFLOW_META,
  STRATEGY_META,
  renderWorkflowYaml,
  renderCommitlintYaml,
  renderReleaseRcYaml,
  renderPRTemplate,
  type WorkflowId,
  type WorkflowConfig,
  type BranchProtectionRule,
  type GitStrategy,
} from "@/lib/git-config";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "strategy", label: "Git Strategy", icon: GitMerge },
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "branch-protection", label: "Branch Protection", icon: Lock },
  { id: "commit-rules", label: "Commit Rules", icon: GitBranch },
  { id: "environments", label: "Deploy Environments", icon: Zap },
  { id: "release", label: "Release Config", icon: Sparkles },
  { id: "pr-template", label: "PR Template", icon: Settings2 },
  { id: "stale", label: "Stale & Cleanup", icon: RefreshCw },
  { id: "cleanup", label: "Branch Cleanup", icon: Trash2 },
  { id: "push", label: "Push to GitHub", icon: Github },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function GitSettingsPage() {
  const { resetGitConfig, config, gitConfig, githubRepo } = useStackStore();
  const [activeSection, setActiveSection] = React.useState<SectionId>("strategy");
  const [saved, setSaved] = React.useState(false);
  const [applying, setApplying] = React.useState(false);

  function handleSave() {
    setSaved(true);
    toast({ title: "Git config saved", description: "Included in your next repo download.", kind: "success" });
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleApplyToGitHub() {
    if (!githubRepo) {
      toast({ title: "No repo connected", description: "Connect a repo in Deploy → Deploy history first.", kind: "info" });
      return;
    }
    setApplying(true);
    try {
      const res = await fetch("/api/github/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: githubRepo.owner,
          repo: githubRepo.repo,
          environments: gitConfig.deployEnvironments,
          branchProtection: gitConfig.protectedBranches.map((r) => ({
            pattern: r.pattern,
            requirePr: r.requirePR,
            requiredApprovals: r.requiredApprovals,
            dismissStaleReviews: r.dismissStaleReviews,
            requireStatusChecks: r.requireStatusChecks.length > 0,
            requireLinearHistory: r.requireLinearHistory,
            allowForcePush: !r.blockForcePush,
          })),
        }),
      });
      const d = (await res.json()) as { success: boolean; environments: { name: string; ok: boolean }[] };
      if (d.success) {
        toast({ title: "Applied to GitHub", description: `${d.environments.length} environments configured.`, kind: "success" });
      } else {
        const failed = d.environments.filter((e) => !e.ok).map((e) => e.name).join(", ");
        toast({ title: "Partially applied", description: `Failed: ${failed}. Check repo admin permissions.`, kind: "error" });
      }
    } catch {
      toast({ title: "Network error", kind: "error" });
    } finally {
      setApplying(false);
    }
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: config.name },
        { label: "Git & CI/CD" },
      ]}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => { resetGitConfig(); toast({ title: "Reset to defaults", kind: "info" }); }}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset all
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSave}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? "Saved" : "Save"}
          </Button>
          <Button variant="glow" size="sm" onClick={handleApplyToGitHub} disabled={applying}>
            {applying ? <><X className="h-3.5 w-3.5 animate-spin" /> Applying…</> : <><Shield className="h-3.5 w-3.5" /> Apply to GitHub</>}
          </Button>
        </>
      }
    >
      <div className="flex h-full">
        {/* Left nav */}
        <aside className="hidden md:flex w-[220px] shrink-0 flex-col border-r border-white/[0.06] py-4">
          <div className="px-4 pb-3">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-medium">Sections</p>
          </div>
          <nav className="flex-1 px-2 space-y-0.5">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors text-left",
                    activeSection === s.id
                      ? "bg-white/[0.06] text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
                  )}
                >
                  <Icon className="h-[14px] w-[14px] shrink-0" />
                  {s.label}
                </button>
              );
            })}
          </nav>
          <div className="px-3 pt-3 border-t border-white/[0.06]">
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-[10px] text-amber-300/80">
              <AlertCircle className="h-3 w-3 inline mr-1" />
              GitHub Apply is <span className="font-medium">Milestone 2</span>. Changes are included in your downloaded zip.
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-6 md:p-8 space-y-6">
            {activeSection === "strategy" && (
              <StrategySection />
            )}
            {activeSection === "workflows" && (
              <WorkflowsSection language={config.language} />
            )}
            {activeSection === "branch-protection" && (
              <BranchProtectionSection />
            )}
            {activeSection === "commit-rules" && (
              <CommitRulesSection />
            )}
            {activeSection === "environments" && (
              <EnvironmentsSection />
            )}
            {activeSection === "release" && (
              <ReleaseSection language={config.language} />
            )}
            {activeSection === "pr-template" && (
              <PRTemplateSection />
            )}
            {activeSection === "stale" && (
              <StaleSection />
            )}
            {activeSection === "cleanup" && (
              <BranchCleanupSection />
            )}
            {activeSection === "push" && (
              <PushSection />
            )}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

// ─── Strategy ────────────────────────────────────────────────────────────────

function StrategySection() {
  const { gitConfig, patchGitConfig } = useStackStore();

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Git Strategy"
        description="Choose a branching model. This controls which workflows are generated, default branch names, and the PR → deploy flow."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(STRATEGY_META) as GitStrategy[]).map((s) => {
          const meta = STRATEGY_META[s];
          const selected = gitConfig.strategy === s;
          return (
            <button
              key={s}
              onClick={() => patchGitConfig({ strategy: s })}
              className={cn(
                "text-left rounded-xl border p-4 transition-colors",
                selected
                  ? "border-brand-500/50 bg-brand-500/[0.07]"
                  : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-semibold">{meta.name}</div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {meta.badge && <Badge variant="outline" className="text-[10px]">{meta.badge}</Badge>}
                  {selected && <Check className="h-3.5 w-3.5 text-brand-300" />}
                </div>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground leading-relaxed">{meta.description}</p>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Branch naming</CardTitle>
          <CardDescription>
            Prefixes enforced in the PR Check workflow. Branches that don&apos;t match will fail CI.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {(Object.entries(gitConfig.branchNaming) as [keyof typeof gitConfig.branchNaming, string][]).map(([key, val]) => (
              <div key={key} className="grid grid-cols-[100px,1fr] items-center gap-3">
                <span className="text-xs font-mono text-muted-foreground capitalize">{key}</span>
                <input
                  value={val}
                  onChange={(e) => patchGitConfig({ branchNaming: { ...gitConfig.branchNaming, [key]: e.target.value } })}
                  className="rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                />
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">Use <code className="font-mono">*</code> as a wildcard. Example: <code className="font-mono">feature/*</code> matches <code className="font-mono">feature/add-login</code>.</p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div>
          <div className="text-sm font-medium">Default branch</div>
          <div className="text-xs text-muted-foreground">What your repository&apos;s default branch is named.</div>
        </div>
        <div className="inline-flex rounded-lg border border-white/[0.08] overflow-hidden">
          {(["main", "master"] as const).map((b) => (
            <button
              key={b}
              onClick={() => patchGitConfig({ defaultBranch: b })}
              className={cn(
                "px-3 py-1.5 text-xs font-mono transition-colors",
                gitConfig.defaultBranch === b
                  ? "bg-white/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <div>
          <div className="text-sm font-medium">Auto-delete merged branches</div>
          <div className="text-xs text-muted-foreground">Automatically delete branches after a PR is merged.</div>
        </div>
        <Switch
          checked={gitConfig.autoDeleteMergedBranches}
          onCheckedChange={(v) => patchGitConfig({ autoDeleteMergedBranches: v })}
        />
      </div>
    </div>
  );
}

// ─── Workflows ────────────────────────────────────────────────────────────────

function WorkflowsSection({ language }: { language: string }) {
  const workflowIds = Object.keys(WORKFLOW_META) as WorkflowId[];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Workflows"
        description="Each workflow generates a file in .github/workflows/. Toggle the entire workflow or individual jobs within it."
      />
      {workflowIds.map((id) => (
        <WorkflowCard key={id} id={id} language={language} />
      ))}
    </div>
  );
}

function WorkflowCard({ id, language }: { id: WorkflowId; language: string }) {
  const { gitConfig, patchWorkflow } = useStackStore();
  const [showYaml, setShowYaml] = React.useState(false);
  const wf: WorkflowConfig = gitConfig.workflows.find((w) => w.id === id) ?? {
    id,
    enabled: true,
    jobs: WORKFLOW_META[id].defaultJobs.map((j) => ({ ...j })),
    rawMode: false,
  };
  const meta = WORKFLOW_META[id];

  const yamlContent = React.useMemo(
    () => renderWorkflowYaml(id, gitConfig, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, language, JSON.stringify(gitConfig)]
  );

  return (
    <Card className={!wf.enabled ? "opacity-60" : undefined}>
      <div className="flex items-start justify-between p-4 pb-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border",
            wf.enabled
              ? "border-brand-500/30 bg-brand-500/10 text-brand-300"
              : "border-white/10 bg-white/[0.02] text-muted-foreground"
          )}>
            <Workflow className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-sm font-semibold">{meta.name}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{meta.description}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          <button
            onClick={() => setShowYaml((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showYaml ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            YAML
          </button>
          <Switch
            checked={wf.enabled}
            onCheckedChange={(v) => patchWorkflow(id, { enabled: v })}
          />
        </div>
      </div>

      {wf.enabled && (
        <>
          <div className="border-t border-white/[0.06] px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Jobs</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => patchWorkflow(id, { rawMode: !wf.rawMode })}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] transition-colors",
                    wf.rawMode
                      ? "border border-amber-500/30 bg-amber-500/10 text-amber-300"
                      : "border border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Code2 className="h-2.5 w-2.5" />
                  {wf.rawMode ? "Raw mode" : "Visual"}
                </button>
              </div>
            </div>
            {wf.rawMode ? (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5 text-[11px] text-amber-300/80">
                Raw mode active — edit the YAML preview below. Visual job toggles are disabled.
              </div>
            ) : (
              <div className="grid gap-1.5">
                {wf.jobs.map((job) => (
                  <div key={job.id} className="flex items-center justify-between rounded-md px-3 py-2 border border-white/[0.04] bg-white/[0.01]">
                    <span className={cn("text-xs", job.enabled ? "text-foreground" : "text-muted-foreground")}>{job.name}</span>
                    <Switch
                      checked={job.enabled}
                      onCheckedChange={(v) => {
                        const updatedJobs = wf.jobs.map((j) => j.id === job.id ? { ...j, enabled: v } : j);
                        patchWorkflow(id, { jobs: updatedJobs });
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {showYaml && (
            <div className="border-t border-white/[0.06]">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.04]">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  .github/workflows/{id}.yml
                </span>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(yamlContent);
                    toast({ title: "Copied to clipboard", kind: "success" });
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Copy
                </button>
              </div>
              {wf.rawMode ? (
                <textarea
                  value={wf.rawYaml ?? yamlContent}
                  onChange={(e) => patchWorkflow(id, { rawYaml: e.target.value })}
                  className="w-full bg-transparent px-4 py-3 text-[11px] font-mono text-white/80 leading-relaxed focus:outline-none resize-none min-h-[240px]"
                  spellCheck={false}
                />
              ) : (
                <pre className="px-4 py-3 text-[11px] font-mono text-white/80 overflow-auto max-h-[320px] leading-relaxed whitespace-pre">
                  <code>{yamlContent}</code>
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Branch Protection ────────────────────────────────────────────────────────

function BranchProtectionSection() {
  const { gitConfig, patchGitConfig } = useStackStore();

  function updateRule(idx: number, patch: Partial<BranchProtectionRule>) {
    const updated = gitConfig.protectedBranches.map((r, i) => i === idx ? { ...r, ...patch } : r);
    patchGitConfig({ protectedBranches: updated });
  }

  function addRule() {
    patchGitConfig({
      protectedBranches: [
        ...gitConfig.protectedBranches,
        {
          pattern: "release/*",
          requirePR: true,
          requiredApprovals: 1,
          dismissStaleReviews: false,
          requireStatusChecks: [],
          requireUpToDate: false,
          blockForcePush: true,
          blockDeletion: false,
          requireLinearHistory: false,
          requireSignedCommits: false,
        },
      ],
    });
  }

  function removeRule(idx: number) {
    patchGitConfig({
      protectedBranches: gitConfig.protectedBranches.filter((_, i) => i !== idx),
    });
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Branch Protection"
        description="Rules applied to branches via the GitHub API when you click Apply to GitHub. Each pattern can target one or more branches."
      />
      {gitConfig.protectedBranches.map((rule, idx) => (
        <Card key={idx}>
          <div className="flex items-center justify-between p-4 pb-3">
            <div className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={rule.pattern}
                onChange={(e) => updateRule(idx, { pattern: e.target.value })}
                className="text-sm font-mono font-semibold bg-transparent focus:outline-none border-b border-transparent focus:border-brand-500/40"
              />
            </div>
            <button onClick={() => removeRule(idx)} className="text-muted-foreground hover:text-red-300 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-3 space-y-3">
            <ToggleRow
              title="Require pull request"
              desc="No direct pushes — all changes via PR"
              checked={rule.requirePR}
              onChange={(v) => updateRule(idx, { requirePR: v })}
            />
            {rule.requirePR && (
              <div className="ml-4 pl-3 border-l border-white/[0.08] space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-medium">Required approvals</div>
                    <div className="text-[11px] text-muted-foreground">Number of review approvals before merge</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateRule(idx, { requiredApprovals: Math.max(0, rule.requiredApprovals - 1) })}
                      className="h-6 w-6 rounded border border-white/[0.08] grid place-items-center text-muted-foreground hover:text-foreground"
                    >-</button>
                    <span className="text-sm font-mono w-4 text-center">{rule.requiredApprovals}</span>
                    <button
                      onClick={() => updateRule(idx, { requiredApprovals: Math.min(6, rule.requiredApprovals + 1) })}
                      className="h-6 w-6 rounded border border-white/[0.08] grid place-items-center text-muted-foreground hover:text-foreground"
                    >+</button>
                  </div>
                </div>
                <ToggleRow
                  title="Dismiss stale reviews"
                  desc="Re-review required when new commits are pushed"
                  checked={rule.dismissStaleReviews}
                  onChange={(v) => updateRule(idx, { dismissStaleReviews: v })}
                />
              </div>
            )}
            <ToggleRow
              title="Block force push"
              desc="Prevents overwriting branch history"
              checked={rule.blockForcePush}
              onChange={(v) => updateRule(idx, { blockForcePush: v })}
            />
            <ToggleRow
              title="Block branch deletion"
              desc="Protects this branch from being deleted"
              checked={rule.blockDeletion}
              onChange={(v) => updateRule(idx, { blockDeletion: v })}
            />
            <ToggleRow
              title="Require linear history"
              desc="Only squash or rebase merges allowed"
              checked={rule.requireLinearHistory}
              onChange={(v) => updateRule(idx, { requireLinearHistory: v })}
            />
            <ToggleRow
              title="Require signed commits"
              desc="GPG or SSH signature required on every commit"
              checked={rule.requireSignedCommits}
              onChange={(v) => updateRule(idx, { requireSignedCommits: v })}
            />
            <ToggleRow
              title="Require branch up-to-date"
              desc="Branch must be current with base before merging"
              checked={rule.requireUpToDate}
              onChange={(v) => updateRule(idx, { requireUpToDate: v })}
            />
          </div>
        </Card>
      ))}
      <Button variant="secondary" size="sm" onClick={addRule}>
        <Plus className="h-3.5 w-3.5" /> Add branch rule
      </Button>
    </div>
  );
}

// ─── Commit Rules ─────────────────────────────────────────────────────────────

const ALL_COMMIT_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf",
  "test", "chore", "revert", "ci", "build",
];

function CommitRulesSection() {
  const { gitConfig, patchGitConfig } = useStackStore();
  const { commitlint, husky } = gitConfig;
  const [newScope, setNewScope] = React.useState("");
  const yamlPreview = React.useMemo(() => renderCommitlintYaml(gitConfig), [gitConfig]);
  const [showYaml, setShowYaml] = React.useState(false);

  function toggleType(t: string) {
    const types = commitlint.types.includes(t)
      ? commitlint.types.filter((x) => x !== t)
      : [...commitlint.types, t];
    patchGitConfig({ commitlint: { ...commitlint, types } });
  }

  function addScope() {
    const s = newScope.trim();
    if (!s || commitlint.scopeAllowlist.includes(s)) return;
    patchGitConfig({ commitlint: { ...commitlint, scopeAllowlist: [...commitlint.scopeAllowlist, s] } });
    setNewScope("");
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Commit Rules"
        description="Commitlint enforces conventional commit format on every commit message. Husky hooks run these checks locally before a commit is created."
      />

      <Card>
        <CardHeader>
          <CardTitle>Commitlint — allowed types</CardTitle>
          <CardDescription>Commits must use one of these prefixes: <code className="font-mono text-[11px]">feat: add login</code>, <code className="font-mono text-[11px]">fix(auth): token expiry</code></CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {ALL_COMMIT_TYPES.map((t) => {
              const active = commitlint.types.includes(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11px] font-mono transition-colors",
                    active
                      ? "border-brand-500/40 bg-brand-500/10 text-brand-300"
                      : "border-white/[0.08] bg-white/[0.02] text-muted-foreground hover:text-foreground"
                  )}
                >
                  {active && <Check className="h-2.5 w-2.5 inline mr-1" />}
                  {t}
                </button>
              );
            })}
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Require scope</div>
                <div className="text-[11px] text-muted-foreground">e.g. <code className="font-mono">feat(auth):</code> — scope in parens is mandatory</div>
              </div>
              <Switch
                checked={commitlint.requireScope}
                onCheckedChange={(v) => patchGitConfig({ commitlint: { ...commitlint, requireScope: v } })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Require body</div>
                <div className="text-[11px] text-muted-foreground">Commit message must include a description body</div>
              </div>
              <Switch
                checked={commitlint.requireBody}
                onCheckedChange={(v) => patchGitConfig({ commitlint: { ...commitlint, requireBody: v } })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div>
                <div className="text-xs font-medium">Max subject length: {commitlint.maxSubjectLength}</div>
                <div className="text-[11px] text-muted-foreground">Characters allowed in the first line</div>
              </div>
              <div className="w-32">
                <Slider
                  value={[commitlint.maxSubjectLength]}
                  min={52}
                  max={100}
                  step={4}
                  onValueChange={([v]) => patchGitConfig({ commitlint: { ...commitlint, maxSubjectLength: v } })}
                />
              </div>
            </div>
          </div>

          {commitlint.requireScope && (
            <div className="space-y-2">
              <div className="text-xs font-medium">Scope allowlist <span className="text-muted-foreground font-normal">(empty = any scope allowed)</span></div>
              <div className="flex flex-wrap gap-1.5">
                {commitlint.scopeAllowlist.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] pl-2.5 pr-1.5 py-0.5 text-[11px] font-mono">
                    {s}
                    <button onClick={() => patchGitConfig({ commitlint: { ...commitlint, scopeAllowlist: commitlint.scopeAllowlist.filter((x) => x !== s) } })}>
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newScope}
                  onChange={(e) => setNewScope(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addScope()}
                  placeholder="auth, api, db…"
                  className="flex-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                />
                <Button variant="secondary" size="sm" onClick={addScope}>Add</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Husky hooks</CardTitle>
          <CardDescription>Git hooks that run locally before commits and pushes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            title="Enable Husky"
            desc="Generate .husky/ directory with hook scripts"
            checked={husky.enabled}
            onChange={(v) => patchGitConfig({ husky: { ...husky, enabled: v } })}
          />
          {husky.enabled && (
            <div className="ml-4 pl-3 border-l border-white/[0.08] space-y-3">
              <ToggleRow
                title="Commit message lint (commit-msg)"
                desc="Run commitlint on every commit message"
                checked={husky.commitMsgLint}
                onChange={(v) => patchGitConfig({ husky: { ...husky, commitMsgLint: v } })}
              />
              <div>
                <div className="text-xs font-medium mb-1">Pre-commit commands</div>
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2 font-mono text-[11px] text-muted-foreground">
                  {husky.preCommitCommands.join("\n") || "(none)"}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <button
          onClick={() => setShowYaml((v) => !v)}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showYaml && "rotate-180")} />
          Preview .commitlintrc.js
        </button>
        {showYaml && (
          <pre className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.01] p-4 text-[11px] font-mono text-white/80 overflow-auto max-h-[240px] leading-relaxed">
            <code>{yamlPreview}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Environments ─────────────────────────────────────────────────────────────

function EnvironmentsSection() {
  const { gitConfig, patchGitConfig } = useStackStore();

  function updateEnv(id: string, patch: Partial<typeof gitConfig.deployEnvironments[0]>) {
    patchGitConfig({
      deployEnvironments: gitConfig.deployEnvironments.map((e) =>
        e.id === id ? { ...e, ...patch } : e
      ),
    });
  }

  const envColors: Record<string, string> = {
    prod: "border-red-500/30 bg-red-500/[0.06]",
    staging: "border-amber-500/30 bg-amber-500/[0.06]",
    dev: "border-emerald-500/30 bg-emerald-500/[0.06]",
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Deploy Environments"
        description="Which branches can deploy to which environments. Approval gates are applied via GitHub Environments (Milestone 2)."
      />
      {gitConfig.deployEnvironments.map((env) => (
        <Card key={env.id} className={cn("border", envColors[env.id] ?? "border-white/[0.06]")}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="capitalize">{env.name}</CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">{env.id}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-xs font-medium mb-1.5">Deploys from branches</div>
              <div className="flex flex-wrap gap-1.5">
                {env.targetBranches.map((b) => (
                  <span key={b} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] pl-2.5 pr-1.5 py-0.5 text-[11px] font-mono">
                    {b}
                    <button onClick={() => updateEnv(env.id, { targetBranches: env.targetBranches.filter((x) => x !== b) })}>
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <ToggleRow
              title="Require approval before deploy"
              desc="A team member must approve the deployment in GitHub"
              checked={env.requireApproval}
              onChange={(v) => updateEnv(env.id, { requireApproval: v })}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Release Config ───────────────────────────────────────────────────────────

function ReleaseSection({ language }: { language: string }) {
  const { gitConfig, patchGitConfig } = useStackStore();
  const { semanticRelease } = gitConfig;
  const [showYaml, setShowYaml] = React.useState(false);
  const releaseYaml = React.useMemo(() => renderReleaseRcYaml(gitConfig), [gitConfig]);
  const workflowYaml = React.useMemo(
    () => renderWorkflowYaml("release", gitConfig, language),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, JSON.stringify(gitConfig)]
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Release Config"
        description="Semantic release automatically versions your code, generates a changelog, and creates a GitHub release from conventional commits."
      />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Semantic Release</CardTitle>
              <CardDescription>feat: → minor bump, fix: → patch bump, BREAKING CHANGE: → major bump</CardDescription>
            </div>
            <Switch
              checked={semanticRelease.enabled}
              onCheckedChange={(v) => patchGitConfig({ semanticRelease: { ...semanticRelease, enabled: v } })}
            />
          </div>
        </CardHeader>
        {semanticRelease.enabled && (
          <CardContent className="space-y-3">
            <ToggleRow
              title="Generate CHANGELOG.md"
              desc="Automatically maintained changelog committed back to the repo"
              checked={semanticRelease.generateChangelog}
              onChange={(v) => patchGitConfig({ semanticRelease: { ...semanticRelease, generateChangelog: v } })}
            />
            <ToggleRow
              title="Create GitHub Release"
              desc="Publishes a GitHub Release with the generated notes"
              checked={semanticRelease.createGitHubRelease}
              onChange={(v) => patchGitConfig({ semanticRelease: { ...semanticRelease, createGitHubRelease: v } })}
            />
          </CardContent>
        )}
      </Card>

      <div className="space-y-2">
        <button
          onClick={() => setShowYaml((v) => !v)}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showYaml && "rotate-180")} />
          Preview generated files
        </button>
        {showYaml && (
          <div className="space-y-3">
            <YamlBlock label=".releaserc.js" content={releaseYaml} />
            <YamlBlock label=".github/workflows/release.yml" content={workflowYaml} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PR Template ──────────────────────────────────────────────────────────────

function PRTemplateSection() {
  const { gitConfig, patchGitConfig } = useStackStore();
  const { prTemplateSections } = gitConfig;
  const preview = React.useMemo(() => renderPRTemplate(gitConfig), [gitConfig]);

  const sectionMeta: { key: keyof typeof prTemplateSections; label: string; desc: string }[] = [
    { key: "summary", label: "Summary", desc: "What does this PR do?" },
    { key: "motivation", label: "Motivation", desc: "Why is this change needed?" },
    { key: "breakingChanges", label: "Breaking changes", desc: "Checkbox + migration notes" },
    { key: "testPlan", label: "Test plan", desc: "Checklist: unit, integration, manual" },
    { key: "screenshots", label: "Screenshots", desc: "Before/after visuals placeholder" },
    { key: "relatedIssues", label: "Related issues", desc: "Closes # field" },
    { key: "checklist", label: "Checklist", desc: "Contribution guidelines checklist" },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="PR Template"
        description="Generated at .github/PULL_REQUEST_TEMPLATE.md. Toggle which sections appear in every pull request."
      />
      <Card>
        <CardContent className="p-4 space-y-2">
          {sectionMeta.map(({ key, label, desc }) => (
            <ToggleRow
              key={key}
              title={label}
              desc={desc}
              checked={prTemplateSections[key]}
              onChange={(v) => patchGitConfig({ prTemplateSections: { ...prTemplateSections, [key]: v } })}
            />
          ))}
        </CardContent>
      </Card>

      <div>
        <div className="text-xs font-medium mb-2">Preview — .github/PULL_REQUEST_TEMPLATE.md</div>
        <pre className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-4 text-[11px] font-mono text-white/80 overflow-auto max-h-[320px] leading-relaxed whitespace-pre-wrap">
          {preview || "(All sections disabled)"}
        </pre>
      </div>
    </div>
  );
}

// ─── Stale & Cleanup ─────────────────────────────────────────────────────────

function StaleSection() {
  const { gitConfig, patchGitConfig } = useStackStore();
  const { stale, freezeWindows } = gitConfig;
  const [newLabel, setNewLabel] = React.useState("");

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Stale & Cleanup"
        description="Automatically manage stale issues and PRs. Freeze windows block production deploys during critical periods."
      />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Stale issues & PRs</CardTitle>
              <CardDescription>Generated at .github/workflows/stale.yml — runs nightly.</CardDescription>
            </div>
            <Switch
              checked={stale.enabled}
              onCheckedChange={(v) => patchGitConfig({ stale: { ...stale, enabled: v } })}
            />
          </div>
        </CardHeader>
        {stale.enabled && (
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <SliderField
                label="Issue stale after"
                value={stale.daysBeforeIssueStale}
                min={7} max={90} suffix="d"
                onChange={(v) => patchGitConfig({ stale: { ...stale, daysBeforeIssueStale: v } })}
              />
              <SliderField
                label="PR stale after"
                value={stale.daysBeforePrStale}
                min={7} max={60} suffix="d"
                onChange={(v) => patchGitConfig({ stale: { ...stale, daysBeforePrStale: v } })}
              />
              <SliderField
                label="Close after stale"
                value={stale.daysBeforeClose}
                min={1} max={30} suffix="d"
                onChange={(v) => patchGitConfig({ stale: { ...stale, daysBeforeClose: v } })}
              />
            </div>
            <div>
              <div className="text-xs font-medium mb-2">Exempt labels (never marked stale)</div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {stale.exemptLabels.map((l) => (
                  <span key={l} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.02] pl-2.5 pr-1.5 py-0.5 text-[11px] font-mono">
                    {l}
                    <button onClick={() => patchGitConfig({ stale: { ...stale, exemptLabels: stale.exemptLabels.filter((x) => x !== l) } })}>
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const l = newLabel.trim();
                    if (l && !stale.exemptLabels.includes(l)) {
                      patchGitConfig({ stale: { ...stale, exemptLabels: [...stale.exemptLabels, l] } });
                    }
                    setNewLabel("");
                  }}
                  placeholder="pinned, security…"
                  className="flex-1 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                />
                <Button variant="secondary" size="sm" onClick={() => {
                  const l = newLabel.trim();
                  if (l && !stale.exemptLabels.includes(l)) {
                    patchGitConfig({ stale: { ...stale, exemptLabels: [...stale.exemptLabels, l] } });
                  }
                  setNewLabel("");
                }}>Add</Button>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deploy freeze windows</CardTitle>
          <CardDescription>Production deploys are blocked during these periods. Checked in the deploy-prod workflow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {freezeWindows.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No freeze windows configured.</div>
          ) : (
            freezeWindows.map((fw) => (
              <div key={fw.id} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <div>
                  <div className="text-xs font-medium">{fw.label}</div>
                  <div className="text-[11px] text-muted-foreground font-mono">
                    {fw.startMonth}/{fw.startDay} → {fw.endMonth}/{fw.endDay}
                  </div>
                </div>
                <button
                  onClick={() => patchGitConfig({ freezeWindows: freezeWindows.filter((f) => f.id !== fw.id) })}
                  className="text-muted-foreground hover:text-red-300 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => patchGitConfig({
              freezeWindows: [
                ...freezeWindows,
                { id: `fw-${Date.now()}`, label: "Holiday freeze", startMonth: 12, startDay: 23, endMonth: 1, endDay: 2 },
              ],
            })}
          >
            <Plus className="h-3.5 w-3.5" /> Add freeze window
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function ToggleRow({ title, desc, checked, onChange }: {
  title: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div>
        <div className="text-xs font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SliderField({ label, value, min, max, suffix, onChange }: {
  label: string; value: number; min: number; max: number; suffix: string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-2">
        <span>{label}</span>
        <span className="font-mono font-semibold">{value}{suffix}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={1} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

// ─── Branch Cleanup ───────────────────────────────────────────────────────────

function BranchCleanupSection() {
  const { githubRepo, gitConfig } = useStackStore();
  const defaultBranch = githubRepo?.defaultBranch ?? gitConfig.defaultBranch;

  const [stale, setStale] = React.useState<string[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  async function loadStale() {
    if (!githubRepo) { toast({ title: "No repo connected", description: "Connect a repo in Deploy → Deploy history first.", kind: "info" }); return; }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/github/cleanup?owner=${githubRepo.owner}&repo=${githubRepo.repo}&base=${defaultBranch}`
      );
      const d = (await res.json()) as { branches?: string[] };
      setStale(d.branches ?? []);
      setSelected(new Set(d.branches ?? []));
      setLoaded(true);
    } catch {
      toast({ title: "Failed to load branches", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  async function deleteSelected() {
    if (!githubRepo || selected.size === 0) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/github/cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: githubRepo.owner, repo: githubRepo.repo, branches: [...selected] }),
      });
      const d = (await res.json()) as { deleted: string[]; failed: string[] };
      setStale((prev) => prev.filter((b) => !d.deleted.includes(b)));
      setSelected(new Set());
      if (d.deleted.length) toast({ title: `Deleted ${d.deleted.length} branch${d.deleted.length !== 1 ? "es" : ""}`, kind: "success" });
      if (d.failed.length) toast({ title: `${d.failed.length} failed`, description: d.failed.join(", "), kind: "error" });
    } finally {
      setDeleting(false);
    }
  }

  function toggleAll() {
    setSelected(selected.size === stale.length ? new Set() : new Set(stale));
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Branch Cleanup"
        description="Find and delete branches whose pull requests have already been merged. Keeps your repo tidy and speeds up branch listing."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4" /> Merged branch cleanup
          </CardTitle>
          <CardDescription>
            {githubRepo
              ? <>Scanning <span className="font-mono text-foreground">{githubRepo.owner}/{githubRepo.repo}</span> against <span className="font-mono text-foreground">{defaultBranch}</span>.</>
              : "Connect a repo in Deploy → Deploy history to enable cleanup."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={loadStale} disabled={loading || !githubRepo}>
              {loading ? <><X className="h-3.5 w-3.5 animate-spin" /> Scanning…</> : <><RefreshCw className="h-3.5 w-3.5" /> Scan for merged branches</>}
            </Button>
            {loaded && stale.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300 hover:bg-red-500/[0.06]"
                onClick={deleteSelected}
                disabled={deleting || selected.size === 0}
              >
                {deleting ? <><X className="h-3.5 w-3.5 animate-spin" /> Deleting…</> : <><Trash2 className="h-3.5 w-3.5" /> Delete selected ({selected.size})</>}
              </Button>
            )}
          </div>

          {loaded && stale.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-emerald-300">
              <Check className="h-3.5 w-3.5" /> No stale merged branches found.
            </div>
          )}

          {loaded && stale.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1 pb-1">
                <button onClick={toggleAll} className="hover:text-foreground transition-colors">
                  {selected.size === stale.length ? "Deselect all" : "Select all"}
                </button>
                <span>{stale.length} branch{stale.length !== 1 ? "es" : ""} eligible</span>
              </div>
              {stale.map((branch) => (
                <label key={branch} className="flex items-center gap-2.5 rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 cursor-pointer hover:bg-white/[0.04] transition-colors">
                  <input
                    type="checkbox"
                    checked={selected.has(branch)}
                    onChange={() => setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(branch)) { next.delete(branch); } else { next.add(branch); }
                      return next;
                    })}
                    className="accent-brand-500"
                  />
                  <span className="text-xs font-mono flex-1 truncate">{branch}</span>
                  <span className="text-[10px] text-emerald-300/60">merged</span>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Push to GitHub ──────────────────────────────────────────────────────────

function PushSection() {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Push to GitHub"
        description="Connect your GitHub account, point Helios at an existing repo, and open a PR with all generated files in one click."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" /> Open a Pull Request
          </CardTitle>
          <CardDescription>
            Helios will create a feature branch, commit all generated files, and open a PR for review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PRCreator />
        </CardContent>
      </Card>
    </div>
  );
}

function YamlBlock({ label, content }: { label: string; content: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{label}</span>
        <button
          onClick={() => { void navigator.clipboard.writeText(content); toast({ title: "Copied", kind: "success" }); }}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Copy
        </button>
      </div>
      <pre className="px-4 py-3 text-[11px] font-mono text-white/80 overflow-auto max-h-[280px] leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleDollarSign,
  CloudCog,
  Copy,
  Cpu,
  FileText,
  Globe2,
  Key,
  Loader2,
  MinusCircle,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Zap,
  X,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { useStackStore } from "@/lib/store";
import { deployments } from "@/data/stack-options";
import { toast } from "@/components/ui/toast";
import { BrandIcon } from "@/components/shared/brand-icon";

const regions = [
  { id: "us-east-1", label: "US East · N. Virginia", flag: "🇺🇸", ms: 42 },
  { id: "us-west-2", label: "US West · Oregon", flag: "🇺🇸", ms: 58 },
  { id: "eu-west-2", label: "EU West · London", flag: "🇬🇧", ms: 86 },
  { id: "ap-south-1", label: "APAC · Mumbai", flag: "🇮🇳", ms: 124 },
  { id: "sa-east-1", label: "South America · São Paulo", flag: "🇧🇷", ms: 142 },
  { id: "ap-southeast-2", label: "APAC · Sydney", flag: "🇦🇺", ms: 168 },
];

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
                  {deployments.map((d) => (
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
                  ))}
                </div>
              </CardContent>
            </Card>

            <CredentialsPanel />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Globe2 className="h-4 w-4" /> Regions
                </CardTitle>
                <CardDescription>
                  Primary region runs the stack. Additional regions become read
                  replicas with low-latency failover.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 md:grid-cols-2">
                  {regions.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => patch({ region: r.id })}
                      className={`flex items-center justify-between rounded-lg border p-3 text-left hover-raise ${
                        config.region === r.id
                          ? "border-brand-500/50 bg-brand-500/[0.06]"
                          : "border-white/[0.06] bg-white/[0.02]"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{r.flag}</span>
                        <div>
                          <div className="text-sm font-medium">{r.label}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">
                            {r.id}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {r.ms}ms
                        </span>
                        {config.region === r.id ? (
                          <Badge variant="brand">primary</Badge>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <ScalingConfig />
          </div>

          {/* right column */}
          <div className="space-y-4">
            <DeploySummary />
            {config.deployment === "railway" ? (
              <RailwayDeployPanel />
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

function CredentialsPanel() {
  const { config } = useStackStore();
  if (config.deployment === "railway") return <RailwayCredentialsPanel />;
  return <GenericCredentialsPanel />;
}

// Status-only panel — full token management lives in Settings → Integrations
function RailwayCredentialsPanel() {
  const [hasToken, setHasToken] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    fetch("/api/deploy/credentials")
      .then((r) => r.json())
      .then((d: { creds?: { railway?: { token?: string } } }) => {
        setHasToken(!!d.creds?.railway?.token);
      })
      .catch(() => setHasToken(false));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-4 w-4" /> Railway credentials
        </CardTitle>
        <CardDescription>
          Manage your Railway API token in{" "}
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

// Placeholder panel for providers not yet wired up
function GenericCredentialsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-4 w-4" /> Credentials
        </CardTitle>
        <CardDescription>
          Direct deployment is currently available for Railway. For other
          providers, use the step-by-step guide generated below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Switch to <strong className="text-foreground">Railway</strong> in the
          provider selector above to connect your account and deploy directly from Helios.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Railway direct deploy panel ─────────────────────────────────────────────

type DeployPhase = "idle" | "deploying" | "done" | "error";

type DeployResult = {
  projectUrl: string;
  domain: string | null;
  fullName: string;
  githubUrl: string;
};

// Ordered UI stages. Server pipeline stages map into these; `railway_env`
// collapses into `project`, and `generate` collapses into `push` — the user
// doesn't care about those distinctions.
const UI_STAGES = ["push", "project", "service", "variables", "domain"] as const;
type UiStage = (typeof UI_STAGES)[number];

const STAGE_LABELS: Record<UiStage, string> = {
  push: "Pushing code to GitHub",
  project: "Creating Railway project",
  service: "Linking repository",
  variables: "Setting environment variables",
  domain: "Provisioning public domain",
};

function mapServerStage(stage: string): UiStage | null {
  switch (stage) {
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
}

type StageState = "waiting" | "active" | "done" | "skipped";

function initialStages(): Record<UiStage, StageState> {
  return { push: "waiting", project: "waiting", service: "waiting", variables: "waiting", domain: "waiting" };
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

function RailwayDeployPanel() {
  const { config, endpoints, entities } = useStackStore();
  const [phase, setPhase] = React.useState<DeployPhase>("idle");
  const [result, setResult] = React.useState<DeployResult | null>(null);
  const [errorMsg, setErrorMsg] = React.useState("");
  const [errorHint, setErrorHint] = React.useState("");
  const [errorPartial, setErrorPartial] = React.useState<{ projectId?: string; serviceId?: string } | null>(null);
  const [hasToken, setHasToken] = React.useState<boolean | null>(null);
  const [ghConnected, setGhConnected] = React.useState<boolean | null>(null);
  const [stages, setStages] = React.useState<Record<UiStage, StageState>>(initialStages);
  const [stageDetail, setStageDetail] = React.useState<Partial<Record<UiStage, string>>>({});
  const [warnings, setWarnings] = React.useState<string[]>([]);

  React.useEffect(() => {
    Promise.all([
      fetch("/api/deploy/credentials").then((r) => r.json()) as Promise<{ creds?: { railway?: { token?: string } } }>,
      fetch("/api/auth/github/status").then((r) => r.json()) as Promise<{ connected: boolean }>,
    ])
      .then(([creds, gh]) => {
        setHasToken(!!creds.creds?.railway?.token);
        setGhConnected(gh.connected);
      })
      .catch(() => { setHasToken(false); setGhConnected(false); });
  }, []);

  async function deploy() {
    setPhase("deploying");
    setErrorMsg("");
    setErrorHint("");
    setErrorPartial(null);
    setStages(initialStages());
    setStageDetail({});
    setWarnings([]);

    let currentStage: UiStage | null = null;
    const markActive = (s: UiStage) => {
      setStages((prev) => {
        const next = { ...prev };
        // Any earlier stage that was `active` becomes `done`.
        for (const key of UI_STAGES) {
          if (key === s) break;
          if (next[key] === "active") next[key] = "done";
          if (next[key] === "waiting") next[key] = "done"; // skipped-forward = done
        }
        next[s] = "active";
        return next;
      });
    };
    const markDoneAll = () => {
      setStages((prev) => {
        const next = { ...prev };
        for (const key of UI_STAGES) {
          if (next[key] === "active" || next[key] === "waiting") next[key] = "done";
        }
        return next;
      });
    };

    try {
      const res = await fetch("/api/deploy/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ config, endpoints, entities }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({} as Record<string, unknown>)) as {
          error?: string;
          message?: string;
          hint?: string;
          partial?: { projectId?: string; serviceId?: string };
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
          const ui = mapServerStage(p.stage);
          if (ui) {
            currentStage = ui;
            markActive(ui);
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
          if (currentStage === "domain") {
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
              partial?: { projectId?: string; serviceId?: string };
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
              projectUrl: string;
              domain: string | null;
              fullName: string;
              githubUrl: string;
            };
          };
          markDoneAll();
          setResult({
            projectUrl: p.result.projectUrl,
            domain: p.result.domain,
            fullName: p.result.fullName,
            githubUrl: p.result.githubUrl,
          });
          setPhase("done");
          return;
        }
      }

      // Stream ended without a `done` or `error` frame — treat as error.
      setPhase("error");
      setErrorMsg("Deployment ended unexpectedly");
      setErrorHint("The connection closed before the deploy finished. Check the Railway dashboard and retry.");
    } catch (err) {
      setPhase("error");
      setErrorMsg("Network error");
      setErrorHint(err instanceof Error ? err.message : "Check your connection and try again.");
    }
  }

  const canDeploy = hasToken && ghConnected;

  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-20" />
      <div className="relative p-5 space-y-4">
        <div className="flex items-center gap-2">
          <BrandIcon id="railway" size={20} rounded="sm" />
          <span className="text-sm font-semibold">Deploy to Railway</span>
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
              label="Railway token saved"
              ok={hasToken === true}
              loading={hasToken === null}
              action={
                hasToken === false ? (
                  <span className="text-xs text-muted-foreground">↑ Enter token above</span>
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
            Deploy to Railway
          </Button>
        )}

        {/* Deploying */}
        {phase === "deploying" && (
          <div className="space-y-3">
            {UI_STAGES.map((s) => (
              <DeployStepRowV2
                key={s}
                label={STAGE_LABELS[s]}
                state={stages[s]}
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
            {UI_STAGES.map((s) => (
              <DeployStepRowV2
                key={s}
                label={STAGE_LABELS[s]}
                state={stages[s]}
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
              <p className="text-xs font-medium text-emerald-300">Deployment started</p>
              <p className="text-xs text-muted-foreground">
                Railway is building your Docker image. Check the dashboard to follow build progress.
              </p>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <a
                  href={result.projectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-brand-300 hover:underline"
                >
                  <Rocket className="h-3 w-3" /> Open Railway dashboard
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
                {errorPartial?.projectId && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Partial project created:{" "}
                    <a
                      className="underline hover:text-foreground"
                      href={`https://railway.app/project/${errorPartial.projectId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open in Railway
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

function ScalingConfig() {
  const { config, patch } = useStackStore();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4" /> Capacity & scaling
        </CardTitle>
        <CardDescription>
          Replicas, autoscaler, resource limits.
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
        <div className="grid gap-3 md:grid-cols-2">
          <ToggleRow
            label="Autoscale"
            desc="HPA target: CPU > 65%"
            checked={config.autoscale}
            onChange={(v) => patch({ autoscale: v })}
            icon={<Zap className="h-3.5 w-3.5" />}
          />
          <ToggleRow
            label="Kubernetes"
            desc="Helm chart + Kustomize overlays"
            checked={config.kubernetes}
            onChange={(v) => patch({ kubernetes: v })}
            icon={<Cpu className="h-3.5 w-3.5" />}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  icon,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        {icon ? (
          <div className="grid h-7 w-7 place-items-center rounded-md border border-white/10 bg-white/[0.03] text-muted-foreground">
            {icon}
          </div>
        ) : null}
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function DeploySummary() {
  const { config } = useStackStore();
  const deploy = deployments.find((d) => d.id === config.deployment)?.label;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deployment summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 text-xs">
        <SummaryRow label="Provider" value={deploy ?? "—"} />
        <SummaryRow label="Region" value={config.region} />
        <SummaryRow label="Replicas" value={`${config.replicas}`} />
        <SummaryRow label="Autoscale" value={config.autoscale ? "on" : "off"} />
        <SummaryRow label="Kubernetes" value={config.kubernetes ? "on" : "off"} />
        <Separator />
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-muted-foreground">
            <CircleDollarSign className="h-3.5 w-3.5" /> Est. monthly
          </span>
          <span className="font-semibold">$1,284</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
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

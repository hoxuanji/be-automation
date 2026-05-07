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
  Globe2,
  Key,
  Loader2,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Terminal } from "@/components/shared/terminal";
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
  const [step, setStep] = React.useState<"configure" | "deploying" | "live">(
    "configure"
  );
  const [progress, setProgress] = React.useState(0);

  function deploy() {
    setStep("deploying");
    setProgress(0);
    const i = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(i);
          setStep("live");
          return 100;
        }
        return p + 4;
      });
    }, 140);
  }

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
            {step === "deploying" ? (
              <DeployingPanel progress={progress} />
            ) : step === "live" ? (
              <LivePanel />
            ) : (
              <DeployCTA onDeploy={deploy} />
            )}

            {step === "deploying" || step === "live" ? (
              <Terminal
                animate={step === "deploying"}
                title="deploy.log"
                lines={[
                  { kind: "prompt", text: "helios deploy --provider railway --region us-east-1" },
                  { kind: "info", text: "→ authenticating workspace…" },
                  { kind: "ok", text: "✓ credentials verified" },
                  { kind: "out", text: "→ building multi-arch image (linux/amd64,arm64)" },
                  { kind: "ok", text: "✓ image 47.2MB pushed to registry" },
                  { kind: "out", text: "→ applying terraform plan (12 resources)" },
                  { kind: "ok", text: "✓ 12 created · 0 changed · 0 destroyed" },
                  { kind: "out", text: "→ rolling out 3 replicas (rolling)" },
                  { kind: "ok", text: "✓ health checks passing (12.4k rps)" },
                  { kind: "info", text: "→ https://helios-api.up.railway.app" },
                ]}
              />
            ) : null}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({
  step,
}: {
  step: "configure" | "deploying" | "live";
}) {
  const steps = [
    { id: "configure", label: "Configure" },
    { id: "deploying", label: "Deploying" },
    { id: "live", label: "Live" },
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
            {step === "live" ? (
              <Badge variant="success">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                live
              </Badge>
            ) : null}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Ship your stack to production
          </h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-lg">
            Pick a provider, wire credentials, and we&apos;ll provision
            infrastructure, roll out replicas and run smoke tests — all in one
            tap.
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
  const [creds, setCreds] = React.useState({
    access: "",
    project: "",
    team: "",
  });
  const [testing, setTesting] = React.useState(false);

  const fields = [
    {
      key: "access" as const,
      label: "Access token",
      type: "password",
      placeholder: "rw_xxxxxxxxxxxxxxxx",
    },
    {
      key: "project" as const,
      label: "Project ID",
      type: "text",
      placeholder: "prj_9Zx2",
    },
    {
      key: "team" as const,
      label: "Team slug (optional)",
      type: "text",
      placeholder: "acme-co",
    },
  ];

  async function pasteFromClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        toast({ title: "Clipboard empty", kind: "info" });
        return;
      }
      // Heuristic: if it looks like a token, fill Access; else project id.
      if (/^[a-z]{1,4}_[A-Za-z0-9]{8,}$/.test(text)) {
        setCreds((c) => ({ ...c, access: text }));
      } else {
        setCreds((c) => ({ ...c, project: text }));
      }
      toast({ title: "Pasted from clipboard", kind: "success" });
    } catch {
      toast({
        title: "Clipboard blocked",
        description: "Allow clipboard access in your browser.",
        kind: "error",
      });
    }
  }

  function testConnection() {
    if (!creds.access.trim()) {
      toast({ title: "Access token required", kind: "error" });
      return;
    }
    setTesting(true);
    setTimeout(() => {
      setTesting(false);
      toast({
        title: "Connection OK",
        description: creds.project
          ? `Verified token · project ${creds.project}`
          : "Verified token.",
        kind: "success",
      });
    }, 900);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Key className="h-4 w-4" /> Credentials
        </CardTitle>
        <CardDescription>
          End-to-end encrypted. Rotate anytime. We never log secret values.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {fields.map((f) => (
          <div key={f.label}>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs text-muted-foreground">{f.label}</label>
              <Badge variant="purple">
                <Shield className="h-2.5 w-2.5" /> encrypted
              </Badge>
            </div>
            <Input
              type={f.type}
              placeholder={f.placeholder}
              value={creds[f.key]}
              onChange={(e) =>
                setCreds((c) => ({ ...c, [f.key]: e.target.value }))
              }
            />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={pasteFromClipboard}>
            <Copy className="h-3.5 w-3.5" /> Paste from clipboard
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
      </CardContent>
    </Card>
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

function DeployCTA({ onDeploy }: { onDeploy: () => void }) {
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-30" />
      <div className="relative p-5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-brand-300" />
          Ready to ship
        </div>
        <div className="mt-2 text-sm">
          Rolls out a zero-downtime deploy with health checks, log drain and
          alerting pre-wired.
        </div>
        <Button onClick={onDeploy} variant="glow" size="lg" className="mt-4 w-full">
          <Rocket className="h-4 w-4" />
          Deploy now
        </Button>
      </div>
    </Card>
  );
}

function DeployingPanel({ progress }: { progress: number }) {
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-300" />
          <span className="text-muted-foreground">Deploying… this usually takes 20–30s</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-400 to-purple-400"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[11px] font-mono text-muted-foreground">
          <span>{progress}% · rolling 3 replicas</span>
          <span>p99 42ms</span>
        </div>
      </div>
    </Card>
  );
}

function LivePanel() {
  const { config } = useStackStore();
  const url = `https://${config.name}.up.railway.app`;

  async function copyUrl(e: React.MouseEvent) {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "URL copied", description: url, kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  return (
    <Card className="relative overflow-hidden border-emerald-500/30 bg-emerald-500/[0.05]">
      <div className="p-5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-sm font-semibold text-emerald-200">
            Deployment successful
          </span>
        </div>
        <a
          href={url}
          onClick={copyUrl}
          className="mt-3 block rounded-md border border-white/10 bg-black/30 px-2.5 py-2 font-mono text-xs text-brand-300 hover:text-brand-200"
        >
          {url}
        </a>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Replicas", value: `${config.replicas}/${config.replicas}` },
            { label: "p99", value: "42ms" },
            { label: "Uptime", value: "100%" },
          ].map((s) => (
            <div key={s.label} className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
                {s.label}
              </div>
              <div className="mt-0.5 text-sm font-semibold">{s.value}</div>
            </div>
          ))}
        </div>
        <Button
          asChild
          variant="glow"
          size="sm"
          className="mt-4 w-full"
        >
          <Link href="/dashboard">
            Open dashboard <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

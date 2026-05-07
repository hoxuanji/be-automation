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
            {step === "guide" ? (
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

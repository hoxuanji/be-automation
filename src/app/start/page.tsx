"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  CircleDollarSign,
  Gauge,
  Loader2,
  Lock,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BrandIcon } from "@/components/shared/brand-icon";
import { PublishButton } from "@/components/shared/publish-button";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import { readSSE } from "@/lib/sse";
import type { ArchitectureProposal, Decision } from "@/lib/architect-schema";
import { cn } from "@/lib/utils";

const examples = [
  "A multi-tenant SaaS CRM for sales teams, 10k seats by year one",
  "Realtime multiplayer game backend for SEA, low latency, 50k concurrent",
  "AI inference API serving fine-tuned LLMs to enterprise, GPU autoscaling",
  "HIPAA-compliant telehealth backend with audit logs and EU residency",
  "Event-driven fintech ledger with double-entry, 1M tx/day, idempotent",
  "Realtime chat app like Slack, presence + typing indicators, mobile clients",
];

type Phase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "streaming"; narration: string; decisions: Decision[] }
  | { kind: "done"; proposal: ArchitectureProposal }
  | { kind: "error"; message: string };

export default function StartPage() {
  const params = useSearchParams();
  const initialIntent = params.get("intent") ?? "";

  const [intent, setIntent] = React.useState(initialIntent);
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const abortRef = React.useRef<AbortController | null>(null);
  const startedRef = React.useRef(false);

  const start = React.useCallback(async (text: string) => {
    if (!text.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase({ kind: "thinking" });

    try {
      const res = await fetch("/api/architect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: text }),
        signal: controller.signal,
      });

      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        setPhase({
          kind: "error",
          message: data.detail ?? "Architect is not configured.",
        });
        return;
      }

      if (!res.ok || !res.body) {
        setPhase({
          kind: "error",
          message: `Request failed (${res.status})`,
        });
        return;
      }

      let narration = "";
      const decisions: Decision[] = [];

      for await (const ev of readSSE(res, controller.signal)) {
        const data = ev.data as Record<string, unknown>;
        if (ev.event === "narration" && typeof data.text === "string") {
          narration += data.text;
          setPhase({ kind: "streaming", narration, decisions: [...decisions] });
        } else if (ev.event === "proposal") {
          const proposal = data as unknown as ArchitectureProposal;
          // briefly show decisions revealing one-by-one for drama
          for (const d of proposal.decisions) {
            decisions.push(d);
            setPhase({
              kind: "streaming",
              narration,
              decisions: [...decisions],
            });
            await sleep(120);
          }
          setPhase({ kind: "done", proposal });
        } else if (ev.event === "error") {
          setPhase({
            kind: "error",
            message: (data.message as string) ?? "Stream error",
          });
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setPhase({ kind: "error", message: (err as Error).message });
    }
  }, []);

  // auto-start if intent came in via the URL
  React.useEffect(() => {
    if (initialIntent && !startedRef.current) {
      startedRef.current = true;
      start(initialIntent);
    }
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    abortRef.current?.abort();
    setPhase({ kind: "idle" });
  }

  return (
    <div className="relative isolate min-h-screen overflow-hidden">
      {/* background */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-50" />
        <div className="absolute -top-40 left-1/2 h-[520px] w-[1100px] -translate-x-1/2 aurora animate-aurora" />
        <div className="absolute inset-0 noise" />
      </div>

      <header className="border-b border-white/[0.04] bg-background/70 backdrop-blur-md">
        <div className="container flex h-14 items-center justify-between">
          <Logo />
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
            {phase.kind !== "idle" ? (
              <Button variant="secondary" size="sm" onClick={reset}>
                <RotateCcw className="h-3.5 w-3.5" /> Start over
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="container py-10 md:py-16">
        {phase.kind === "idle" ? (
          <IntentForm
            value={intent}
            onChange={setIntent}
            onSubmit={() => start(intent)}
          />
        ) : (
          <StreamingView
            intent={intent || initialIntent}
            phase={phase}
            onReset={reset}
          />
        )}
      </main>
    </div>
  );
}

function IntentForm({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="text-center">
        <Badge variant="brand" className="mx-auto inline-flex">
          <Sparkles className="h-3 w-3" /> Intent-driven architecture
        </Badge>
        <h1 className="mt-5 text-4xl md:text-5xl font-semibold tracking-tight text-gradient">
          Describe what you&apos;re building.
        </h1>
        <p className="mt-4 text-sm md:text-base text-muted-foreground max-w-xl mx-auto">
          Helios will design the architecture, pick the stack, predict cost
          and latency, and generate a deployable repo. One sentence is enough.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="mt-10 relative rounded-2xl border border-white/[0.08] bg-white/[0.02] p-1.5 focus-within:border-brand-500/40 transition-colors"
      >
        <div className="flex items-start gap-2 p-2">
          <Wand2 className="h-4 w-4 text-brand-300 mt-2.5 shrink-0" />
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="A B2B SaaS for…   /   An API that…   /   A platform where…"
            className="min-h-[88px] flex-1 bg-transparent px-1 py-2 text-sm md:text-base placeholder:text-muted-foreground/60 focus:outline-none resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/[0.04] px-3 py-2">
          <span className="text-[11px] text-muted-foreground hidden md:block">
            <kbd className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px]">
              ⌘
            </kbd>
            +
            <kbd className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px]">
              Enter
            </kbd>{" "}
            to architect
          </span>
          <Button
            type="submit"
            variant="glow"
            size="lg"
            disabled={!value.trim()}
          >
            <Sparkles className="h-4 w-4" />
            Architect this
          </Button>
        </div>
      </form>

      <div className="mt-8">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground/70 text-center">
          Try one of these
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => onChange(ex)}
              className="text-left rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm text-muted-foreground hover:bg-white/[0.04] hover:text-foreground hover:border-white/[0.12] transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StreamingView({
  intent,
  phase,
  onReset,
}: {
  intent: string;
  phase: Phase;
  onReset: () => void;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      {/* the intent restated */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
        <div className="flex items-start gap-3">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
            <Wand2 className="h-3.5 w-3.5 text-white" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
              Brief
            </div>
            <p className="mt-1 text-sm md:text-base">{intent}</p>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr,360px]">
        {/* left column: narration + decisions */}
        <div className="space-y-4 min-w-0">
          <NarrationCard phase={phase} />
          <DecisionsList phase={phase} />
        </div>

        {/* right column: predictions + actions */}
        <div className="space-y-4">
          {phase.kind === "done" ? (
            <ProposalSidebar
              proposal={phase.proposal}
              intent={intent || ""}
            />
          ) : (
            <SkeletonSidebar />
          )}

          {phase.kind === "error" ? (
            <Card className="border-red-500/30 bg-red-500/[0.05] p-4 text-xs text-red-200">
              <div className="font-medium">Architect failed</div>
              <p className="mt-1 opacity-80">{phase.message}</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={onReset}
              >
                Start over
              </Button>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NarrationCard({ phase }: { phase: Phase }) {
  const text =
    phase.kind === "streaming" || phase.kind === "done"
      ? phase.kind === "done"
        ? phase.proposal.summary
        : phase.narration
      : "";
  const label =
    phase.kind === "thinking"
      ? "Thinking…"
      : phase.kind === "done"
      ? "Helios summary"
      : phase.kind === "streaming"
      ? "Helios is reasoning…"
      : "Reasoning";
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
            <BrainCircuit className="h-3 w-3 text-white" />
          </div>
          <span className="text-xs font-medium">{label}</span>
        </div>
        {phase.kind === "thinking" || phase.kind === "streaming" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-300" />
        ) : null}
      </div>
      <div className="p-4 min-h-[80px]">
        {text ? (
          <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">
            {text}
            {phase.kind === "streaming" ? (
              <span className="ml-1 inline-block h-3 w-1.5 align-middle bg-brand-400 animate-pulse" />
            ) : null}
          </p>
        ) : (
          <SkeletonLines lines={3} />
        )}
      </div>
    </Card>
  );
}

function DecisionsList({ phase }: { phase: Phase }) {
  const decisions: Decision[] =
    phase.kind === "streaming"
      ? phase.decisions
      : phase.kind === "done"
      ? phase.proposal.decisions
      : [];

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-xs font-medium">Decisions</span>
        <Badge variant="outline">{decisions.length}</Badge>
      </div>
      {decisions.length === 0 ? (
        <div className="p-4 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonLines key={i} lines={2} />
          ))}
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          <AnimatePresence initial={false}>
            {decisions.map((d, i) => (
              <motion.div
                key={`${d.topic}-${d.choice}-${i}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="p-4"
              >
                <div className="flex items-start gap-3">
                  <BrandIcon id={brandIdFor(d)} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {d.topic}
                      </Badge>
                      <span className="text-sm font-medium">{d.choice}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                      {d.reasoning}
                    </p>
                    {d.tradeoff ? (
                      <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-300/80">
                        <span className="font-medium uppercase tracking-wide">
                          Tradeoff:
                        </span>
                        <span className="text-amber-200/80">{d.tradeoff}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Card>
  );
}

function SkeletonSidebar() {
  return (
    <Card className="p-4 space-y-3">
      <SkeletonLines lines={2} />
      <SkeletonLines lines={2} />
      <SkeletonLines lines={2} />
      <SkeletonLines lines={2} />
    </Card>
  );
}

function SkeletonLines({ lines }: { lines: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-3 rounded bg-white/[0.04] animate-pulse"
          style={{ width: `${65 + ((i * 13) % 30)}%` }}
        />
      ))}
    </div>
  );
}

function ProposalSidebar({
  proposal,
  intent,
}: {
  proposal: ArchitectureProposal;
  intent: string;
}) {
  const router = useRouter();
  const { applyProposal } = useStackStore();
  const { config, predictions } = proposal;

  function applyToBuilder() {
    applyProposal(config);
    toast({
      title: "Architecture applied",
      description: `${config.name} loaded into the Builder.`,
      kind: "success",
    });
    router.push("/builder");
  }

  function previewRepo() {
    applyProposal(config);
    router.push("/preview");
  }

  return (
    <div className="space-y-4">
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-30" />
        <div className="relative p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
            <span className="text-xs font-semibold text-emerald-200">
              Architecture ready
            </span>
          </div>
          <div className="mt-2 text-sm font-mono">{config.name}</div>
          <Button
            onClick={applyToBuilder}
            variant="glow"
            size="lg"
            className="mt-4 w-full"
          >
            Open in Builder <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            onClick={previewRepo}
            variant="secondary"
            size="sm"
            className="mt-2 w-full"
          >
            Preview repository <ArrowUpRight className="h-3.5 w-3.5" />
          </Button>
          <div className="mt-2">
            <PublishButton
              proposal={proposal}
              intent={intent}
              variant="ghost"
              size="sm"
              label="Publish & share"
            />
          </div>
        </div>
      </Card>

      <Card>
        <div className="border-b border-white/[0.06] px-4 py-3">
          <div className="text-xs font-semibold">Predictions</div>
          <div className="text-[10px] text-muted-foreground">
            Year-1 typical traffic
          </div>
        </div>
        <div className="divide-y divide-white/[0.04]">
          <PredictionRow
            icon={<CircleDollarSign className="h-3.5 w-3.5" />}
            label="Monthly cost"
            value={`$${Math.round(predictions.monthlyCostUsd).toLocaleString()}`}
          />
          <PredictionRow
            icon={<Gauge className="h-3.5 w-3.5" />}
            label="P99 latency"
            value={`~${Math.round(predictions.p99LatencyMs)}ms`}
          />
          <PredictionRow
            icon={<Zap className="h-3.5 w-3.5" />}
            label="Throughput / replica"
            value={`${formatNumber(predictions.maxRpsPerReplica)} rps`}
          />
          <PredictionRow
            icon={<Lock className="h-3.5 w-3.5" />}
            label="Vendor lock-in"
            value={`${predictions.vendorLockInScore.toFixed(1)} / 10`}
            valueClass={lockInClass(predictions.vendorLockInScore)}
          />
          {predictions.compliance.length ? (
            <div className="px-4 py-2.5">
              <div className="text-xs text-muted-foreground mb-1.5">
                Compliance
              </div>
              <div className="flex flex-wrap gap-1.5">
                {predictions.compliance.map((c) => (
                  <Badge key={c} variant="brand">
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <div className="border-b border-white/[0.06] px-4 py-3">
          <div className="text-xs font-semibold">Stack at a glance</div>
        </div>
        <div className="p-3 grid grid-cols-3 gap-2">
          <StackTile id={config.language} label="Runtime" />
          <StackTile id={config.database} label="Database" />
          <StackTile id={config.cache} label="Cache" />
          <StackTile id={config.queue} label="Queue" />
          <StackTile id={config.auth} label="Auth" />
          <StackTile id={config.deployment} label="Deploy" />
        </div>
      </Card>
    </div>
  );
}

function PredictionRow({
  icon,
  label,
  value,
  valueClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 text-xs">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className={cn("font-semibold", valueClass)}>{value}</span>
    </div>
  );
}

function StackTile({ id, label }: { id: string; label: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2 flex flex-col items-center gap-1">
      <BrandIcon id={id} size={26} />
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-[10px] font-mono text-foreground/90 truncate w-full text-center">
        {id}
      </div>
    </div>
  );
}

function brandIdFor(d: Decision): string {
  // Most decisions' `choice` is already a brand id; fall back to topic if not.
  const choiceLower = d.choice.toLowerCase().replace(/\s+/g, "-");
  return choiceLower;
}

function lockInClass(score: number) {
  if (score <= 3) return "text-emerald-300";
  if (score <= 6) return "text-amber-300";
  return "text-red-300";
}

function formatNumber(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

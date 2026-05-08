import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  CircleDollarSign,
  Eye,
  Gauge,
  GitFork,
  Lock,
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
import { get, recordView } from "@/lib/share-store";
import { ForkButton } from "./fork-button";
import { ShareLink } from "./share-link";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const shared = get(slug);
  if (!shared) {
    return {
      title: "Architecture not found · Helios",
      robots: { index: false },
    };
  }
  const { proposal } = shared;
  const title = `${proposal.config.name} · Architected by Helios`;
  const description = proposal.summary.slice(0, 200);
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      siteName: "Helios",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function ShowPage({ params }: Props) {
  const { slug } = await params;
  const shared = get(slug);
  if (!shared) notFound();
  recordView(slug);

  const { proposal, intent, createdAt, views, forks } = shared;
  const { config, predictions, decisions } = proposal;

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
            <ShareLink slug={slug} />
            <Button asChild variant="glow" size="sm">
              <Link href="/start">
                <Sparkles className="h-3.5 w-3.5" />
                Architect yours
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-10 md:py-14">
        <div className="mx-auto max-w-5xl">
          {/* hero */}
          <div className="text-center">
            <Badge variant="brand" className="mx-auto inline-flex">
              <Sparkles className="h-3 w-3" /> Architected by Helios
            </Badge>
            <h1 className="mt-5 text-4xl md:text-5xl font-semibold tracking-tight text-gradient">
              {config.name}
            </h1>
            <p className="mt-4 text-sm md:text-base text-muted-foreground max-w-2xl mx-auto">
              {proposal.summary}
            </p>

            <div className="mt-5 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3 w-3" /> {views.toLocaleString()} view{views === 1 ? "" : "s"}
              </span>
              <span className="text-white/20">·</span>
              <span className="flex items-center gap-1.5">
                <GitFork className="h-3 w-3" /> {forks.toLocaleString()} fork{forks === 1 ? "" : "s"}
              </span>
              <span className="text-white/20">·</span>
              <span>
                Published {new Date(createdAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
              <ForkButton slug={slug} proposal={proposal} />
              <Button asChild variant="secondary" size="lg">
                <Link href="/start">
                  <Wand2 className="h-4 w-4" /> Start your own
                </Link>
              </Button>
            </div>
          </div>

          {/* the original brief */}
          <div className="mt-10 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
            <div className="flex items-start gap-3">
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
                <Wand2 className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                  Original brief
                </div>
                <p className="mt-1 text-sm md:text-base">{intent}</p>
              </div>
            </div>
          </div>

          {/* stack at a glance */}
          <section className="mt-10">
            <SectionHeader title="The stack" />
            <div className="mt-3 grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              {[
                { label: "Runtime", id: config.language, sub: config.framework },
                { label: "Database", id: config.database },
                { label: "Cache", id: config.cache },
                { label: "Queue", id: config.queue },
                { label: "Auth", id: config.auth },
                { label: "Deploy", id: config.deployment },
              ].map((s) => (
                <Card key={s.label} className="p-4 flex flex-col items-center gap-2 hover-raise">
                  <BrandIcon id={s.id} size={36} />
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </div>
                  <div className="text-xs font-mono text-foreground/90 truncate w-full text-center">
                    {s.id}
                  </div>
                  {s.sub ? (
                    <div className="text-[10px] text-muted-foreground font-mono truncate w-full text-center">
                      {s.sub}
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>

          {/* predictions */}
          <section className="mt-10">
            <SectionHeader
              title="Predictions"
              subtitle="Year-one typical traffic, calibrated against similar workloads."
            />
            <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <PredictionCard
                icon={<CircleDollarSign className="h-4 w-4" />}
                label="Monthly cost"
                value={`$${Math.round(predictions.monthlyCostUsd).toLocaleString()}`}
              />
              <PredictionCard
                icon={<Gauge className="h-4 w-4" />}
                label="P99 latency"
                value={`~${Math.round(predictions.p99LatencyMs)}ms`}
              />
              <PredictionCard
                icon={<Zap className="h-4 w-4" />}
                label="Throughput / replica"
                value={`${formatNumber(predictions.maxRpsPerReplica)} rps`}
              />
              <PredictionCard
                icon={<Lock className="h-4 w-4" />}
                label="Vendor lock-in"
                value={`${predictions.vendorLockInScore.toFixed(1)} / 10`}
                tone={lockInTone(predictions.vendorLockInScore)}
              />
            </div>
            {predictions.compliance.length ? (
              <Card className="mt-3 p-4 flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-xs">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                  <span className="text-muted-foreground">Compliance posture</span>
                </div>
                {predictions.compliance.map((c) => (
                  <Badge key={c} variant="brand">
                    {c}
                  </Badge>
                ))}
              </Card>
            ) : null}
          </section>

          {/* decisions */}
          <section className="mt-10">
            <SectionHeader
              title="Decision log"
              subtitle="Why each choice — and what was given up."
            />
            <Card className="mt-3 divide-y divide-white/[0.04]">
              {decisions.map((d, i) => (
                <div key={i} className="p-4 flex items-start gap-3">
                  <BrandIcon id={brandIdFor(d.choice)} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {d.topic}
                      </Badge>
                      <span className="text-sm font-medium">{d.choice}</span>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                      {d.reasoning}
                    </p>
                    {d.tradeoff ? (
                      <div className="mt-2 flex items-start gap-1.5 text-[11px]">
                        <span className="font-medium uppercase tracking-wide text-amber-300/90">
                          Tradeoff:
                        </span>
                        <span className="text-amber-200/80">{d.tradeoff}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </Card>
          </section>

          {/* CTA */}
          <section className="mt-12">
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-8 md:p-10 text-center">
              <div className="pointer-events-none absolute -inset-20 aurora animate-aurora opacity-40" />
              <div className="relative">
                <Badge variant="brand" className="mx-auto inline-flex">
                  <Sparkles className="h-3 w-3" /> Build yours in 8 seconds
                </Badge>
                <h2 className="mt-4 text-2xl md:text-3xl font-semibold tracking-tight text-gradient">
                  Describe your product. Ship the system.
                </h2>
                <p className="mt-3 text-sm text-muted-foreground max-w-lg mx-auto">
                  Helios designs the architecture, picks the stack, predicts
                  cost and latency, and generates a deployable repo.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  <Button asChild variant="glow" size="lg">
                    <Link href="/start">
                      Architect mine <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                  <ForkButton slug={slug} proposal={proposal} variant="secondary" />
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-white/[0.06] mt-10">
        <div className="container py-6 flex items-center justify-between text-xs text-muted-foreground">
          <Logo compact />
          <div className="flex items-center gap-3">
            <span>Architected by Helios.</span>
            <Link href="/start" className="hover:text-foreground">
              Build yours →
            </Link>
          </div>
        </div>
      </footer>
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

function PredictionCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card className="p-4 hover-raise">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={`mt-2 text-xl font-semibold ${tone ?? ""}`}>{value}</div>
    </Card>
  );
}

function brandIdFor(choice: string): string {
  return choice.toLowerCase().replace(/\s+/g, "-");
}

function lockInTone(score: number) {
  if (score <= 3) return "text-emerald-300";
  if (score <= 6) return "text-amber-300";
  return "text-red-300";
}

function formatNumber(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

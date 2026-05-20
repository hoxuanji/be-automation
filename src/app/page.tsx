"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  BrainCircuit,
  Globe,
  Sparkles,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HeroInfraPreview } from "@/components/landing/hero-infra-preview";
import { FeaturesGrid } from "@/components/landing/features-grid";
import { StackGenerationDemo } from "@/components/landing/stack-generation-demo";
import { LogoWall } from "@/components/landing/logo-wall";
import { CtaSection } from "@/components/landing/cta-section";

const HERO_LANGUAGES = [
  { id: "go", label: "Go", color: "#22d3ee" },
  { id: "typescript", label: "TypeScript", color: "#60a5fa" },
  { id: "python", label: "Python", color: "#facc15" },
  { id: "rust", label: "Rust", color: "#fb923c" },
  { id: "java", label: "Java", color: "#f87171" },
  { id: "kotlin", label: "Kotlin", color: "#a78bfa" },
];

function useProjectCount() {
  const [count, setCount] = React.useState<number | null>(null);
  React.useEffect(() => {
    fetch("/api/stats").then((r) => r.json()).then((d: { projectCount?: number }) => setCount(d.projectCount ?? null)).catch(() => {});
  }, []);
  return count;
}

export default function LandingPage() {
  const projectCount = useProjectCount();
  return (
    <div className="relative isolate overflow-hidden">
      {/* background */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-60" />
        <div className="absolute -top-40 left-1/2 h-[520px] w-[1100px] -translate-x-1/2 aurora animate-aurora" />
        <div className="absolute inset-0 noise" />
      </div>

      <SiteHeader />

      <section className="container pt-20 pb-24">
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <Badge variant="brand" className="mx-auto inline-flex">
              <Sparkles className="h-3 w-3" />
              Go · TypeScript · Python · Rust · Java · Kotlin
            </Badge>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-6 text-5xl md:text-7xl font-semibold tracking-tight text-gradient"
          >
            One generator.
            <br />
            Every backend{" "}
            <span className="text-gradient-brand">language.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.12 }}
            className="mt-6 text-base md:text-lg text-muted-foreground max-w-2xl mx-auto"
          >
            Configure your stack visually — pick your language, framework, database, queues,
            auth, and deployment target. Download a real, buildable, production-ready
            repository in seconds. No lock-in, no boilerplate.
          </motion.p>

          {/* Language pill strip */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.17 }}
            className="mt-6 flex flex-wrap items-center justify-center gap-2"
          >
            {HERO_LANGUAGES.map((lang) => (
              <span
                key={lang.id}
                className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-foreground/80"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: lang.color }}
                />
                {lang.label}
              </span>
            ))}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.22 }}
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
          >
            <Button asChild variant="glow" size="xl">
              <Link href="/builder">
                Start building
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="xl">
              <Link href="/gallery">
                <Globe className="h-4 w-4" />
                Browse gallery
              </Link>
            </Button>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="mt-6 flex items-center justify-center gap-6 text-xs text-muted-foreground"
          >
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              99.99% uptime
            </span>
            <span className="flex items-center gap-1.5">
              <TerminalIcon className="h-3 w-3" />
              {projectCount !== null ? `${projectCount.toLocaleString()} stacks generated` : "Stacks generated daily"}
            </span>
            <span className="hidden md:flex items-center gap-1.5">
              <BrainCircuit className="h-3 w-3" />
              SOC2 · GDPR ready
            </span>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.35 }}
          className="mt-16"
        >
          <HeroInfraPreview />
        </motion.div>
      </section>

      <LogoWall />

      <FeaturesGrid />

      <StackGenerationDemo />

      <PricingSection />

      <CtaSection />

      <SiteFooter />
    </div>
  );
}

const PRICING_TIERS = [
  {
    name: "Hobby",
    price: "Free",
    description: "For solo developers getting started.",
    features: ["5 generated stacks / month", "All 6 languages", "Download as zip", "Public gallery access", "Community support"],
    cta: "Start for free",
    href: "/login",
    highlight: false,
  },
  {
    name: "Pro",
    price: "$19",
    per: "/ month",
    description: "For developers who ship regularly.",
    features: ["Unlimited stacks", "GitHub push integration", "Railway one-click deploy", "Private gallery stacks", "Team (up to 5 members)", "Priority support"],
    cta: "Get started",
    href: "/login",
    highlight: true,
  },
  {
    name: "Team",
    price: "$49",
    per: "/ month",
    description: "For teams building together.",
    features: ["Everything in Pro", "Unlimited team members", "Shared stack presets", "Audit logs", "SSO / SAML (coming soon)", "Dedicated support"],
    cta: "Contact us",
    href: "mailto:hello@helios.app",
    highlight: false,
  },
];

function PricingSection() {
  return (
    <section id="pricing" className="container py-24">
      <div className="mx-auto max-w-2xl text-center mb-12">
        <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">Simple pricing</h2>
        <p className="mt-3 text-muted-foreground">Start free. Upgrade when you need more.</p>
      </div>
      <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
        {PRICING_TIERS.map((tier) => (
          <div
            key={tier.name}
            className={`relative rounded-2xl border p-6 flex flex-col gap-5 ${tier.highlight ? "border-brand-500/50 bg-brand-500/[0.04]" : "border-white/[0.06] bg-white/[0.02]"}`}
          >
            {tier.highlight && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-brand-500/40 bg-brand-500/20 px-3 py-0.5 text-[11px] font-medium text-brand-300">
                Most popular
              </span>
            )}
            <div>
              <p className="text-sm font-medium text-muted-foreground">{tier.name}</p>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-3xl font-bold">{tier.price}</span>
                {tier.per && <span className="text-sm text-muted-foreground">{tier.per}</span>}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{tier.description}</p>
            </div>
            <ul className="space-y-2 flex-1">
              {tier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-xs text-foreground/80">
                  <span className="mt-0.5 h-3.5 w-3.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-[9px] shrink-0">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <Button asChild variant={tier.highlight ? "glow" : "secondary"} size="sm">
              <Link href={tier.href}>{tier.cta}</Link>
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/70 backdrop-blur-md">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-8">
          <Logo />
          <nav className="hidden md:flex items-center gap-5 text-xs text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#demo" className="hover:text-foreground transition-colors">Demo</a>
            <Link href="/gallery" className="hover:text-foreground transition-colors">Gallery</Link>
            <Link href="/templates" className="hover:text-foreground transition-colors">Templates</Link>
            <a href="#pricing" className="hover:text-foreground transition-colors">Pricing</a>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="glow" size="sm">
            <Link href="/login">
              Get started
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="container py-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <Logo compact />
          <span>© 2026 Helios Labs, Inc.</span>
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <Link href="/changelog" className="hover:text-foreground">Changelog</Link>
          <Link href="/api/health" className="hover:text-foreground" target="_blank">Status</Link>
          <a href="mailto:security@helios.app" className="hover:text-foreground">Security</a>
          <a href="#pricing" className="hover:text-foreground">Terms</a>
          <a href="#pricing" className="hover:text-foreground">Privacy</a>
        </div>
      </div>
    </footer>
  );
}

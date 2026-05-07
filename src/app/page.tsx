"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Boxes,
  BrainCircuit,
  Github,
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

export default function LandingPage() {
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
              Introducing Helios 2.0 — AI-native infra builder
            </Badge>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-6 text-5xl md:text-7xl font-semibold tracking-tight text-gradient"
          >
            Generate production-ready
            <br />
            backends in{" "}
            <span className="text-gradient-brand">minutes.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.12 }}
            className="mt-6 text-base md:text-lg text-muted-foreground max-w-2xl mx-auto"
          >
            Visually configure your stack — language, database, cache, queues,
            APIs, deployment, CI/CD — and ship a typed, tested, observable
            repo. Vercel × Railway × Cursor, but for the backend.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
          >
            <Button asChild variant="glow" size="xl">
              <Link href="/builder">
                Start building
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="xl">
              <Link href="/dashboard">
                <TerminalIcon className="h-4 w-4" />
                Live demo
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
              <Boxes className="h-3 w-3" />
              14,209 stacks generated this month
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

      <CtaSection />

      <SiteFooter />
    </div>
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
            <Link href="/dashboard" className="hover:text-foreground transition-colors">Templates</Link>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code/overview"
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Docs
            </a>
            <a href="#cta" className="hover:text-foreground transition-colors">Pricing</a>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="hidden md:inline-flex"
          >
            <a
              href="https://github.com/anthropics/claude-code"
              target="_blank"
              rel="noreferrer"
            >
              <Github className="h-3.5 w-3.5" />
              Star
            </a>
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link href="/dashboard">Sign in</Link>
          </Button>
          <Button asChild variant="glow" size="sm">
            <Link href="/builder">
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
          <Link href="/dashboard" className="hover:text-foreground">Changelog</Link>
          <Link href="/dashboard" className="hover:text-foreground">Status</Link>
          <Link href="/builder" className="hover:text-foreground">Security</Link>
          <a href="#cta" className="hover:text-foreground">Terms</a>
          <a href="#cta" className="hover:text-foreground">Privacy</a>
        </div>
      </div>
    </footer>
  );
}

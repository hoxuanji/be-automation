"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Terminal } from "@/components/shared/terminal";
import { Check, Loader2, Sparkles, Wand2 } from "lucide-react";

const steps = [
  { label: "Analyzing workload", key: "analyze" },
  { label: "Selecting runtime", key: "runtime" },
  { label: "Provisioning database", key: "db" },
  { label: "Wiring cache & queue", key: "cache" },
  { label: "Generating contracts", key: "contracts" },
  { label: "Bundling Docker/K8s", key: "manifest" },
  { label: "Writing CI/CD", key: "ci" },
  { label: "Repository ready", key: "done" },
];

export function StackGenerationDemo() {
  const [step, setStep] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => {
      setStep((s) => (s + 1) % (steps.length + 1));
    }, 1100);
    return () => clearInterval(t);
  }, []);

  return (
    <section id="demo" className="container py-24">
      <div className="grid gap-10 lg:grid-cols-2 items-center">
        <div>
          <Badge variant="brand">
            <Sparkles className="h-3 w-3" />
            Watch it generate
          </Badge>
          <h2 className="mt-4 text-3xl md:text-4xl font-semibold tracking-tight text-gradient">
            From prompt to PR in under a minute.
          </h2>
          <p className="mt-4 text-sm md:text-base text-muted-foreground max-w-xl">
            Type what you want, pick defaults visually, and watch Helios stitch
            together infrastructure, APIs, manifests, and deployment — all
            streamed live with audit trails.
          </p>

          <div className="mt-8 space-y-2">
            {steps.map((s, i) => {
              const state = i < step ? "done" : i === step ? "active" : "idle";
              return (
                <div
                  key={s.key}
                  className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                >
                  <div
                    className={`grid h-6 w-6 place-items-center rounded-md border ${
                      state === "done"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : state === "active"
                        ? "border-brand-500/40 bg-brand-500/10 text-brand-300"
                        : "border-white/10 bg-white/[0.02] text-muted-foreground"
                    }`}
                  >
                    {state === "done" ? (
                      <Check className="h-3 w-3" />
                    ) : state === "active" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                    )}
                  </div>
                  <span
                    className={`text-sm ${
                      state === "idle"
                        ? "text-muted-foreground"
                        : "text-foreground"
                    }`}
                  >
                    {s.label}
                  </span>
                  {state === "active" ? (
                    <span className="ml-auto text-[10px] font-mono text-brand-300">
                      in progress
                    </span>
                  ) : state === "done" ? (
                    <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                      done
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
              <Wand2 className="h-3.5 w-3.5 text-brand-300" />
              <span className="text-xs font-medium">Prompt</span>
            </div>
            <div className="p-4">
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-sm text-foreground font-mono"
              >
                &gt; “I need a low-latency REST API in Go with Postgres, Redis
                cache, JWT auth, rate limiting, deployed to Railway. Add audit
                logs and Grafana dashboards.”
              </motion.p>
            </div>
          </Card>

          <Terminal
            animate
            title="helios generate · live"
            lines={[
              { kind: "prompt", text: "helios generate --prompt ./spec.md" },
              { kind: "info", text: "→ parsing intent · detected: REST, go, postgres, redis" },
              { kind: "out", text: "→ resolving dependencies … gin@1.10 pgx@5 redis@9" },
              { kind: "ok", text: "✓ scaffolded 48 files (172kb)" },
              { kind: "out", text: "→ writing Dockerfile, helm chart, .github/workflows" },
              { kind: "out", text: "→ generating OpenAPI spec (12 endpoints)" },
              { kind: "ok", text: "✓ tests: 34 passed · 0 failed" },
              { kind: "info", text: "→ pushing to git@github.com:acme/helios-api.git" },
              { kind: "ok", text: "✓ Ready: https://helios.dev/p/helios-api" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}

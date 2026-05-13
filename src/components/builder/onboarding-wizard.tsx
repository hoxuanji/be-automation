"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronRight, LayoutGrid, Rocket, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStackStore } from "@/lib/store";
import { BrandIcon } from "@/components/shared/brand-icon";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "helios:onboarded";

const LANGUAGES = [
  { id: "go", label: "Go", desc: "Fast, compiled, great for microservices" },
  { id: "typescript", label: "TypeScript", desc: "Node.js with full type safety" },
  { id: "python", label: "Python", desc: "Great for data-heavy or ML workloads" },
  { id: "rust", label: "Rust", desc: "Maximum performance, memory safe" },
  { id: "java", label: "Java", desc: "Enterprise-grade, Spring ecosystem" },
  { id: "kotlin", label: "Kotlin", desc: "Modern JVM with Ktor or Spring" },
];

const DATABASES = [
  { id: "postgres", label: "PostgreSQL", desc: "Best-in-class relational DB" },
  { id: "mongodb", label: "MongoDB", desc: "Flexible document store" },
  { id: "mysql", label: "MySQL", desc: "Widely used relational DB" },
  { id: "sqlite", label: "SQLite", desc: "Embedded, zero-config" },
  { id: "neon", label: "Neon", desc: "Serverless Postgres" },
  { id: "supabase", label: "Supabase", desc: "Postgres with auth & storage" },
];

export function OnboardingWizard() {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [name, setName] = React.useState("");
  const [language, setLanguage] = React.useState("go");
  const [database, setDatabase] = React.useState("postgres");
  const { patch } = useStackStore();
  const router = useRouter();

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const done = localStorage.getItem(STORAGE_KEY);
    if (!done) setOpen(true);
  }, []);

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  function finish() {
    patch({
      name: name.trim() || "my-api",
      language,
      database,
    });
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
  }

  function goToTemplates() {
    localStorage.setItem(STORAGE_KEY, "1");
    setOpen(false);
    router.push("/templates");
  }

  if (!open) return null;

  const steps = ["Name & language", "Database", "You're set"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismiss} />
      <div className="relative w-full max-w-lg rounded-2xl border border-white/[0.08] bg-[hsl(224,32%,5%)] shadow-2xl overflow-hidden">
        <div className="pointer-events-none absolute -right-20 -top-20 h-[280px] w-[360px] aurora animate-aurora opacity-40" />

        <div className="relative">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
            <div className="flex items-center gap-2">
              <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="text-sm font-semibold">Welcome to Helios</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                {steps.map((s, i) => (
                  <React.Fragment key={s}>
                    <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${i === step ? "bg-brand-500/15 text-brand-300" : i < step ? "text-emerald-300" : "text-muted-foreground"}`}>
                      {i < step ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                    </div>
                    {i < steps.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/40" />}
                  </React.Fragment>
                ))}
              </div>
              <button onClick={dismiss} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Step content */}
          <div className="px-6 py-5 space-y-4">
            {step === 0 && (
              <>
                <div>
                  <h2 className="text-base font-semibold">Name your project</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Pick a name and a primary language — or start from a template.
                  </p>
                </div>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") setStep(1); }}
                  placeholder="my-api"
                  className="font-mono"
                  autoFocus
                />
                <div className="grid grid-cols-2 gap-2">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => setLanguage(l.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                        language === l.id
                          ? "border-brand-500/50 bg-brand-500/[0.06]"
                          : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
                      )}
                    >
                      <BrandIcon id={l.id} size={20} />
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{l.label}</div>
                        <div className="text-[10px] text-muted-foreground truncate">{l.desc}</div>
                      </div>
                      {language === l.id && <Check className="h-3.5 w-3.5 text-brand-300 shrink-0 ml-auto" />}
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div>
                  <h2 className="text-base font-semibold">Pick your database</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Helios generates schema migrations and ORM models for your choice.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {DATABASES.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setDatabase(d.id)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                        database === d.id
                          ? "border-brand-500/50 bg-brand-500/[0.06]"
                          : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
                      )}
                    >
                      <BrandIcon id={d.id} size={20} />
                      <div className="min-w-0">
                        <div className="text-xs font-medium">{d.label}</div>
                        <div className="text-[10px] text-muted-foreground truncate">{d.desc}</div>
                      </div>
                      {database === d.id && <Check className="h-3.5 w-3.5 text-brand-300 shrink-0 ml-auto" />}
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div>
                  <h2 className="text-base font-semibold">You&apos;re ready to build</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Your stack is configured. Here&apos;s what to explore next.
                  </p>
                </div>
                <div className="space-y-2">
                  {[
                    { icon: Sparkles, title: "Describe your project with AI", desc: "Claude will suggest entities, endpoints, and the full stack config." },
                    { icon: LayoutGrid, title: "Browse starter templates", desc: "12 production-ready blueprints across Go, TypeScript, and Python." },
                    { icon: Rocket, title: "Download when ready", desc: "Preview your repo, then download a zip with all CRUD code included." },
                  ].map(({ icon: Icon, title, desc }) => (
                    <div key={title} className="flex items-start gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-brand-500/30 bg-brand-500/10 text-brand-300">
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <div className="text-xs font-medium">{title}</div>
                        <div className="text-[11px] text-muted-foreground">{desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-white/[0.06] px-6 py-4">
            <button onClick={goToTemplates} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <LayoutGrid className="h-3.5 w-3.5" /> Start from a template
            </button>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <Button variant="secondary" size="sm" onClick={() => setStep((s) => s - 1)}>
                  Back
                </Button>
              )}
              {step < 2 ? (
                <Button variant="glow" size="sm" onClick={() => setStep((s) => s + 1)}>
                  Next <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button variant="glow" size="sm" onClick={finish}>
                  <Check className="h-3.5 w-3.5" /> Start building
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

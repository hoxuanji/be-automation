"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const examples = [
  "B2B SaaS CRM, 10k seats",
  "Realtime multiplayer game, SEA",
  "AI inference API, GPU autoscaling",
  "HIPAA telehealth backend",
  "Event-driven fintech ledger",
];

export function LandingIntentInput() {
  const router = useRouter();
  const [value, setValue] = React.useState("");

  function go(text: string) {
    if (!text.trim()) return;
    router.push(`/start?intent=${encodeURIComponent(text)}`);
  }

  return (
    <div className="mx-auto mt-10 max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
        className="relative rounded-2xl border border-white/[0.08] bg-white/[0.02] p-1.5 backdrop-blur-md focus-within:border-brand-500/40 transition-colors shadow-2xl shadow-brand-500/5"
      >
        <div className="flex items-center gap-2 p-1.5 pl-3">
          <Wand2 className="h-4 w-4 text-brand-300 shrink-0" />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Describe what you're building…"
            className="flex-1 bg-transparent py-2.5 text-sm md:text-base placeholder:text-muted-foreground/60 focus:outline-none"
          />
          <Button type="submit" variant="glow" size="lg" disabled={!value.trim()}>
            <Sparkles className="h-4 w-4" />
            Architect
          </Button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
        <span className="text-[11px] text-muted-foreground/70">Try:</span>
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => go(ex)}
            className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function CtaSection() {
  return (
    <section id="cta" className="container py-24">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-10 md:p-14 text-center">
        <div className="pointer-events-none absolute -inset-20 aurora animate-aurora" />
        <div className="relative">
          <Badge variant="brand" className="mx-auto inline-flex">
            <Sparkles className="h-3 w-3" />
            Ready when you are
          </Badge>
          <h2 className="mt-5 text-3xl md:text-5xl font-semibold tracking-tight text-gradient">
            Stop scaffolding.
            <br />
            Start shipping.
          </h2>
          <p className="mt-5 text-sm md:text-base text-muted-foreground max-w-xl mx-auto">
            Generate your next production backend in under a minute. Free for
            solo developers, generous limits for teams.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild variant="glow" size="xl">
              <Link href="/builder">
                Start generating
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="secondary" size="xl">
              <Link href="/dashboard">Try the dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

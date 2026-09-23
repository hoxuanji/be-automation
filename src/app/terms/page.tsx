import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Terms of Service — Helios" };

const SECTIONS = [
  {
    title: "Beta service",
    body: "Helios is in public beta and provided as-is, without warranties of any kind. Features may change or be removed without notice. There is currently no paid plan and no billing.",
  },
  {
    title: "Your content",
    body: "You own the stack configurations you create and the repositories Helios generates for you. You are responsible for reviewing generated code before running it in production.",
  },
  {
    title: "Connected accounts",
    body: "When you connect GitHub, Bitbucket or a deploy provider, Helios acts on your behalf only for the actions you trigger (e.g. pushing a repo or starting a deploy).",
  },
  {
    title: "Acceptable use",
    body: "Don't use Helios to generate or deploy malicious software, abuse third-party providers, or attempt to access other users' data.",
  },
  {
    title: "Contact",
    body: "Questions about these terms: hello@helios.app.",
  },
];

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-40" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/70 backdrop-blur-md">
        <div className="container flex h-14 items-center gap-6">
          <Link href="/"><Logo /></Link>
          <span className="text-sm text-muted-foreground">Terms</span>
        </div>
      </header>

      <main className="container py-16 max-w-2xl">
        <Badge variant="outline" className="mb-4 text-[10px]">Draft — not yet reviewed by counsel</Badge>
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-muted-foreground text-sm mb-12">
          Placeholder terms for the Helios beta. A final version will replace this page before any paid plan launches.
        </p>

        <div className="space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h2 className="text-sm font-medium mb-2">{s.title}</h2>
              <p className="text-sm text-foreground/80 leading-relaxed">{s.body}</p>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

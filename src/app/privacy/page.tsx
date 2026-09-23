import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Privacy Policy — Helios" };

const SECTIONS = [
  {
    title: "What we store",
    body: "Your account profile from GitHub or Bitbucket sign-in (name, email, avatar), saved projects and stack configurations, team memberships, and the access tokens needed for integrations you connect.",
  },
  {
    title: "AI copilot",
    body: "Messages you send to the AI copilot, together with your current stack configuration, are sent to Anthropic to generate a response.",
  },
  {
    title: "Tokens",
    body: "Deploy-provider tokens are used only for actions you trigger and are cleared when you log out.",
  },
  {
    title: "Contact",
    body: "Privacy questions or deletion requests: security@helios.app.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-40" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/70 backdrop-blur-md">
        <div className="container flex h-14 items-center gap-6">
          <Link href="/"><Logo /></Link>
          <span className="text-sm text-muted-foreground">Privacy</span>
        </div>
      </header>

      <main className="container py-16 max-w-2xl">
        <Badge variant="outline" className="mb-4 text-[10px]">Draft — not yet reviewed by counsel</Badge>
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-muted-foreground text-sm mb-12">
          Placeholder policy for the Helios beta. A final version will replace this page before any paid plan launches.
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

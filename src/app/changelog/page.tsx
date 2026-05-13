import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Badge } from "@/components/ui/badge";

const ENTRIES = [
  {
    version: "0.5.0",
    date: "2026-05-12",
    tag: "latest",
    changes: [
      "Public stack gallery — share and browse community stacks",
      "Team invites — link-based invitations with 7-day expiry",
      "Password reset flow with optional Resend email integration",
      "Session-based JWT revocation — logout is now server-side",
      "Project rename and delete from the builder menu",
      "Real-time stats on landing page",
      "SQLite persistence warning on ephemeral deployments",
      "GraphQL / tRPC marked as coming soon in the API panel",
      "Deploy page — non-Railway providers labelled CLI only",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-04-28",
    changes: [
      "Client SDK generation — TypeScript and Python clients from endpoints",
      "Shareable stack URLs via base64-encoded ?stack= param",
      "Preview page wired into the main configure → review → download flow",
      "Stack diff tab — see which files changed when you edit config",
      "AI copilot dependency audit — proactive warnings per stack",
      "Env var documentation — inline comments in .env.example",
      "README badge injected into every generated repo",
      "Save/load projects from the builder sidebar",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-04-10",
    changes: [
      "6-language smoke tests in CI (Go, TypeScript, Python, Rust, Java, Kotlin)",
      "GitHub push from the preview page",
      "Railway one-click deploy with SSE progress streaming",
      "Entity builder — model fields, types, and relationships",
      "SQL DDL migration generation from entities",
      "JWKS-based auth middleware for all 6 languages",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-03-20",
    changes: [
      "gRPC support with buf.yaml + proto generation",
      "Stack templates — 12 presets across Go, TypeScript, Python",
      "OAuth via GitHub",
      "Workspace and project persistence with SQLite",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-03-01",
    changes: [
      "Initial release — Go, TypeScript, Python generation",
      "Zustand-based stack configurator with 10 tabs",
      "AI copilot powered by Claude Sonnet",
      "Download as zip",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-40" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/[0.04] bg-background/70 backdrop-blur-md">
        <div className="container flex h-14 items-center gap-6">
          <Link href="/"><Logo /></Link>
          <span className="text-sm text-muted-foreground">Changelog</span>
        </div>
      </header>

      <main className="container py-16 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight mb-2">Changelog</h1>
        <p className="text-muted-foreground text-sm mb-12">
          Every release, in reverse chronological order.
        </p>

        <div className="space-y-12">
          {ENTRIES.map((entry) => (
            <div key={entry.version} className="flex gap-6">
              <div className="w-28 shrink-0 text-right">
                <div className="font-mono text-sm font-medium">v{entry.version}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{entry.date}</div>
                {entry.tag && (
                  <Badge variant="brand" className="mt-1 text-[10px]">{entry.tag}</Badge>
                )}
              </div>
              <div className="flex-1 border-l border-white/[0.06] pl-6">
                <ul className="space-y-2">
                  {entry.changes.map((c) => (
                    <li key={c} className="flex items-start gap-2 text-sm text-foreground/80">
                      <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand-400 shrink-0" />
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

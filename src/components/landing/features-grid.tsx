import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Shield,
  Gauge,
  GitBranch,
  Boxes,
  Cloud,
  Terminal,
  CircuitBoard,
  FileCode2,
} from "lucide-react";

const features = [
  {
    icon: Sparkles,
    title: "AI-recommended stacks",
    desc: "Describe your workload in plain English. Helios suggests a stack optimized for cost, latency and operability.",
    tag: "AI",
    tone: "from-brand-500/20 to-purple-500/20",
  },
  {
    icon: CircuitBoard,
    title: "Visual architecture",
    desc: "Click-to-configure nodes for services, caches, queues. Connect them — we generate the wire.",
    tag: "Visual",
    tone: "from-emerald-500/20 to-brand-500/20",
  },
  {
    icon: FileCode2,
    title: "Typed API contracts",
    desc: "Design REST or gRPC endpoints. OpenAPI, protobuf, SDKs and clients generated side-by-side.",
    tag: "Contracts",
    tone: "from-purple-500/20 to-pink-500/20",
  },
  {
    icon: Cloud,
    title: "One-click deploy",
    desc: "Ship to Vercel, Railway, Render, Fly or roll your own K8s. Cloud credentials encrypted end-to-end.",
    tag: "Deploy",
    tone: "from-amber-500/20 to-red-500/20",
  },
  {
    icon: Gauge,
    title: "Infra cost estimation",
    desc: "See projected monthly spend per component before you provision. Optimize-as-you-type.",
    tag: "Finops",
    tone: "from-brand-500/20 to-emerald-500/20",
  },
  {
    icon: Shield,
    title: "Security by default",
    desc: "JWT, rate limiting, audit logs, secret scanning, SOC2-ready — wired in from day one.",
    tag: "Security",
    tone: "from-red-500/20 to-amber-500/20",
  },
  {
    icon: GitBranch,
    title: "Git-native workflow",
    desc: "Push to your own GitHub org. CI/CD generated for Actions, GitLab or Argo.",
    tag: "Git",
    tone: "from-white/10 to-white/5",
  },
  {
    icon: Boxes,
    title: "Production manifest",
    desc: "Docker, Helm, Kustomize, Terraform — every artifact your platform team expects.",
    tag: "Manifests",
    tone: "from-brand-500/20 to-purple-500/20",
  },
  {
    icon: Terminal,
    title: "Live code preview",
    desc: "Inspect the generated repository before you download. File-by-file diff, syntax-highlighted.",
    tag: "Preview",
    tone: "from-purple-500/20 to-brand-500/20",
  },
];

export function FeaturesGrid() {
  return (
    <section id="features" className="container py-24">
      <div className="mx-auto max-w-2xl text-center">
        <Badge variant="outline">Why Helios</Badge>
        <h2 className="mt-4 text-3xl md:text-4xl font-semibold tracking-tight text-gradient">
          Everything your backend needs.
          <br />
          None of the yak-shaving.
        </h2>
        <p className="mt-4 text-sm md:text-base text-muted-foreground">
          A single command center for your runtime, data plane, APIs, and
          deployment targets — with an AI copilot that understands trade-offs.
        </p>
      </div>

      <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {features.map((f) => {
          const Icon = f.icon;
          return (
            <Card
              key={f.title}
              className="group relative overflow-hidden hover-raise"
            >
              <div
                className={`pointer-events-none absolute -inset-20 bg-gradient-to-br ${f.tone} opacity-0 blur-3xl group-hover:opacity-100 transition-opacity duration-500`}
              />
              <div className="relative p-5">
                <div className="flex items-center justify-between">
                  <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <Badge variant="outline">{f.tag}</Badge>
                </div>
                <h3 className="mt-4 text-base font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {f.desc}
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

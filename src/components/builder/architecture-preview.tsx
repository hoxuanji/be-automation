"use client";

import { motion } from "framer-motion";
import { Network, Gauge } from "lucide-react";
import { useStackStore } from "@/lib/store";
import { BrandIcon } from "@/components/shared/brand-icon";
import { languages, databases, caches, queues, deployments } from "@/data/stack-options";

type NodeDef = {
  id: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
  x: number;
  y: number;
  tone: string;
};

export function ArchitecturePreview() {
  const { config } = useStackStore();

  const lang = languages.find((l) => l.id === config.language);
  const db = databases.find((d) => d.id === config.database);
  const cache = caches.find((c) => c.id === config.cache);
  const queue = queues.find((q) => q.id === config.queue);
  const deploy = deployments.find((d) => d.id === config.deployment);

  const nodes: NodeDef[] = [
    {
      id: "edge",
      label: deploy?.label ?? "Edge",
      sub: "ingress · cdn",
      x: 10,
      y: 45,
      icon: <BrandIcon id={config.deployment} size={18} />,
      tone: "border-brand-500/30 bg-brand-500/[0.08] text-brand-300",
    },
    {
      id: "api",
      label: config.api.toUpperCase(),
      sub: "api gateway",
      x: 30,
      y: 22,
      icon: <Network className="h-3.5 w-3.5" />,
      tone: "border-white/15 bg-white/[0.04] text-white",
    },
    {
      id: "auth",
      label: "Auth",
      sub: config.auth,
      x: 30,
      y: 68,
      icon: <BrandIcon id={config.auth} size={18} />,
      tone: "border-purple-500/30 bg-purple-500/[0.08] text-purple-300",
    },
    {
      id: "svc",
      label: lang?.label ?? "Service",
      sub: `${config.replicas} replicas`,
      x: 52,
      y: 45,
      icon: <BrandIcon id={config.language} size={18} />,
      tone: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300",
    },
    {
      id: "cache",
      label: cache?.label ?? "Cache",
      sub: "cache · sessions",
      x: 76,
      y: 22,
      icon: <BrandIcon id={config.cache} size={18} />,
      tone: "border-red-500/30 bg-red-500/[0.08] text-red-300",
    },
    {
      id: "db",
      label: db?.label ?? "Database",
      sub: config.region,
      x: 76,
      y: 68,
      icon: <BrandIcon id={config.database} size={18} />,
      tone: "border-blue-500/30 bg-blue-500/[0.08] text-blue-300",
    },
    {
      id: "queue",
      label: queue?.label ?? "Queue",
      sub: "events",
      x: 52,
      y: 88,
      icon: <BrandIcon id={config.queue} size={18} />,
      tone: "border-amber-500/30 bg-amber-500/[0.08] text-amber-300",
    },
  ];

  const edges: [string, string][] = [
    ["edge", "api"],
    ["edge", "auth"],
    ["api", "svc"],
    ["auth", "svc"],
    ["svc", "cache"],
    ["svc", "db"],
    ["svc", "queue"],
  ];

  return (
    <div className="relative rounded-xl border border-white/[0.06] bg-card/40 overflow-hidden card-ring">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-muted-foreground font-mono">
            architecture · {config.name}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Gauge className="h-3 w-3 text-emerald-400" />
            p99 ~42ms · 12.4k rps
          </span>
        </div>
      </div>

      <div className="relative h-[380px] dot-bg">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="edge-grad" x1="0" x2="1">
              <stop offset="0%" stopColor="rgba(86,178,255,0.0)" />
              <stop offset="50%" stopColor="rgba(86,178,255,0.7)" />
              <stop offset="100%" stopColor="rgba(168,85,247,0.0)" />
            </linearGradient>
          </defs>
          {edges.map(([from, to], i) => {
            const a = nodes.find((n) => n.id === from)!;
            const b = nodes.find((n) => n.id === to)!;
            return (
              <g key={i}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="0.15"
                />
                <motion.line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="url(#edge-grad)"
                  strokeWidth="0.3"
                  strokeDasharray="1 2"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{
                    duration: 2,
                    delay: i * 0.15,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                />
              </g>
            );
          })}
        </svg>

        {nodes.map((n, i) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.05 }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <div
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 backdrop-blur-sm ${n.tone}`}
            >
              <div className="grid h-5 w-5 place-items-center shrink-0">
                {n.icon}
              </div>
              <div className="leading-tight pr-1">
                <div className="text-xs font-medium">{n.label}</div>
                <div className="text-[10px] opacity-70">{n.sub}</div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

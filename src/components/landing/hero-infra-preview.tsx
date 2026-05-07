"use client";

import { motion } from "framer-motion";
import {
  Network,
  Gauge,
} from "lucide-react";
import { BrandIcon } from "@/components/shared/brand-icon";

type Node = {
  id: string;
  label: string;
  sub: string;
  x: number;
  y: number;
  icon: React.ReactNode;
  tone: string;
};

const nodes: Node[] = [
  { id: "edge", label: "Edge", sub: "Vercel", x: 10, y: 40, icon: <BrandIcon id="vercel" size={18} />, tone: "text-brand-300 border-brand-500/30 bg-brand-500/[0.08]" },
  { id: "api", label: "API Gateway", sub: "gRPC · REST", x: 32, y: 18, icon: <Network className="h-3.5 w-3.5" />, tone: "text-white border-white/15 bg-white/[0.04]" },
  { id: "auth", label: "Auth", sub: "Clerk", x: 32, y: 62, icon: <BrandIcon id="clerk" size={18} />, tone: "text-purple-300 border-purple-500/30 bg-purple-500/[0.08]" },
  { id: "svc", label: "Service Mesh", sub: "3 replicas", x: 54, y: 40, icon: <BrandIcon id="go" size={18} />, tone: "text-emerald-300 border-emerald-500/30 bg-emerald-500/[0.08]" },
  { id: "cache", label: "Redis", sub: "cache · sessions", x: 76, y: 18, icon: <BrandIcon id="redis" size={18} />, tone: "text-red-300 border-red-500/30 bg-red-500/[0.08]" },
  { id: "db", label: "Postgres 16", sub: "neon · us-east", x: 76, y: 62, icon: <BrandIcon id="postgres" size={18} />, tone: "text-blue-300 border-blue-500/30 bg-blue-500/[0.08]" },
  { id: "queue", label: "NATS JetStream", sub: "events", x: 54, y: 82, icon: <BrandIcon id="nats" size={18} />, tone: "text-amber-300 border-amber-500/30 bg-amber-500/[0.08]" },
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

export function HeroInfraPreview() {
  return (
    <div className="relative mx-auto max-w-6xl rounded-2xl border border-white/[0.06] bg-card/40 backdrop-blur-md card-ring overflow-hidden">
      <div className="absolute inset-0 dot-bg mask-radial opacity-30" />
      <div className="pointer-events-none absolute -inset-x-20 -top-40 h-[300px] aurora animate-aurora" />

      {/* header bar */}
      <div className="relative flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <span className="ml-3 text-xs text-muted-foreground font-mono">
            helios-api — architecture
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            live
          </span>
          <span className="text-white/20">·</span>
          <span className="font-mono">p99: 42ms</span>
        </div>
      </div>

      {/* canvas */}
      <div className="relative h-[420px] md:h-[460px]">
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="edgeGrad" x1="0" x2="1">
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
                  stroke="rgba(255,255,255,0.09)"
                  strokeWidth="0.15"
                />
                <motion.line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="url(#edgeGrad)"
                  strokeWidth="0.35"
                  strokeDasharray="1 2"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{
                    duration: 2,
                    delay: i * 0.2,
                    repeat: Infinity,
                    repeatType: "loop",
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
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <div className="relative">
              <span className="absolute inset-0 rounded-xl bg-brand-500/10 blur-xl" />
              <div
                className={`relative flex items-center gap-2 rounded-xl border px-3 py-2 backdrop-blur-sm ${n.tone}`}
              >
                <div className="grid h-6 w-6 place-items-center shrink-0">
                  {n.icon}
                </div>
                <div className="leading-tight pr-1">
                  <div className="text-xs font-medium">{n.label}</div>
                  <div className="text-[10px] opacity-70">{n.sub}</div>
                </div>
              </div>
            </div>
          </motion.div>
        ))}

        {/* floating metric pills */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.9 }}
          className="absolute right-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur"
        >
          <Gauge className="h-3 w-3 text-emerald-400" />
          <span>throughput 12.4k rps</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.05 }}
          className="absolute left-4 bottom-4 flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span>auto-generated · 4.2s</span>
        </motion.div>
      </div>
    </div>
  );
}

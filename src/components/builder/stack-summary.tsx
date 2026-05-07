"use client";

import { useStackStore } from "@/lib/store";
import {
  languages,
  databases,
  caches,
  queues,
  deployments,
  frameworks,
} from "@/data/stack-options";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CircleDollarSign,
  Cpu,
  Gauge,
  HardDrive,
  Network,
  ShieldCheck,
  TrendingUp,
  Zap,
} from "lucide-react";

export function StackSummary() {
  const { config } = useStackStore();
  const lang = languages.find((l) => l.id === config.language)?.label;
  const fw = frameworks[config.language]?.find((f) => f.id === config.framework)?.label;
  const db = databases.find((d) => d.id === config.database)?.label;
  const cache = caches.find((c) => c.id === config.cache)?.label;
  const queue = queues.find((q) => q.id === config.queue)?.label;
  const deploy = deployments.find((d) => d.id === config.deployment)?.label;

  const cost = estimateCost(config.replicas, config.autoscale, config.kubernetes);

  const rows = [
    { label: "Runtime", value: `${lang} · ${fw}`, icon: Cpu },
    { label: "Database", value: db, icon: HardDrive },
    { label: "Cache", value: cache, icon: Zap },
    { label: "Queue", value: queue, icon: Network },
    { label: "API", value: config.api.toUpperCase(), icon: Network },
    { label: "Deploy", value: `${deploy} · ${config.region}`, icon: TrendingUp },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-white/[0.06] p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Stack summary</div>
            <div className="mt-0.5 text-sm font-semibold">{config.name}</div>
          </div>
          <Badge variant="success">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            valid
          </Badge>
        </div>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <div
              key={r.label}
              className="flex items-center justify-between px-4 py-2.5 text-xs"
            >
              <span className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {r.label}
              </span>
              <span className="font-medium">{r.value}</span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/[0.06] p-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 text-muted-foreground">
            <CircleDollarSign className="h-3.5 w-3.5" />
            Estimated monthly
          </span>
          <span className="font-semibold">${cost.toFixed(0)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Gauge className="h-3.5 w-3.5" />
            Est. p99 latency
          </span>
          <span className="font-semibold">~{40 + (config.replicas < 3 ? 10 : 0)}ms</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Compliance posture
          </span>
          <Badge variant="brand">SOC2 · GDPR</Badge>
        </div>
      </div>
    </Card>
  );
}

function estimateCost(replicas: number, autoscale: boolean, k8s: boolean) {
  const base = 38 * replicas;
  const scale = autoscale ? 1.1 : 1;
  const k = k8s ? 80 : 0;
  return base * scale + k + 42;
}

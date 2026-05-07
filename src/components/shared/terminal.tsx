"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type TerminalLine = {
  kind?: "prompt" | "out" | "ok" | "err" | "info";
  text: string;
};

export function Terminal({
  title = "helios › build.log",
  lines,
  className,
  animate = false,
}: {
  title?: string;
  lines: TerminalLine[];
  className?: string;
  animate?: boolean;
}) {
  const [visible, setVisible] = React.useState(animate ? 0 : lines.length);

  React.useEffect(() => {
    if (!animate) return;
    setVisible(0);
    const t = setInterval(() => {
      setVisible((v) => {
        if (v >= lines.length) {
          clearInterval(t);
          return v;
        }
        return v + 1;
      });
    }, 260);
    return () => clearInterval(t);
  }, [lines, animate]);

  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.06] bg-black/50 overflow-hidden card-ring font-mono text-[12px]",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        </div>
        <span className="text-[11px] text-muted-foreground">{title}</span>
        <span className="w-8" />
      </div>
      <div className="p-4 space-y-1.5 leading-relaxed max-h-[320px] overflow-auto">
        {lines.slice(0, visible).map((line, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-white/20 select-none">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span
              className={cn(
                line.kind === "prompt" && "text-brand-300",
                line.kind === "ok" && "text-emerald-300",
                line.kind === "err" && "text-red-300",
                line.kind === "info" && "text-purple-300",
                (!line.kind || line.kind === "out") && "text-white/80"
              )}
            >
              {line.kind === "prompt" ? "$ " : ""}
              {line.text}
            </span>
          </div>
        ))}
        {animate && visible < lines.length ? (
          <span className="inline-block h-3 w-1.5 bg-brand-400 animate-pulse" />
        ) : null}
      </div>
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-white/10 bg-white/[0.03] px-1.5 font-mono text-[10px] font-medium text-muted-foreground shadow-[inset_0_-1px_0_rgba(255,255,255,0.05)]",
        className
      )}
    >
      {children}
    </kbd>
  );
}

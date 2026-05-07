"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectableCardProps
  extends React.HTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
}

export const SelectableCard = React.forwardRef<
  HTMLButtonElement,
  SelectableCardProps
>(
  (
    { selected, label, description, icon, meta, badge, className, ...props },
    ref
  ) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "group relative w-full rounded-xl border p-4 text-left transition-all hover-raise",
        selected
          ? "border-brand-500/50 bg-brand-500/[0.06]"
          : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]",
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {icon ? (
            <div
              className={cn(
                "grid h-9 w-9 place-items-center rounded-lg border text-foreground/90",
                selected
                  ? "border-brand-500/30 bg-brand-500/[0.1]"
                  : "border-white/[0.06] bg-white/[0.02]"
              )}
            >
              {icon}
            </div>
          ) : null}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {label}
              </span>
              {badge}
            </div>
            {description ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {description}
              </p>
            ) : null}
            {meta ? (
              <div className="mt-2 flex flex-wrap gap-1.5">{meta}</div>
            ) : null}
          </div>
        </div>
        <div
          className={cn(
            "grid h-5 w-5 place-items-center rounded-full border transition-all",
            selected
              ? "border-brand-500/60 bg-brand-500 text-white"
              : "border-white/10 bg-transparent opacity-0 group-hover:opacity-100"
          )}
        >
          {selected ? <Check className="h-3 w-3" /> : null}
        </div>
      </div>
    </button>
  )
);
SelectableCard.displayName = "SelectableCard";

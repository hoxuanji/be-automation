"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Ctx = {
  open: boolean;
  setOpen: (v: boolean) => void;
};

const DropdownCtx = React.createContext<Ctx | null>(null);

export function Dropdown({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <DropdownCtx.Provider value={{ open, setOpen }}>
      <div ref={ref} className={cn("relative inline-block", className)}>
        {children}
      </div>
    </DropdownCtx.Provider>
  );
}

export function DropdownTrigger({
  children,
  asChild = true,
}: {
  children: React.ReactElement;
  asChild?: boolean;
}) {
  const ctx = React.useContext(DropdownCtx);
  if (!ctx) throw new Error("DropdownTrigger outside <Dropdown>");
  if (!asChild) {
    return (
      <button type="button" onClick={() => ctx.setOpen(!ctx.open)}>
        {children}
      </button>
    );
  }
  const el = children as React.ReactElement<{
    onClick?: (e: React.MouseEvent) => void;
  }>;
  return React.cloneElement(el, {
    onClick: (e: React.MouseEvent) => {
      el.props.onClick?.(e);
      ctx.setOpen(!ctx.open);
    },
  });
}

export function DropdownContent({
  children,
  align = "start",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const ctx = React.useContext(DropdownCtx);
  if (!ctx) throw new Error("DropdownContent outside <Dropdown>");
  if (!ctx.open) return null;
  return (
    <div
      role="menu"
      className={cn(
        "absolute top-full mt-1 z-50 min-w-[220px] rounded-lg border border-white/[0.08] bg-popover/95 p-1 shadow-xl backdrop-blur-md animate-in fade-in-0 zoom-in-95",
        align === "end" ? "right-0" : "left-0",
        className
      )}
    >
      {children}
    </div>
  );
}

export function DropdownItem({
  children,
  onSelect,
  className,
  disabled,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const ctx = React.useContext(DropdownCtx);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        ctx?.setOpen(false);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none",
        className
      )}
    >
      {children}
    </button>
  );
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/70">
      {children}
    </div>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-white/[0.06]" />;
}

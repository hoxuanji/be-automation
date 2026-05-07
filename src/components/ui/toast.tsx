"use client";

import * as React from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { Check, CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "info" | "error";
type Toast = {
  id: string;
  title: string;
  description?: string;
  kind: ToastKind;
};

type ToastState = {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "kind"> & { kind?: ToastKind }) => void;
  dismiss: (id: string) => void;
};

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Math.random().toString(36).slice(2, 8);
    const toast: Toast = { id, kind: t.kind ?? "info", title: t.title, description: t.description };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, 3200);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export function toast(t: Omit<Toast, "id" | "kind"> & { kind?: ToastKind }) {
  useToastStore.getState().push(t);
}

const kindClass: Record<ToastKind, string> = {
  success: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200",
  info: "border-brand-500/30 bg-brand-500/[0.06] text-brand-200",
  error: "border-red-500/30 bg-red-500/[0.08] text-red-200",
};

const kindIcon: Record<ToastKind, React.ComponentType<{ className?: string }>> = {
  success: Check,
  info: Info,
  error: CircleAlert,
};

export function Toaster() {
  const { toasts, dismiss } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = kindIcon[t.kind];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.18 }}
              className={cn(
                "pointer-events-auto flex min-w-[280px] max-w-[380px] items-start gap-3 rounded-lg border px-3 py-2.5 backdrop-blur-md shadow-xl",
                kindClass[t.kind]
              )}
            >
              <div className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/[0.08]">
                <Icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold">{t.title}</div>
                {t.description ? (
                  <div className="mt-0.5 text-[11px] opacity-80">
                    {t.description}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="opacity-60 hover:opacity-100 transition-opacity"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

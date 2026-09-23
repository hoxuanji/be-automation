"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit, X } from "lucide-react";
import { AIAssistant } from "./ai-assistant";

export function FloatingAI() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ duration: 0.16 }}
            className="fixed bottom-[88px] right-6 z-50 w-[360px] h-[520px] rounded-2xl border border-white/[0.08] bg-[#0a0a0f]/95 backdrop-blur-xl shadow-2xl shadow-black/60 overflow-hidden flex flex-col"
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-2.5 right-2.5 z-10 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
              aria-label="Close AI assistant"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <AIAssistant />
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95 ${
          open
            ? "bg-white/[0.08] border border-white/[0.12] shadow-black/40"
            : "bg-gradient-to-br from-brand-500 to-purple-600 shadow-brand-500/30"
        }`}
        aria-label="Toggle AI assistant"
      >
        {open ? (
          <X className="h-5 w-5 text-foreground" />
        ) : (
          <BrainCircuit className="h-5 w-5 text-white" />
        )}
      </button>
    </>
  );
}

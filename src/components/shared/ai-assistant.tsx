"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Send, Wand2, BrainCircuit, AlertCircle, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useStackStore } from "@/lib/store";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const suggestions = [
  "What are the bottlenecks in this stack at scale?",
  "Optimize cost for 100k DAU",
  "Suggest observability improvements",
  "What database fits event-sourced writes?",
];

const greeting: Message = {
  role: "assistant",
  content:
    "Hi — I can audit your stack, flag version conflicts and known issues, and explain trade-offs. Tap \"Audit stack\" for an instant review, or ask me anything.",
};

function buildAuditPrompt(config: ReturnType<typeof useStackStore.getState>["config"]): string {
  return `Audit this stack configuration and flag specific issues:
- Language: ${config.language} / ${config.framework}
- Database: ${config.database}
- Cache: ${config.cache}
- Queue: ${config.queue}
- Auth: ${config.auth}
- Deployment: ${config.deployment}
- API style: ${config.api}

Check for: (1) known version conflicts or incompatibilities between these choices, (2) licensing concerns, (3) security risks in this combination, (4) operational gotchas at production scale. Be specific — name the exact issues and why they matter.`;
}

export function AIAssistant({ className }: { className?: string }) {
  const { config, endpoints, entities } = useStackStore();
  const [messages, setMessages] = React.useState<Message[]>([greeting]);
  const [input, setInput] = React.useState("");
  const [thinking, setThinking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, thinking]);

  async function send(text: string) {
    if (!text.trim() || thinking) return;

    const prior = messages;
    const history: Message[] = [...prior, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setThinking(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // Anthropic requires the conversation to start with a user message, so drop
    // any leading assistant turns (e.g. the seeded greeting) before sending.
    const firstUser = history.findIndex((m) => m.role === "user");
    const apiMessages = history
      .slice(firstUser === -1 ? 0 : firstUser)
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          config,
          endpoints,
          entities,
        }),
        signal: controller.signal,
      });

      if (res.status === 503) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail ?? "Assistant is not configured.");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }

      if (!res.ok || !res.body) {
        setError(`Request failed (${res.status})`);
        setMessages((prev) => prev.slice(0, -1));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseSSE(raw);
          if (!event) continue;

          const data =
            typeof event.data === "object" && event.data !== null
              ? (event.data as { text?: string; message?: string })
              : {};

          if (event.event === "text" && typeof data.text === "string") {
            const chunk = data.text;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  content: last.content + chunk,
                };
              }
              return next;
            });
          } else if (event.event === "error") {
            setError(data.message ?? "Stream error");
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      setThinking(false);
      abortRef.current = null;
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <div className="absolute inset-0 rounded-md bg-brand-500/30 blur-md" />
            <div className="relative grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
              <BrainCircuit className="h-3.5 w-3.5 text-white" />
            </div>
          </div>
          <div className="leading-tight">
            <div className="text-xs font-semibold">Helios AI</div>
            <div className="text-[10px] text-muted-foreground">
              Stack copilot · claude-sonnet-4-6
            </div>
          </div>
        </div>
        <Badge variant="purple">
          <Sparkles className="h-2.5 w-2.5" />
          live
        </Badge>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        <AnimatePresence initial={false}>
          {messages.map((m, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn("flex gap-2", m.role === "user" && "justify-end")}
            >
              {m.role === "assistant" ? (
                <div className="mt-0.5 h-6 w-6 shrink-0 rounded-md bg-gradient-to-br from-brand-400 to-purple-500 grid place-items-center">
                  <Sparkles className="h-3 w-3 text-white" />
                </div>
              ) : null}
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap",
                  m.role === "assistant"
                    ? "bg-white/[0.03] border border-white/[0.06]"
                    : "bg-brand-500/15 border border-brand-500/20 text-foreground"
                )}
              >
                {m.content || (
                  <span className="inline-flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-white/40 animate-bounce"
                        style={{ animationDelay: `${i * 0.12}s` }}
                      />
                    ))}
                  </span>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-2.5 text-[11px] text-amber-200">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">Assistant unavailable</div>
              <div className="text-amber-300/80">{error}</div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="px-4 pb-2">
        <button
          disabled={thinking}
          onClick={() => send(buildAuditPrompt(config))}
          className="mb-2 w-full flex items-center justify-center gap-1.5 rounded-lg border border-brand-500/30 bg-brand-500/10 px-3 py-1.5 text-[11px] font-medium text-brand-300 hover:bg-brand-500/15 transition-colors disabled:opacity-50"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Audit this stack
        </button>
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              disabled={thinking}
              onClick={() => send(s)}
              className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="m-3 mt-0 flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-1.5 focus-within:border-brand-500/40 transition-colors"
      >
        <Wand2 className="h-3.5 w-3.5 text-muted-foreground ml-1" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={thinking}
          placeholder="Ask to optimize your stack…"
          className="flex-1 bg-transparent px-1.5 py-1 text-xs placeholder:text-muted-foreground/70 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={thinking || !input.trim()}
          className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-brand-500 to-purple-500 text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          aria-label="Send"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}

function parseSSE(raw: string): { event: string; data: Record<string, unknown> | string } | null {
  let event = "message";
  let dataRaw = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
  }
  if (!dataRaw) return null;
  try {
    return { event, data: JSON.parse(dataRaw) as Record<string, unknown> };
  } catch {
    return { event, data: dataRaw };
  }
}

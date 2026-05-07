"use client";

import * as React from "react";
import { Wand2, Loader2, Sparkles, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useStackStore, type Entity, type Endpoint, type StackConfig } from "@/lib/store";
import { toast } from "@/components/ui/toast";

type SuggestResult = {
  config: Partial<StackConfig>;
  entities: Entity[];
  endpoints: Endpoint[];
  explanation: string;
};

const EXAMPLES = [
  "Realtime chat app with user profiles and message history",
  "E-commerce API with products, orders, inventory, and payments",
  "Multi-tenant SaaS with workspaces, users, and Stripe billing",
  "IoT platform for device telemetry ingestion and alerting",
];

export function NLPrompt() {
  const { patch, setEntities, setEndpoints } = useStackStore();
  const [prompt, setPrompt] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<SuggestResult | null>(null);
  const [showDetail, setShowDetail] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  async function suggest() {
    const text = prompt.trim();
    if (!text || loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (res.status === 503) {
        toast({
          title: "AI not configured",
          description: data.detail ?? "Add ANTHROPIC_API_KEY to .env.local",
          kind: "info",
        });
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data as SuggestResult);
    } catch (err) {
      toast({ title: "Suggestion failed", description: (err as Error).message, kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!result) return;
    patch(result.config);
    if (result.entities?.length) setEntities(result.entities);
    if (result.endpoints?.length) setEndpoints(result.endpoints);
    toast({
      title: "Stack configured",
      description: result.explanation?.slice(0, 100) + (result.explanation?.length > 100 ? "…" : ""),
      kind: "success",
    });
    setResult(null);
    setPrompt("");
  }

  return (
    <div className="rounded-xl border border-brand-500/20 bg-brand-500/[0.04] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand-400 to-purple-500">
          <Wand2 className="h-3.5 w-3.5 text-white" />
        </div>
        <span className="text-sm font-semibold">Describe your project</span>
        <Badge variant="brand">
          <Sparkles className="h-2.5 w-2.5" /> AI
        </Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Claude picks your stack + data models + endpoints
        </span>
      </div>

      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              suggest();
            }
          }}
          rows={2}
          placeholder="e.g. Realtime chat app with user auth, message history, and file uploads…"
          className="flex-1 resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:border-brand-500/40 transition-colors"
          disabled={loading}
        />
        <Button
          variant="glow"
          size="sm"
          onClick={suggest}
          disabled={loading || !prompt.trim()}
          className="shrink-0"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {loading ? "Thinking…" : "Suggest"}
        </Button>
      </div>

      {!result && !loading && (
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setPrompt(ex);
                textareaRef.current?.focus();
              }}
              className="rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="brand">
                {result.config.language} · {result.config.framework}
              </Badge>
              {result.config.database && (
                <Badge variant="outline">{result.config.database}</Badge>
              )}
              {result.config.cache && result.config.cache !== "none" && (
                <Badge variant="outline">{result.config.cache}</Badge>
              )}
              {result.entities?.length > 0 && (
                <Badge variant="purple">
                  {result.entities.length} model{result.entities.length !== 1 ? "s" : ""}
                </Badge>
              )}
              {result.endpoints?.length > 0 && (
                <Badge variant="outline">
                  {result.endpoints.length} endpoint{result.endpoints.length !== 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <button
              onClick={() => setShowDetail((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showDetail ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showDetail ? "Less" : "Details"}
            </button>
          </div>

          {showDetail && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {result.explanation}
            </p>
          )}

          {showDetail && result.entities?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Data models</div>
              {result.entities.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 rounded-md border border-white/[0.04] bg-white/[0.02] px-2.5 py-1.5"
                >
                  <span className="text-xs font-mono font-medium">{e.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {e.fields.map((f) => f.name).join(", ")}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button variant="glow" size="sm" onClick={apply}>
              <Check className="h-3.5 w-3.5" /> Apply to stack
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setResult(null)}>
              <X className="h-3.5 w-3.5" /> Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

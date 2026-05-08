"use client";

import * as React from "react";
import { ArrowUpRight, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { ArchitectureProposal } from "@/lib/architect-schema";

/**
 * Publishes the given architecture proposal to a public /show/<slug> page.
 * Copies the URL to clipboard and toasts a "View" link.
 */
export function PublishButton({
  proposal,
  intent,
  variant = "secondary",
  size = "sm",
  label = "Share",
}: {
  proposal: ArchitectureProposal | null;
  intent: string;
  variant?: "secondary" | "glow" | "ghost";
  size?: "sm" | "lg";
  label?: string;
}) {
  const [busy, setBusy] = React.useState(false);

  async function publish() {
    if (!proposal) {
      toast({
        title: "Nothing to publish yet",
        description: "Generate an architecture first.",
        kind: "info",
      });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, proposal }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const { url } = (await res.json()) as { slug: string; url: string };
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /* clipboard may be blocked; still surface the URL via toast */
      }
      toast({
        title: "Architecture published",
        description: url,
        kind: "success",
      });
      // open in new tab
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({
        title: "Publish failed",
        description: (err as Error).message,
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      onClick={publish}
      disabled={busy || !proposal}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Share2 className="h-3.5 w-3.5" />
      )}
      {label}
      {!busy && proposal ? (
        <ArrowUpRight className="h-3 w-3 opacity-70" />
      ) : null}
    </Button>
  );
}

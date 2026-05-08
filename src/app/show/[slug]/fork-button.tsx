"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GitFork, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import type { ArchitectureProposal } from "@/lib/architect-schema";

export function ForkButton({
  slug,
  proposal,
  variant = "glow",
}: {
  slug: string;
  proposal: ArchitectureProposal;
  variant?: "glow" | "secondary";
}) {
  const router = useRouter();
  const { applyProposal } = useStackStore();
  const [busy, setBusy] = React.useState(false);

  async function fork() {
    setBusy(true);
    try {
      // best-effort fork count bump; we don't block on it
      fetch(`/api/share?action=fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).catch(() => {});
      applyProposal(proposal.config);
      toast({
        title: "Forked into your workspace",
        description: `${proposal.config.name} loaded into the Builder.`,
        kind: "success",
      });
      router.push("/builder");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button onClick={fork} variant={variant} size="lg" disabled={busy}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <GitFork className="h-4 w-4" />
      )}
      Fork to my workspace
    </Button>
  );
}

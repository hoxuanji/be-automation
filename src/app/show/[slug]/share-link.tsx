"use client";

import * as React from "react";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

export function ShareLink({ slug }: { slug: string }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/show/${slug}`
        : `/show/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast({ title: "Share link copied", description: url, kind: "success" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={copy}>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-300" />
      ) : (
        <Link2 className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Share"}
    </Button>
  );
}

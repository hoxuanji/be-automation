"use client";

import Link from "next/link";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6 text-center p-6">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-30" />
      </div>
      <Logo />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          An unexpected error occurred.
          {error.digest ? ` (ref: ${error.digest})` : ""}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}

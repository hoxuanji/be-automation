"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Mail } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const email = new FormData(e.currentTarget).get("email") as string;
    try {
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      toast({ title: "Something went wrong", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold">Forgot your password?</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter your email and we&apos;ll send a reset link.
          </p>
        </div>
      </div>

      {sent ? (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-5 text-center space-y-2">
          <Mail className="h-6 w-6 mx-auto text-emerald-400" />
          <p className="text-sm font-medium">Check your inbox</p>
          <p className="text-xs text-muted-foreground">
            If that email is registered, a reset link is on its way.
            {" (If no email provider is configured, the link is logged to the server console.)"}
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Email address</label>
            <Input name="email" type="email" required placeholder="you@example.com" autoFocus />
          </div>
          <Button type="submit" variant="glow" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Remember it?{" "}
        <Link href="/login" className="text-brand-300 hover:text-brand-200">
          Sign in
        </Link>
      </p>
    </div>
  );
}

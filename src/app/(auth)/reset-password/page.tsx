"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

function ResetForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const [loading, setLoading] = React.useState(false);
  const [done, setDone] = React.useState(false);

  if (!token) {
    return (
      <div className="text-center space-y-3">
        <XCircle className="h-8 w-8 mx-auto text-red-400" />
        <p className="text-sm text-muted-foreground">Invalid or missing reset token.</p>
        <Button asChild variant="secondary" size="sm">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = fd.get("password") as string;
    const confirm = fd.get("confirm") as string;
    if (password !== confirm) {
      toast({ title: "Passwords don't match", kind: "error" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const d = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        const msg = d.error === "token_expired" ? "This link has expired. Request a new one." : d.error === "token_used" ? "This link has already been used." : "Invalid reset link.";
        toast({ title: msg, kind: "error" });
      } else {
        setDone(true);
        setTimeout(() => router.push("/login"), 2500);
      }
    } catch {
      toast({ title: "Something went wrong", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="text-center space-y-3">
        <CheckCircle className="h-8 w-8 mx-auto text-emerald-400" />
        <p className="text-sm font-medium">Password updated!</p>
        <p className="text-xs text-muted-foreground">Redirecting you to sign in…</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">New password</label>
        <Input name="password" type="password" required minLength={8} placeholder="8+ characters" autoFocus />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Confirm password</label>
        <Input name="confirm" type="password" required minLength={8} placeholder="Repeat password" />
      </div>
      <Button type="submit" variant="glow" className="w-full" disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {loading ? "Updating…" : "Set new password"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo />
        <div>
          <h1 className="text-xl font-semibold">Set a new password</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Choose something strong you haven&apos;t used before.
          </p>
        </div>
      </div>
      <React.Suspense fallback={null}>
        <ResetForm />
      </React.Suspense>
      <p className="text-center text-xs text-muted-foreground">
        <Link href="/forgot-password" className="text-brand-300 hover:text-brand-200">
          Request a new link
        </Link>
      </p>
    </div>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Github } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";

function OAuthResultHandler() {
  const searchParams = useSearchParams();

  React.useEffect(() => {
    if (searchParams.get("github") === "error") {
      toast({ title: "GitHub sign-in failed", description: "Please try again.", kind: "error" });
      window.history.replaceState({}, "", "/login");
    }
  }, [searchParams]);

  return null;
}

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: fd.get("email"),
          password: fd.get("password"),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title:
            data.error === "invalid_credentials"
              ? "Invalid email or password"
              : "Sign-in failed",
          kind: "error",
        });
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      toast({ title: "Network error", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <React.Suspense fallback={null}><OAuthResultHandler /></React.Suspense>
      <div className="text-center">
        <div className="flex justify-center mb-5">
          <Logo />
        </div>
        <h1 className="text-xl font-semibold">Welcome back</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Sign in to your Helios account
        </p>
      </div>

      {/* GitHub OAuth */}
      <a
        href="/api/auth/github?mode=login"
        className="flex items-center justify-center gap-2.5 w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.07] transition-colors"
      >
        <Github className="h-4 w-4" />
        Continue with GitHub
      </a>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/[0.06]" />
        <span className="text-[11px] text-muted-foreground">or</span>
        <div className="h-px flex-1 bg-white/[0.06]" />
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Email
            </label>
            <Input
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Password
            </label>
            <Input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          <Button
            type="submit"
            variant="glow"
            className="w-full"
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="text-brand-300 hover:underline">
          Create one
        </Link>
      </p>
    </div>
  );
}

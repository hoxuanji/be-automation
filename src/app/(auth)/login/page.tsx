"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Github } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { BrandIcon } from "@/components/shared/brand-icon";
import { toast } from "@/components/ui/toast";

function OAuthResultHandler() {
  const searchParams = useSearchParams();

  React.useEffect(() => {
    if (searchParams.get("github") === "error") {
      toast({ title: "GitHub sign-in failed", description: "Please try again.", kind: "error" });
      window.history.replaceState({}, "", "/login");
    } else if (searchParams.get("bitbucket") === "error") {
      toast({ title: "Bitbucket sign-in failed", description: "Please try again.", kind: "error" });
      window.history.replaceState({}, "", "/login");
    }
  }, [searchParams]);

  return null;
}

function LoginForm() {
  const searchParams = useSearchParams();
  // Keep returnTo on the SSO flow so the callback redirects back where the
  // user started. We only honor in-app paths for safety.
  const rt = searchParams.get("returnTo");
  const returnTo = rt && rt.startsWith("/") ? rt : "/dashboard";
  const githubHref = `/api/auth/github?mode=login&returnTo=${encodeURIComponent(returnTo)}`;
  const bitbucketHref = `/api/auth/bitbucket?mode=login&returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="flex justify-center mb-5">
          <Logo />
        </div>
        <h1 className="text-xl font-semibold">Sign in to Helios</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Continue with your GitHub or Bitbucket account
        </p>
      </div>

      <div className="space-y-3">
        <a
          href={githubHref}
          className="flex items-center justify-center gap-2.5 w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.07] transition-colors"
        >
          <Github className="h-4 w-4" />
          Continue with GitHub
        </a>

        <a
          href={bitbucketHref}
          className="flex items-center justify-center gap-2.5 w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-medium hover:bg-white/[0.07] transition-colors"
        >
          <BrandIcon id="bitbucket" size={16} rounded="sm" />
          Continue with Bitbucket
        </a>
      </div>

      <p className="text-center text-[11px] text-muted-foreground/80 leading-relaxed">
        Helios is SSO-only. Signing in with either provider creates your account
        on first use — no password, no reset flow.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <OAuthResultHandler />
      <LoginForm />
    </React.Suspense>
  );
}

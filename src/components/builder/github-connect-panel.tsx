"use client";

import React from "react";
import { Check, Github } from "lucide-react";
import { Button } from "@/components/ui/button";

type GitHubStatus =
  | { connected: false }
  | { connected: true; login: string; avatar: string };

export function GitHubConnectPanel() {
  const [status, setStatus] = React.useState<GitHubStatus | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/github/status")
      .then((r) => r.json())
      .then((data: GitHubStatus) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Github className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">GitHub Connection</span>
      </div>

      {status === null ? (
        <p className="text-xs text-muted-foreground">Checking GitHub…</p>
      ) : status.connected ? (
        <div className="flex items-center gap-2">
          <div className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 border border-emerald-500/30">
            <Check className="h-3 w-3 text-emerald-400" />
          </div>
          <img
            src={status.avatar}
            alt={status.login}
            className="w-5 h-5 rounded-full"
          />
          <span className="text-xs text-muted-foreground">
            Connected as{" "}
            <span className="font-medium text-foreground">@{status.login}</span>
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground flex-1">
            Connect your GitHub account to push generated workflows directly to
            your repository.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              window.location.href =
                "/api/auth/github?mode=connect&returnTo=/builder";
            }}
          >
            <Github className="h-3.5 w-3.5" />
            Connect GitHub
          </Button>
        </div>
      )}
    </div>
  );
}

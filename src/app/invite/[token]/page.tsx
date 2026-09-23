"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { Loader2, Users, CheckCircle, XCircle } from "lucide-react";
import { Logo } from "@/components/shared/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";

type InviteInfo = { teamId: string; teamName: string; expiresAt: number };
type State =
  | { phase: "loading" }
  | { phase: "ready"; info: InviteInfo }
  | { phase: "invalid"; reason: string }
  | { phase: "done"; teamId: string };

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { authUser } = useStackStore();
  const [state, setState] = React.useState<State>({ phase: "loading" });
  const [accepting, setAccepting] = React.useState(false);

  React.useEffect(() => {
    fetch(`/api/invites/${token}`)
      .then(async (r) => {
        const d = await r.json() as { teamId?: string; teamName?: string; expiresAt?: number; error?: string };
        if (!r.ok) {
          setState({ phase: "invalid", reason: d.error === "expired" ? "This invite link has expired." : d.error === "used" ? "This invite has already been used." : "Invalid invite link." });
        } else {
          setState({ phase: "ready", info: { teamId: d.teamId!, teamName: d.teamName!, expiresAt: d.expiresAt! } });
        }
      })
      .catch(() => setState({ phase: "invalid", reason: "Could not load invite." }));
  }, [token]);

  async function accept() {
    if (!authUser) {
      router.push(`/login?returnTo=/invite/${token}`);
      return;
    }
    setAccepting(true);
    try {
      const res = await fetch(`/api/invites/${token}`, { method: "POST" });
      const d = await res.json() as { teamId?: string; error?: string };
      if (!res.ok) {
        toast({ title: "Failed to join team", description: d.error, kind: "error" });
      } else {
        setState({ phase: "done", teamId: d.teamId! });
      }
    } catch {
      toast({ title: "Network error", kind: "error" });
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="absolute inset-0 -z-10">
        <div className="absolute inset-0 grid-bg mask-radial opacity-40" />
        <div className="absolute -top-40 left-1/2 h-[400px] w-[900px] -translate-x-1/2 aurora animate-aurora opacity-60" />
      </div>

      <div className="mb-8">
        <Logo />
      </div>

      <Card className="w-full max-w-md glass-strong">
        <CardContent className="p-8 text-center space-y-5">
          {state.phase === "loading" && (
            <>
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading invite…</p>
            </>
          )}

          {state.phase === "invalid" && (
            <>
              <XCircle className="h-10 w-10 mx-auto text-red-400" />
              <div>
                <p className="font-semibold">Invite unavailable</p>
                <p className="text-sm text-muted-foreground mt-1">{state.reason}</p>
              </div>
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard">Go to dashboard</Link>
              </Button>
            </>
          )}

          {state.phase === "ready" && (
            <>
              <div className="grid h-14 w-14 place-items-center rounded-2xl border border-brand-500/30 bg-brand-500/10 mx-auto">
                <Users className="h-6 w-6 text-brand-300" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">You&apos;ve been invited to join</p>
                <p className="text-2xl font-semibold mt-1">{state.info.teamName}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Expires {new Date(state.info.expiresAt * 1000).toLocaleDateString()}
                </p>
              </div>
              {authUser ? (
                <Button variant="glow" onClick={accept} disabled={accepting} className="w-full">
                  {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {accepting ? "Joining…" : `Join as ${authUser.name}`}
                </Button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Sign in to accept this invite</p>
                  <Button variant="glow" onClick={accept} className="w-full">
                    Sign in to join
                  </Button>
                </div>
              )}
            </>
          )}

          {state.phase === "done" && (
            <>
              <CheckCircle className="h-10 w-10 mx-auto text-emerald-400" />
              <div>
                <p className="font-semibold">You&apos;re in!</p>
                <p className="text-sm text-muted-foreground mt-1">You&apos;ve joined the team.</p>
              </div>
              <Button asChild variant="glow" className="w-full">
                <Link href="/settings">View team</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

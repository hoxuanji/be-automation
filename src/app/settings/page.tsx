"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Eye, EyeOff, FolderOpen, Github, Key, Link2, Loader2, Lock, Plus, Shield, Trash2, User, Users, X } from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import { BrandIcon } from "@/components/shared/brand-icon";

export default function SettingsPage() {
  const { authUser, loadAuth } = useStackStore();
  const [nameVal, setNameVal] = React.useState(authUser?.name ?? "");
  const [emailVal, setEmailVal] = React.useState(authUser?.email ?? "");
  const [showKey, setShowKey] = React.useState(false);
  const [profileSaving, setProfileSaving] = React.useState(false);
  const [pwSaving, setPwSaving] = React.useState(false);
  const [keySaving, setKeySaving] = React.useState(false);

  React.useEffect(() => {
    if (authUser) {
      setNameVal(authUser.name);
      setEmailVal(authUser.email);
    }
  }, [authUser]);

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProfileSaving(true);
    try {
      const res = await fetch("/api/auth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameVal, email: emailVal }),
      });
      if (!res.ok) throw new Error();
      await loadAuth();
      toast({ title: "Profile updated", kind: "success" });
    } catch {
      toast({ title: "Failed to update profile", kind: "error" });
    } finally {
      setProfileSaving(false);
    }
  }

  async function savePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwSaving(true);
    const fd = new FormData(e.currentTarget);
    const password = fd.get("password") as string;
    const confirm = fd.get("confirm") as string;
    if (password !== confirm) {
      toast({ title: "Passwords don't match", kind: "error" });
      setPwSaving(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error();
      toast({ title: "Password updated", kind: "success" });
      (e.target as HTMLFormElement).reset();
    } catch {
      toast({ title: "Failed to update password", kind: "error" });
    } finally {
      setPwSaving(false);
    }
  }

  async function saveApiKey(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setKeySaving(true);
    const fd = new FormData(e.currentTarget);
    const apiKey = (fd.get("apiKey") as string).trim() || null;
    try {
      const res = await fetch("/api/auth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) throw new Error();
      await loadAuth();
      toast({ title: apiKey ? "API key saved" : "API key removed", kind: "success" });
      (e.target as HTMLFormElement).reset();
    } catch {
      toast({ title: "Failed to save API key", kind: "error" });
    } finally {
      setKeySaving(false);
    }
  }

  async function removeApiKey() {
    setKeySaving(true);
    try {
      await fetch("/api/auth/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: null }),
      });
      await loadAuth();
      toast({ title: "API key removed", kind: "success" });
    } catch {
      toast({ title: "Failed to remove key", kind: "error" });
    } finally {
      setKeySaving(false);
    }
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
      ]}
    >
      <div className="mx-auto max-w-2xl p-6 md:p-8 space-y-8">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your account, integrations, and AI configuration.
          </p>
        </div>

        {/* Profile */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4" /> Profile
            </CardTitle>
            <CardDescription>Update your name and email address.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Name
                </label>
                <Input
                  value={nameVal}
                  onChange={(e) => setNameVal(e.target.value)}
                  required
                  minLength={2}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Email
                </label>
                <Input
                  type="email"
                  value={emailVal}
                  onChange={(e) => setEmailVal(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={profileSaving}
              >
                {profileSaving ? "Saving…" : "Save profile"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Password */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4" /> Password
            </CardTitle>
            <CardDescription>Choose a new password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={savePassword} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  New password
                </label>
                <Input
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder="8+ characters"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Confirm password
                </label>
                <Input
                  name="confirm"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="Repeat password"
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                disabled={pwSaving}
              >
                {pwSaving ? "Saving…" : "Change password"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Team */}
        <TeamCard />

        {/* Integrations */}
        <IntegrationsCard />

        {/* Danger zone */}
        <DangerZoneCard />

        {/* BYOK */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-4 w-4" /> AI API Key
              {authUser?.hasApiKey && (
                <Badge variant="brand" className="ml-1">
                  Active
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Bring your own Anthropic key. It&apos;s stored encrypted and used
              only for your AI requests — your key takes priority over the
              shared server key.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveApiKey} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Anthropic API key
                </label>
                <div className="relative">
                  <Input
                    name="apiKey"
                    type={showKey ? "text" : "password"}
                    placeholder={
                      authUser?.hasApiKey
                        ? "Key is set — paste a new one to replace"
                        : "sk-ant-api03-…"
                    }
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  disabled={keySaving}
                >
                  {keySaving
                    ? "Saving…"
                    : authUser?.hasApiKey
                    ? "Update key"
                    : "Save key"}
                </Button>
                {authUser?.hasApiKey && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-red-400 hover:text-red-300"
                    disabled={keySaving}
                    onClick={removeApiKey}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </WorkspaceShell>
  );
}

// ─── Team card ────────────────────────────────────────────────────────────────

type TeamData = { id: string; name: string; role: string; memberCount: number };
type Member = { user_id: string; name: string; email: string; role: string };

function TeamCard() {
  const [teams, setTeams] = React.useState<TeamData[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [newTeamName, setNewTeamName] = React.useState("");
  const [showCreate, setShowCreate] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [members, setMembers] = React.useState<Record<string, Member[]>>({});
  const [inviting, setInviting] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const { authUser } = useStackStore();

  React.useEffect(() => {
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d: { teams?: TeamData[] }) => setTeams(d.teams ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function createTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await res.json() as { team?: TeamData; error?: string };
      if (!res.ok || !d.team) {
        toast({ title: d.error ?? "Failed to create team", kind: "error" });
      } else {
        setTeams((prev) => [d.team!, ...prev]);
        setNewTeamName("");
        setShowCreate(false);
        toast({ title: `Team "${d.team.name}" created`, kind: "success" });
      }
    } catch {
      toast({ title: "Network error", kind: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function loadMembers(teamId: string) {
    if (members[teamId]) return;
    try {
      const res = await fetch(`/api/teams/${teamId}`);
      const d = await res.json() as { members?: Member[] };
      setMembers((prev) => ({ ...prev, [teamId]: d.members ?? [] }));
    } catch {
      toast({ title: "Failed to load members", kind: "error" });
    }
  }

  function toggleExpand(teamId: string) {
    if (expanded === teamId) {
      setExpanded(null);
    } else {
      setExpanded(teamId);
      void loadMembers(teamId);
    }
  }

  async function copyInviteLink(teamId: string) {
    setInviting(teamId);
    try {
      const res = await fetch(`/api/teams/${teamId}/invite`, { method: "POST" });
      const d = await res.json() as { url?: string; error?: string };
      if (!res.ok || !d.url) {
        toast({ title: d.error ?? "Failed to create invite", kind: "error" });
      } else {
        await navigator.clipboard.writeText(d.url);
        toast({ title: "Invite link copied!", description: "Valid for 7 days. Share it with your teammate.", kind: "success" });
      }
    } catch {
      toast({ title: "Failed to create invite link", kind: "error" });
    } finally {
      setInviting(null);
    }
  }

  async function removeMember(teamId: string, userId: string) {
    setRemoving(userId);
    try {
      const res = await fetch(`/api/teams/${teamId}/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? "Failed to remove member", kind: "error" });
      } else {
        setMembers((prev) => ({ ...prev, [teamId]: (prev[teamId] ?? []).filter((m) => m.user_id !== userId) }));
        setTeams((prev) => prev.map((t) => t.id === teamId ? { ...t, memberCount: t.memberCount - 1 } : t));
        toast({ title: "Member removed", kind: "success" });
      }
    } catch {
      toast({ title: "Network error", kind: "error" });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> Team
          </CardTitle>
          {!showCreate && (
            <Button variant="secondary" size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5" /> New team
            </Button>
          )}
        </div>
        <CardDescription>
          Create a team, invite members via a shareable link, and collaborate on shared stacks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showCreate && (
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="Team name"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createTeam(); if (e.key === "Escape") { setShowCreate(false); setNewTeamName(""); } }}
              maxLength={64}
            />
            <Button variant="secondary" size="sm" onClick={() => void createTeam()} disabled={creating || !newTeamName.trim()}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setShowCreate(false); setNewTeamName(""); }}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : teams.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            You&apos;re not in any teams yet. Create one or ask a teammate to share an invite link.
          </p>
        ) : (
          <div className="space-y-2">
            {teams.map((team) => (
              <div key={team.id} className="rounded-lg border border-white/[0.06] overflow-hidden">
                <button
                  onClick={() => toggleExpand(team.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500/10 border border-brand-500/20">
                      <Users className="h-3.5 w-3.5 text-brand-300" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{team.name}</div>
                      <div className="text-xs text-muted-foreground">{team.memberCount} member{team.memberCount !== 1 ? "s" : ""} · {team.role}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs px-2.5"
                      disabled={inviting === team.id}
                      onClick={(e) => { e.stopPropagation(); void copyInviteLink(team.id); }}
                    >
                      {inviting === team.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
                      Invite
                    </Button>
                    {expanded === team.id ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                </button>

                {expanded === team.id && (
                  <div className="border-t border-white/[0.04] bg-white/[0.01]">
                    <div className="px-4 py-3 space-y-2">
                      <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-2">Members</p>
                      {(members[team.id] ?? []).map((m) => (
                        <div key={m.user_id} className="flex items-center justify-between">
                          <div>
                            <span className="text-xs font-medium">{m.name}</span>
                            <span className="text-xs text-muted-foreground ml-2">{m.email}</span>
                            {m.role === "owner" && <span className="ml-2 text-[10px] text-brand-300 border border-brand-500/30 rounded-full px-1.5 py-0.5">owner</span>}
                          </div>
                          {m.role !== "owner" && (team.role === "owner" || m.user_id === authUser?.id) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs text-muted-foreground hover:text-red-300 px-2"
                              disabled={removing === m.user_id}
                              onClick={() => void removeMember(team.id, m.user_id)}
                            >
                              {removing === m.user_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                              {m.user_id === authUser?.id ? "Leave" : "Remove"}
                            </Button>
                          )}
                        </div>
                      ))}
                      {(members[team.id] ?? []).length === 0 && (
                        <p className="text-xs text-muted-foreground">Loading members…</p>
                      )}
                    </div>
                    <div className="border-t border-white/[0.04]">
                      <TeamProjectsSection teamId={team.id} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Integrations card ────────────────────────────────────────────────────────

type GhStatus =
  | { connected: false }
  | { connected: true; login: string; avatar: string };

function IntegrationsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" /> Integrations
        </CardTitle>
        <CardDescription>
          Connected accounts used for pushing code and deploying.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <GitHubIntegrationRow />
        <div className="border-t border-white/[0.04]" />
        <RailwayIntegrationRow />
      </CardContent>
    </Card>
  );
}

function GitHubIntegrationRow() {
  const [status, setStatus] = React.useState<GhStatus | null>(null);
  const [disconnecting, setDisconnecting] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth/github/status")
      .then((r) => r.json())
      .then((d) => setStatus(d as GhStatus))
      .catch(() => setStatus({ connected: false }));
  }, []);

  async function disconnect() {
    setDisconnecting(true);
    try {
      await fetch("/api/auth/github/status", { method: "DELETE" });
      setStatus({ connected: false });
      toast({ title: "GitHub push access removed", kind: "info" });
    } catch {
      toast({ title: "Failed to disconnect", kind: "error" });
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
          <Github className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-medium">GitHub</div>
          <div className="text-xs text-muted-foreground">
            {status === null ? (
              "Checking…"
            ) : status.connected ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                @{status.login}
              </span>
            ) : (
              "Not connected"
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0">
        {status === null ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : status.connected ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-red-300"
            disabled={disconnecting}
            onClick={() => void disconnect()}
          >
            {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect"}
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            <a href="/api/auth/github?mode=connect&returnTo=/settings">
              Connect
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function RailwayIntegrationRow() {
  const [maskedToken, setMaskedToken] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [expanded, setExpanded] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; hint?: string } | null>(null);
  const [verifiedEmail, setVerifiedEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/deploy/credentials")
      .then((r) => r.json())
      .then((d: { creds?: { railway?: { token?: string } } }) => {
        setMaskedToken(d.creds?.railway?.token ?? null);
      })
      .catch(() => setMaskedToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function saveToken() {
    const t = token.trim();
    if (!t) { setError({ message: "Token required" }); return; }
    setSaving(true);
    setError(null);
    try {
      const vRes = await fetch("/api/railway/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const vData = await vRes.json() as { email?: string; error?: string; hint?: string };
      if (!vRes.ok) {
        setError({ message: vData.error ?? "Invalid token", hint: vData.hint });
        return;
      }
      setVerifiedEmail(vData.email ?? null);
      await fetch("/api/deploy/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "railway", fields: { token: t } }),
      });
      setMaskedToken(`••••${t.slice(-4)}`);
      setToken("");
      setExpanded(false);
      toast({ title: "Railway token saved", kind: "success" });
    } catch {
      setError({ message: "Request failed", hint: "Check your network and try again." });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await fetch("/api/deploy/credentials?provider=railway", { method: "DELETE" });
    setMaskedToken(null);
    setVerifiedEmail(null);
    toast({ title: "Railway token removed", kind: "info" });
  }

  const hasToken = !!maskedToken;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.03]">
            <BrandIcon id="railway" size={20} />
          </div>
          <div>
            <div className="text-sm font-medium">Railway</div>
            <div className="text-xs text-muted-foreground">
              {loading ? (
                "Checking…"
              ) : hasToken ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {verifiedEmail ?? maskedToken}
                </span>
              ) : (
                "No token saved"
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : hasToken ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setExpanded((v) => !v); setError(null); }}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-red-300"
                onClick={() => void remove()}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setExpanded(true); setError(null); }}
            >
              Add token
            </Button>
          )}
        </div>
      </div>

      {/* Inline token form — shown when adding or replacing */}
      {expanded && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <label className="text-xs text-muted-foreground">
              Personal API Token from{" "}
              <a
                href="https://railway.app/account/tokens"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                railway.app/account/tokens
              </a>
            </label>
            <Badge variant="purple"><Shield className="h-2.5 w-2.5" /> encrypted</Badge>
          </div>
          <Input
            type="password"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={token}
            onChange={(e) => { setToken(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void saveToken(); }}
            autoFocus
          />
          {error && (
            <div className="rounded-md border border-red-500/20 bg-red-500/[0.04] px-2.5 py-2 text-xs text-red-300">
              <div className="font-medium">{error.message}</div>
              {error.hint && <div className="mt-0.5 text-red-300/70">{error.hint}</div>}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void saveToken()}
              disabled={saving || !token.trim()}
            >
              {saving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying…</>
                : <><Check className="h-3.5 w-3.5" /> Verify &amp; save</>
              }
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setExpanded(false); setToken(""); setError(null); }}
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Danger zone ──────────────────────────────────────────────────────────────

function DangerZoneCard() {
  const { logout } = useStackStore();
  const [confirming, setConfirming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  async function deleteAccount() {
    setDeleting(true);
    try {
      const res = await fetch("/api/auth/me", { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast({ title: "Account deleted", kind: "info" });
      await logout();
    } catch {
      toast({ title: "Failed to delete account", kind: "error" });
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <Card className="border-red-500/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-300">
          <AlertTriangle className="h-4 w-4" /> Danger zone
        </CardTitle>
        <CardDescription>
          Permanently delete your account, all projects, and all data. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!confirming ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete my account
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-300/80">
              Are you sure? All your projects, teams you own, and gallery stacks will be permanently deleted.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={() => void deleteAccount()}
                disabled={deleting}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Yes, delete everything
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Team projects section ────────────────────────────────────────────────────

type TeamProject = { id: string; name: string; user_name: string; updated_at: number };

function TeamProjectsSection({ teamId }: { teamId: string }) {
  const [projects, setProjects] = React.useState<TeamProject[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const { loadProject } = useStackStore();

  async function load() {
    if (loaded) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/teams/${teamId}/projects`);
      const d = await res.json() as { projects?: TeamProject[] };
      setProjects(d.projects ?? []);
      setLoaded(true);
    } catch {
      toast({ title: "Failed to load team projects", kind: "error" });
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading projects…</div>;
  if (projects.length === 0) return <p className="px-4 py-3 text-xs text-muted-foreground">No shared projects yet.</p>;

  return (
    <div className="px-4 py-3 space-y-1">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-2">Team projects</p>
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => { loadProject(p.id); toast({ title: `Loaded "${p.name}"`, kind: "success" }); }}
          className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-white/[0.03] transition-colors"
        >
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs flex-1 truncate">{p.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">by {p.user_name}</span>
        </button>
      ))}
    </div>
  );
}

"use client";

import * as React from "react";
import { Eye, EyeOff, Key, Lock, User } from "lucide-react";
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
            Manage your account and AI configuration.
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

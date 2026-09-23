"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Users, User, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

type Team = { id: string; name: string };
type Share = {
  id: string;
  team_id: string | null;
  user_id: string | null;
  permission: "view" | "edit";
  created_at: number;
};

/**
 * Owner-only dialog for granting view/edit access to a project. Triggered
 * from project cards on the dashboard. Lists existing shares + lets the
 * owner add a team or revoke a share. We intentionally do NOT let the
 * owner share with arbitrary users by id — picking team-as-principal keeps
 * the surface area small and matches the way the rest of the product
 * already exposes membership.
 */
export function ShareProjectDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [teams, setTeams] = React.useState<Team[]>([]);
  const [shares, setShares] = React.useState<Share[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [selectedTeamId, setSelectedTeamId] = React.useState<string>("");
  const [permission, setPermission] = React.useState<"view" | "edit">("view");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [teamsRes, sharesRes] = await Promise.all([
        fetch("/api/teams").then((r) => r.json()),
        fetch(`/api/projects/${projectId}/shares`).then((r) => r.json()),
      ]);
      setTeams(teamsRes.teams ?? []);
      setShares(sharesRes.shares ?? []);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  async function addShare() {
    if (!selectedTeamId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principal: { type: "team", teamId: selectedTeamId },
          permission,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        toast({
          title: "Couldn't share",
          description: body.error || "unknown error",
          kind: "error",
        });
        return;
      }
      toast({ title: "Shared", description: `Permission set to ${permission}`, kind: "success" });
      setSelectedTeamId("");
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(shareId: string) {
    const res = await fetch(`/api/projects/${projectId}/shares/${shareId}`, { method: "DELETE" });
    if (!res.ok) {
      toast({ title: "Couldn't revoke", kind: "error" });
      return;
    }
    toast({ title: "Access revoked", kind: "success" });
    await refresh();
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/10 bg-zinc-950 p-6 shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <Dialog.Title className="text-lg font-semibold">Share project</Dialog.Title>
              <Dialog.Description className="text-sm text-zinc-400 mt-1">
                Grant view or edit access to <span className="text-zinc-200">{projectName}</span>.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {/* Add new share */}
          <div className="space-y-3">
            <label className="block text-xs uppercase tracking-wide text-zinc-500">
              Share with team
            </label>
            <div className="flex gap-2">
              <select
                value={selectedTeamId}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="flex-1 rounded-md bg-zinc-900 border border-white/10 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                disabled={loading || teams.length === 0}
              >
                <option value="">{teams.length === 0 ? "No teams yet" : "Select team..."}</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                value={permission}
                onChange={(e) => setPermission(e.target.value as "view" | "edit")}
                className="rounded-md bg-zinc-900 border border-white/10 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </select>
              <Button onClick={addShare} disabled={!selectedTeamId || submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Share"}
              </Button>
            </div>
            {teams.length === 0 ? (
              <p className="text-xs text-zinc-500">
                Create a team in Settings → Teams to share projects.
              </p>
            ) : null}
          </div>

          {/* Existing shares */}
          <div className="mt-6">
            <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-2">
              Active shares
            </h3>
            {loading ? (
              <p className="text-sm text-zinc-500 py-3">Loading...</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-zinc-500 py-3">Not shared with anyone yet.</p>
            ) : (
              <ul className="space-y-2">
                {shares.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-zinc-900/50 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {s.team_id ? (
                        <Users className="h-4 w-4 text-indigo-400 shrink-0" />
                      ) : (
                        <User className="h-4 w-4 text-emerald-400 shrink-0" />
                      )}
                      <span className="truncate">
                        {s.team_id
                          ? teams.find((t) => t.id === s.team_id)?.name ?? "Unknown team"
                          : "Direct user share"}
                      </span>
                      <span className="ml-2 inline-flex items-center rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                        {s.permission}
                      </span>
                    </div>
                    <button
                      onClick={() => void revoke(s.id)}
                      className="text-zinc-500 hover:text-rose-400"
                      aria-label="Revoke access"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FileCode,
  FileCog,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  Github,
  GitBranch,
  Loader2,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useStackStore } from "@/lib/store";
import { toast } from "@/components/ui/toast";
import { detectStack, detectionSummary } from "@/lib/stack-detect";
import { cn } from "@/lib/utils";

// Monaco is ~4MB — load it only client-side, lazily
const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground gap-2">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading editor…
    </div>
  ),
});

// ─── Types ───────────────────────────────────────────────────────────────────

type GhFile = { path: string; sha: string; size?: number };

type RepoInfo = {
  owner: string;
  repo: string;
  defaultBranch: string;
  branch: string;
  description: string | null;
  language: string | null;
  isPrivate: boolean;
  stars: number;
  headSha: string;
  files: GhFile[];
  truncated: boolean;
};

type TreeNode = {
  name: string;
  kind: "dir" | "file";
  path: string;
  children?: TreeNode[];
  sha?: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildTree(files: GhFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split("/");
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = level.find((n) => n.name === parts[i] && n.kind === "dir");
      if (!dir) {
        dir = { name: parts[i], kind: "dir", path: dirPath, children: [] };
        level.push(dir);
      }
      level = dir.children!;
    }
    level.push({ name: parts[parts.length - 1], kind: "file", path: f.path, sha: f.sha });
  }
  return root;
}

function extToLang(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = lower.slice(dot + 1);
  const map: Record<string, string> = {
    go: "go", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", java: "java", kt: "kotlin", rb: "ruby",
    yaml: "yaml", yml: "yaml", json: "json", toml: "toml", md: "markdown",
    sql: "sql", sh: "shell", bash: "shell", env: "plaintext", mod: "go",
    proto: "protobuf", graphql: "graphql", gql: "graphql", html: "html", css: "css",
  };
  return map[ext] ?? "plaintext";
}

function fileIcon(name: string): React.ReactNode {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["json", "yaml", "yml", "toml"].includes(ext)) return <FileJson className="h-3 w-3 shrink-0 text-amber-400" />;
  if (["md", "txt", "env"].includes(ext)) return <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />;
  if (["dockerfile", "makefile", "sh"].includes(ext) || name.toLowerCase() === "dockerfile") return <FileCog className="h-3 w-3 shrink-0 text-emerald-400" />;
  return <FileCode className="h-3 w-3 shrink-0 text-brand-300" />;
}

function parseRepo(input: string): { owner: string; repo: string } | null {
  const clean = input.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

// ─── FileTree ─────────────────────────────────────────────────────────────────

function FileTreeNode({
  node,
  depth,
  activeFile,
  editedPaths,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  activeFile: string | null;
  editedPaths: Set<string>;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(depth === 0);

  if (node.kind === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/[0.03] transition-colors"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {open ? <FolderOpen className="h-3 w-3 shrink-0 text-amber-300/70" /> : <FolderClosed className="h-3 w-3 shrink-0 text-muted-foreground" />}
          {open ? <ChevronDown className="h-2.5 w-2.5 shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 shrink-0" />}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activeFile={activeFile}
            editedPaths={editedPaths}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  }

  const isActive = activeFile === node.path;
  const isEdited = editedPaths.has(node.path);
  return (
    <button
      onClick={() => onOpen(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-[11px] transition-colors",
        isActive
          ? "bg-white/[0.06] text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      {fileIcon(node.name)}
      <span className="truncate flex-1 text-left">{node.name}</span>
      {isEdited && <Circle className="h-1.5 w-1.5 shrink-0 fill-brand-400 text-brand-400" />}
    </button>
  );
}

// ─── StagedChanges + CommitComposer ───────────────────────────────────────────

function CommitPanel({
  repoInfo,
  editedFiles,
  onCommitted,
}: {
  repoInfo: RepoInfo;
  editedFiles: Map<string, string>;
  onCommitted: (newHeadSha: string) => void;
}) {
  const { gitConfig } = useStackStore();
  const prefix = gitConfig.branchNaming.feature.split("/")[0] ?? "feat";
  const [branch, setBranch] = React.useState(`${prefix}/helios-edit-${Date.now().toString(36)}`);
  const [message, setMessage] = React.useState("chore: edit via Helios");
  const [committing, setCommitting] = React.useState(false);
  const [useSameBranch, setUseSameBranch] = React.useState(false);

  const count = editedFiles.size;
  if (count === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <p className="text-[11px] text-muted-foreground text-center">No changes yet.<br />Edit files in the editor.</p>
      </div>
    );
  }

  async function handleCommit() {
    setCommitting(true);
    try {
      const targetBranch = useSameBranch ? repoInfo.branch : branch;

      // If creating new branch, create it first
      if (!useSameBranch) {
        const branchRes = await fetch("/api/github/branches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            branchName: branch,
            baseBranch: repoInfo.branch,
          }),
        });
        if (!branchRes.ok) {
          const d = (await branchRes.json()) as { message?: string };
          toast({ title: "Branch creation failed", description: d.message, kind: "error" });
          return;
        }
      }

      const changes = Array.from(editedFiles.entries()).map(([path, content]) => ({ path, content }));
      const res = await fetch("/api/github/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          branch: targetBranch,
          message,
          changes,
          expectedHeadSha: repoInfo.headSha,
        }),
      });
      const data = (await res.json()) as { oid?: string; url?: string; error?: string; message?: string };
      if (!res.ok) {
        toast({ title: "Commit failed", description: data.message ?? data.error, kind: "error" });
        return;
      }
      toast({ title: "Committed!", description: `${count} file${count !== 1 ? "s" : ""} pushed to ${targetBranch}`, kind: "success" });
      onCommitted(data.oid!);
    } finally {
      setCommitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Changed files ({count})
        </p>
        <div className="space-y-0.5 max-h-[160px] overflow-y-auto">
          {Array.from(editedFiles.keys()).map((path) => (
            <div key={path} className="flex items-center gap-1.5 text-[11px] font-mono">
              <Circle className="h-1.5 w-1.5 shrink-0 fill-brand-400 text-brand-400" />
              <span className="truncate text-muted-foreground">{path}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Commit message</label>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-brand-500/40"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Target branch</label>
          <button
            onClick={() => setUseSameBranch((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {useSameBranch ? `Push to ${repoInfo.branch}` : "New branch"}
          </button>
        </div>
        {!useSameBranch ? (
          <div className="relative">
            <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2 pl-7 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-2 text-[11px] text-amber-300">
            Pushing directly to <code className="font-mono">{repoInfo.branch}</code>
            {repoInfo.branch === repoInfo.defaultBranch ? " (default branch)" : ""}
          </div>
        )}
      </div>

      <Button
        variant="glow"
        size="sm"
        className="w-full"
        disabled={committing || !message.trim()}
        onClick={handleCommit}
      >
        {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        {committing ? "Committing…" : `Commit ${count} file${count !== 1 ? "s" : ""}`}
      </Button>
    </div>
  );
}

// ─── Stack Detection Banner ───────────────────────────────────────────────────

function DetectionBanner({
  filePaths,
  onApply,
  onDismiss,
}: {
  filePaths: string[];
  onApply: (language: string, framework?: string) => void;
  onDismiss: () => void;
}) {
  const { patch } = useStackStore();
  const detection = React.useMemo(() => detectStack(filePaths), [filePaths]);
  if (!detection.language) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-brand-500/20 bg-brand-500/[0.06] px-4 py-3 text-xs">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-brand-300 shrink-0" />
        <span>
          Stack detected: <span className="font-semibold text-brand-200">{detectionSummary(detection)}</span>
        </span>
        <Badge variant="outline" className="text-[9px] border-brand-500/30 text-brand-300">
          {detection.confidence}
        </Badge>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={() => {
            patch({
              ...(detection.language ? { language: detection.language } : {}),
              ...(detection.framework ? { framework: detection.framework } : {}),
              ...(detection.database ? { database: detection.database } : {}),
              ...(detection.api ? { api: detection.api } : {}),
              ...(detection.docker !== undefined ? { docker: detection.docker } : {}),
              ...(detection.kubernetes !== undefined ? { kubernetes: detection.kubernetes } : {}),
            });
            toast({ title: "Stack applied", description: detectionSummary(detection), kind: "success" });
            if (detection.language) onApply(detection.language, detection.framework);
          }}
        >
          Apply to workspace
        </Button>
        <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── Import Panel ─────────────────────────────────────────────────────────────

function ImportPanel({ onImport }: { onImport: (info: RepoInfo) => void }) {
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ghConnected, setGhConnected] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    fetch("/api/auth/github/status")
      .then((r) => r.json())
      .then((d: { connected: boolean }) => setGhConnected(d.connected))
      .catch(() => setGhConnected(false));
  }, []);

  async function handleImport() {
    const parsed = parseRepo(input);
    if (!parsed) {
      setError("Enter a valid repo: owner/repo or github.com/owner/repo");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/github/repo?owner=${encodeURIComponent(parsed.owner)}&repo=${encodeURIComponent(parsed.repo)}`
      );
      const data = (await res.json()) as RepoInfo & { error?: string; message?: string };
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Failed to load repo");
        return;
      }
      onImport(data);
    } catch {
      setError("Network error — check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl border border-white/[0.06] bg-white/[0.02] grid place-items-center">
            <Github className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold">Import a GitHub repo</h2>
          <p className="text-xs text-muted-foreground">
            Browse, edit, and commit changes back to any repo you have access to.
          </p>
        </div>

        {ghConnected === false && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-center space-y-3">
            <p className="text-xs text-amber-200">GitHub not connected</p>
            <a
              href="/api/auth/github?mode=connect&returnTo=/editor"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-medium hover:bg-white/[0.07] transition-colors"
            >
              <Github className="h-3.5 w-3.5" /> Connect GitHub
            </a>
          </div>
        )}

        {ghConnected !== false && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => { setInput(e.target.value); setError(null); }}
                onKeyDown={(e) => e.key === "Enter" && !loading && handleImport()}
                placeholder="owner/repo or github.com/owner/repo"
                className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                autoFocus
              />
              <Button
                variant="glow"
                onClick={handleImport}
                disabled={loading || !input.trim()}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import"}
              </Button>
            </div>
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5" /> {error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EditorPage() {
  const [repoInfo, setRepoInfo] = React.useState<RepoInfo | null>(null);
  const [tree, setTree] = React.useState<TreeNode[]>([]);
  const [activeFile, setActiveFile] = React.useState<string | null>(null);
  const [fileContents, setFileContents] = React.useState<Map<string, string>>(new Map());
  const [fileLoading, setFileLoading] = React.useState(false);
  const [editedFiles, setEditedFiles] = React.useState<Map<string, string>>(new Map());
  const [searchQuery, setSearchQuery] = React.useState("");
  const [showDetection, setShowDetection] = React.useState(true);

  function handleImport(info: RepoInfo) {
    setRepoInfo(info);
    setTree(buildTree(info.files));
    setActiveFile(null);
    setFileContents(new Map());
    setEditedFiles(new Map());
    setShowDetection(true);
  }

  async function openFile(path: string) {
    if (!repoInfo) return;
    setActiveFile(path);

    // Use edited version if available
    if (editedFiles.has(path)) return;
    // Use cached version if available
    if (fileContents.has(path)) return;

    setFileLoading(true);
    try {
      const res = await fetch(
        `/api/github/file?owner=${encodeURIComponent(repoInfo.owner)}&repo=${encodeURIComponent(repoInfo.repo)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(repoInfo.branch)}`
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (res.ok && data.content !== undefined) {
        setFileContents((prev) => new Map(prev).set(path, data.content!));
      } else {
        toast({ title: "Failed to load file", description: path, kind: "error" });
      }
    } catch {
      toast({ title: "Network error", description: "Could not load file", kind: "error" });
    } finally {
      setFileLoading(false);
    }
  }

  function handleEditorChange(value: string | undefined) {
    if (!activeFile || value === undefined) return;
    const original = fileContents.get(activeFile);
    if (value === original) {
      // Revert to unedited if content matches original
      setEditedFiles((prev) => {
        const next = new Map(prev);
        next.delete(activeFile);
        return next;
      });
    } else {
      setEditedFiles((prev) => new Map(prev).set(activeFile, value));
    }
  }

  function revertFile(path: string) {
    setEditedFiles((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }

  function handleCommitted(newHeadSha: string) {
    if (!repoInfo) return;
    setRepoInfo({ ...repoInfo, headSha: newHeadSha });
    // Merge edits into original content cache and clear staged
    setFileContents((prev) => {
      const next = new Map(prev);
      editedFiles.forEach((content, path) => next.set(path, content));
      return next;
    });
    setEditedFiles(new Map());
  }

  const filteredTree = React.useMemo(() => {
    if (!searchQuery.trim() || !repoInfo) return tree;
    const q = searchQuery.toLowerCase();
    const matchedPaths = repoInfo.files
      .filter((f) => f.path.toLowerCase().includes(q))
      .map((f) => f.path);
    return buildTree(matchedPaths.map((p) => ({ path: p, sha: "" })));
  }, [tree, searchQuery, repoInfo]);

  const activeContent = activeFile
    ? (editedFiles.get(activeFile) ?? fileContents.get(activeFile))
    : undefined;

  const editedPaths = new Set(editedFiles.keys());

  // Breadcrumb
  const breadcrumb = repoInfo
    ? [
        { label: "Editor" },
        { label: `${repoInfo.owner}/${repoInfo.repo}` },
        ...(activeFile ? [{ label: activeFile.split("/").pop() ?? activeFile }] : []),
      ]
    : [{ label: "Editor" }];

  return (
    <WorkspaceShell breadcrumb={breadcrumb}>
      {!repoInfo ? (
        <ImportPanel onImport={handleImport} />
      ) : (
        <div className="flex h-full overflow-hidden">
          {/* ── Left: File tree ── */}
          <aside className="hidden md:flex w-[220px] shrink-0 flex-col border-r border-white/[0.06] overflow-hidden">
            {/* Repo header */}
            <div className="px-3 py-3 border-b border-white/[0.06]">
              <div className="flex items-center justify-between gap-1">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold truncate">{repoInfo.owner}/{repoInfo.repo}</p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">{repoInfo.branch}</p>
                </div>
                <button
                  onClick={() => setRepoInfo(null)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="Close repo"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {editedFiles.size > 0 && (
                <div className="mt-2 flex items-center gap-1 text-[10px] text-brand-300">
                  <Circle className="h-1.5 w-1.5 fill-brand-400 text-brand-400" />
                  {editedFiles.size} unsaved change{editedFiles.size !== 1 ? "s" : ""}
                </div>
              )}
            </div>

            {/* Search */}
            <div className="px-2 py-2 border-b border-white/[0.06]">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search files…"
                  className="w-full rounded-md border border-white/[0.06] bg-white/[0.02] pl-6 pr-2 py-1.5 text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
                />
              </div>
            </div>

            {/* Tree */}
            <div className="flex-1 overflow-y-auto py-2">
              {filteredTree.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  activeFile={activeFile}
                  editedPaths={editedPaths}
                  onOpen={openFile}
                />
              ))}
            </div>
          </aside>

          {/* ── Center: Editor ── */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {/* Detection banner */}
            {showDetection && repoInfo.files.length > 0 && (
              <div className="px-4 pt-3">
                <DetectionBanner
                  filePaths={repoInfo.files.map((f) => f.path)}
                  onApply={() => setShowDetection(false)}
                  onDismiss={() => setShowDetection(false)}
                />
              </div>
            )}

            {/* Tab bar */}
            {activeFile && (
              <div className="flex items-center border-b border-white/[0.06] px-2 pt-2 gap-1 shrink-0">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-t-lg border-x border-t px-3 py-1.5 text-[11px]",
                    "border-white/[0.06] bg-white/[0.04] text-foreground"
                  )}
                >
                  {fileIcon(activeFile.split("/").pop() ?? activeFile)}
                  <span className="font-mono">{activeFile.split("/").pop()}</span>
                  {editedPaths.has(activeFile) && (
                    <Circle className="h-1.5 w-1.5 fill-brand-400 text-brand-400" />
                  )}
                  <button
                    onClick={() => { revertFile(activeFile); setActiveFile(null); }}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {editedPaths.has(activeFile) && (
                  <button
                    onClick={() => revertFile(activeFile)}
                    className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors pr-2"
                  >
                    <RotateCcw className="h-3 w-3" /> Revert
                  </button>
                )}
              </div>
            )}

            {/* Editor area */}
            <div className="flex-1 overflow-hidden">
              {!activeFile ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Select a file from the tree to edit
                </div>
              ) : fileLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading file…
                </div>
              ) : (
                <MonacoEditor
                  height="100%"
                  path={activeFile}
                  language={extToLang(activeFile.split("/").pop() ?? activeFile)}
                  value={activeContent ?? ""}
                  onChange={handleEditorChange}
                  theme="vs-dark"
                  options={{
                    fontSize: 13,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    lineNumbers: "on",
                    renderLineHighlight: "line",
                    padding: { top: 12, bottom: 12 },
                    tabSize: 2,
                  }}
                />
              )}
            </div>
          </div>

          {/* ── Right: Staged changes + commit ── */}
          <aside className="hidden lg:flex w-[240px] shrink-0 flex-col border-l border-white/[0.06]">
            <div className="px-3 py-3 border-b border-white/[0.06] flex items-center justify-between">
              <p className="text-[11px] font-semibold">Commit changes</p>
              {editedFiles.size > 0 && (
                <Badge variant="brand" className="text-[9px]">{editedFiles.size}</Badge>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              <CommitPanel
                repoInfo={repoInfo}
                editedFiles={editedFiles}
                onCommitted={handleCommitted}
              />
            </div>
          </aside>
        </div>
      )}
    </WorkspaceShell>
  );
}

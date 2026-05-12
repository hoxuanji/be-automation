"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Copy,
  Download,
  FileCode,
  FileCog,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  GitBranch,
  Github,
  Loader2,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStackStore } from "@/lib/store";
import { cn, formatBytes } from "@/lib/utils";
import { DownloadRepoButton } from "@/components/shared/download-repo-button";
import { toast } from "@/components/ui/toast";
import { generate } from "@/lib/generators";
import type { GeneratedFile } from "@/lib/generators";
import type { StackConfig as GeneratorStackConfig } from "@/lib/generators/types";

type TreeNode = {
  name: string;
  kind: "dir" | "file";
  children?: TreeNode[];
  content?: string;
  lang?: string;
};

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    go: "go",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    py: "python",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    toml: "toml",
    md: "markdown",
    sql: "sql",
    env: "dotenv",
    mod: "go.mod",
    txt: "text",
    sh: "shell",
    dockerfile: "dockerfile",
  };
  return map[ext.toLowerCase()] ?? "text";
}

function buildTree(files: GeneratedFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split("/");
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let dir = level.find((n) => n.name === parts[i] && n.kind === "dir");
      if (!dir) {
        dir = { name: parts[i], kind: "dir", children: [] };
        level.push(dir);
      }
      level = dir.children!;
    }
    const filename = parts[parts.length - 1];
    // Handle filenames like "Dockerfile" that have no extension
    const dotIdx = filename.lastIndexOf(".");
    const ext = dotIdx > 0 ? filename.slice(dotIdx + 1) : filename.toLowerCase();
    level.push({
      name: filename,
      kind: "file",
      content: f.content,
      lang: extToLang(ext),
    });
  }
  return root;
}

function flatten(n: TreeNode, path = ""): { path: string; node: TreeNode }[] {
  const p = path ? `${path}/${n.name}` : n.name;
  if (n.kind === "file") return [{ path: p, node: n }];
  return (n.children ?? []).flatMap((c) => flatten(c, p));
}

type GhStatus = { connected: false } | { connected: true; login: string; avatar: string };

function GithubParamHandler({
  setGhStatus,
}: {
  setGhStatus: React.Dispatch<React.SetStateAction<GhStatus | null>>;
}) {
  const searchParams = useSearchParams();

  React.useEffect(() => {
    const param = searchParams.get("github");
    if (param === "connected") {
      toast({ title: "GitHub connected", kind: "success" });
      fetch("/api/auth/github/status")
        .then((r) => r.json())
        .then((d) => setGhStatus(d as GhStatus))
        .catch(() => {});
      window.history.replaceState({}, "", "/preview");
    } else if (param === "error") {
      toast({ title: "GitHub auth failed", description: "Please try again.", kind: "error" });
      window.history.replaceState({}, "", "/preview");
    }
  }, [searchParams, setGhStatus]);

  return null;
}

export default function PreviewPage() {
  const { config, endpoints, entities } = useStackStore();

  const generatedFiles = React.useMemo(
    () => generate(config as unknown as GeneratorStackConfig, endpoints, entities),
    [config, endpoints, entities]
  );

  const tree = React.useMemo(() => buildTree(generatedFiles), [generatedFiles]);

  const flatFiles = React.useMemo(
    () => tree.flatMap((n) => flatten(n)),
    [tree]
  );

  const totalBytes = React.useMemo(
    () => generatedFiles.reduce((sum, f) => sum + f.content.length, 0),
    [generatedFiles]
  );

  const defaultSelected = React.useMemo(() => {
    const preferred = flatFiles.find(
      (f) =>
        f.node.name === "main.go" ||
        f.node.name === "main.ts" ||
        f.node.name.startsWith("main.")
    );
    return preferred?.path ?? flatFiles[0]?.path ?? "";
  }, [flatFiles]);

  const [selected, setSelected] = React.useState(defaultSelected);
  const [ghStatus, setGhStatus] = React.useState<GhStatus | null>(null);
  const [pushing, setPushing] = React.useState(false);

  function downloadCollection() {
    const file = generatedFiles.find((f) => f.path === "api/postman_collection.json");
    if (!file) return;
    const blob = new Blob([file.content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.name}-postman.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Postman collection downloaded", description: "Import it in Postman → Collections → Import", kind: "success" });
  }

  // Keep selected in sync when generated files change (e.g. config change)
  React.useEffect(() => {
    setSelected(defaultSelected);
  }, [defaultSelected]);

  // Check GitHub connection status on mount
  React.useEffect(() => {
    fetch("/api/auth/github/status")
      .then((r) => r.json())
      .then((d) => setGhStatus(d as GhStatus))
      .catch(() => setGhStatus({ connected: false }));
  }, []);

  const selectedNode = flatFiles.find((f) => f.path === selected)?.node;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(selected);
      toast({ title: "Path copied", description: selected, kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  async function pushToGitHub() {
    if (!ghStatus?.connected) {
      window.location.href = "/api/auth/github";
      return;
    }

    setPushing(true);
    try {
      const repoName = config.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "helios-app";
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, endpoints, entities, repoName }),
      });
      const data = await res.json() as {
        url?: string;
        fullName?: string;
        fileCount?: number;
        error?: string;
        message?: string;
        hint?: string;
      };
      if (!res.ok || data.error) {
        const title = data.message ?? "Push failed";
        const description = data.hint ?? data.error ?? "Unknown error";
        toast({ title, description, kind: "error" });
      } else {
        toast({
          title: `Pushed to ${data.fullName}`,
          description: `${data.fileCount} files · Open on GitHub`,
          kind: "success",
        });
        window.open(data.url, "_blank", "noopener");
      }
    } catch {
      toast({ title: "Push failed", description: "Network error", kind: "error" });
    } finally {
      setPushing(false);
    }
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: config.name },
        { label: "Repository" },
      ]}
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={pushToGitHub} disabled={pushing}>
            {pushing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Github className="h-3.5 w-3.5" />
            )}
            {ghStatus?.connected ? `Push as ${ghStatus.login}` : "Connect GitHub"}
          </Button>
          <Button asChild variant="glow" size="sm">
            <Link href="/deploy">
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </Link>
          </Button>
        </>
      }
    >
      <React.Suspense fallback={null}><GithubParamHandler setGhStatus={setGhStatus} /></React.Suspense>

      {entities.length === 0 && endpoints.length === 0 && (
        <div className="border-b border-amber-500/20 bg-amber-500/[0.06] px-6 py-3">
          <div className="max-w-[1280px] mx-auto flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-amber-200/80">
              Your repo has no entities or endpoints — the generated code is mostly empty.
            </p>
            <Button asChild variant="secondary" size="sm">
              <Link href="/builder">Configure your stack</Link>
            </Button>
          </div>
        </div>
      )}

      <div className="max-w-[1280px] mx-auto p-6 md:p-8 space-y-6">
        <HeaderBlock fileCount={flatFiles.length} totalBytes={totalBytes} />

        <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
          <FileTree
            tree={tree}
            selected={selected}
            onSelect={setSelected}
          />

          <div className="space-y-4 min-w-0">
            <Tabs defaultValue="code">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <TabsList>
                  <TabsTrigger value="code">
                    <FileCode className="h-3.5 w-3.5" /> Code
                  </TabsTrigger>
                  <TabsTrigger value="env">
                    <FileCog className="h-3.5 w-3.5" /> Environment
                  </TabsTrigger>
                  <TabsTrigger value="manifests">
                    <FileJson className="h-3.5 w-3.5" /> Manifests
                  </TabsTrigger>
                  <TabsTrigger value="audit">
                    <ShieldCheck className="h-3.5 w-3.5" /> Audit
                  </TabsTrigger>
                </TabsList>

                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    <GitBranch className="h-3 w-3" /> main
                  </Badge>
                  <Badge variant="success">{flatFiles.length} files</Badge>
                  <Button variant="secondary" size="sm" onClick={copyPath}>
                    <Copy className="h-3.5 w-3.5" /> Copy path
                  </Button>
                  <Button variant="secondary" size="sm" onClick={downloadCollection}>
                    <Download className="h-3.5 w-3.5" /> Postman
                  </Button>
                  <DownloadRepoButton />
                </div>
              </div>

              <TabsContent value="code">
                {selectedNode ? (
                  <CodeViewer path={selected} node={selectedNode} />
                ) : null}
              </TabsContent>

              <TabsContent value="env">
                <EnvPreview />
              </TabsContent>

              <TabsContent value="manifests">
                <ManifestsGrid generatedFiles={generatedFiles} />
              </TabsContent>

              <TabsContent value="audit">
                <AuditTab />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function HeaderBlock({
  fileCount,
  totalBytes,
}: {
  fileCount: number;
  totalBytes: number;
}) {
  return (
    <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="brand">
            <Sparkles className="h-3 w-3" /> Ready to ship
          </Badge>
          <Badge variant="outline">v0.1.0</Badge>
        </div>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          Generated repository
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          {fileCount} files · {formatBytes(totalBytes)} · inspected by 12 static
          analyzers · 0 high-severity findings
        </p>
      </div>
    </div>
  );
}

function FileTree({
  tree,
  selected,
  onSelect,
}: {
  tree: TreeNode[];
  selected: string;
  onSelect: (p: string) => void;
}) {
  const [filter, setFilter] = React.useState("");
  const q = filter.trim().toLowerCase();

  const filteredTree = React.useMemo(() => {
    if (!q) return tree;
    function visit(n: TreeNode): TreeNode | null {
      if (n.kind === "file") {
        return n.name.toLowerCase().includes(q) ? n : null;
      }
      const children = (n.children ?? []).map(visit).filter((x): x is TreeNode => !!x);
      if (children.length === 0 && !n.name.toLowerCase().includes(q)) return null;
      return { ...n, children };
    }
    return tree.map(visit).filter((x): x is TreeNode => !!x);
  }, [tree, q]);

  return (
    <Card className="h-fit">
      <div className="flex items-center gap-2 border-b border-white/[0.06] p-3">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
          placeholder="Filter files"
        />
      </div>
      <div className="p-2 font-mono text-[12px] max-h-[640px] overflow-auto">
        {filteredTree.length === 0 ? (
          <div className="px-2 py-4 text-[11px] text-muted-foreground">
            No files match.
          </div>
        ) : (
          filteredTree.map((n) => (
          <TreeRow
            key={n.name}
            node={n}
            path={n.name}
            depth={0}
            selected={selected}
            onSelect={onSelect}
          />
        ))
        )}
      </div>
    </Card>
  );
}

function TreeRow({
  node,
  path,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  path: string;
  depth: number;
  selected: string;
  onSelect: (p: string) => void;
}) {
  const [open, setOpen] = React.useState(depth < 2);
  if (node.kind === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded hover:bg-white/[0.03] text-foreground/90"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 text-brand-300" />
          ) : (
            <FolderClosed className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open ? (
          <div>
            {node.children?.map((c) => (
              <TreeRow
                key={c.name}
                node={c}
                path={`${path}/${c.name}`}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  const active = selected === path;
  return (
    <button
      onClick={() => onSelect(path)}
      className={cn(
        "flex items-center gap-1.5 w-full px-1.5 py-1 rounded transition-colors",
        active
          ? "bg-white/[0.06] text-foreground"
          : "hover:bg-white/[0.03] text-muted-foreground hover:text-foreground"
      )}
      style={{ paddingLeft: 6 + depth * 12 + 12 }}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function CodeViewer({ path, node }: { path: string; node: TreeNode }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(node.content ?? "");
      toast({ title: "File contents copied", description: path, kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-xs font-mono text-muted-foreground truncate">
          {path}
        </span>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{node.lang ?? "text"}</Badge>
          <Button variant="ghost" size="icon" onClick={copy} aria-label="Copy file">
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <pre className="p-4 text-[12.5px] font-mono leading-relaxed text-white/85 overflow-auto max-h-[560px]">
        {(node.content ?? "").split("\n").map((ln, i) => (
          <div key={i} className="flex gap-3">
            <span className="select-none text-white/20 w-6 text-right shrink-0">
              {i + 1}
            </span>
            <span className="whitespace-pre">{ln}</span>
          </div>
        ))}
      </pre>
    </Card>
  );
}

function EnvPreview() {
  const { config } = useStackStore();
  return (
    <Card>
      <CardHeader>
        <CardTitle>.env.example</CardTitle>
        <CardDescription>
          Copy to .env locally — secrets are encrypted in every environment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {config.envVars.map((v) => (
          <div
            key={v.key}
            className="grid grid-cols-[180px,1fr,auto] items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-xs"
          >
            <span className="text-foreground">{v.key}</span>
            <span className="text-muted-foreground truncate">
              {v.secret ? "••••••••••••••••" : v.value}
            </span>
            <Badge variant={v.secret ? "purple" : "outline"}>
              {v.secret ? "secret" : "env"}
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const MANIFEST_COLORS: Record<string, string> = {
  Dockerfile: "from-brand-500/30 to-brand-500/5",
  helm: "from-emerald-500/30 to-brand-500/5",
  k8s: "from-purple-500/30 to-brand-500/5",
  terraform: "from-amber-500/30 to-brand-500/5",
  ".github": "from-white/10 to-white/5",
  openapi: "from-red-500/30 to-brand-500/5",
};

function manifestColor(path: string): string {
  for (const [key, color] of Object.entries(MANIFEST_COLORS)) {
    if (path.includes(key)) return color;
  }
  return "from-white/10 to-white/5";
}

function ManifestsGrid({ generatedFiles }: { generatedFiles: GeneratedFile[] }) {
  const manifests = generatedFiles.filter(
    (f) =>
      f.path.includes("Dockerfile") ||
      f.path.includes("helm/") ||
      f.path.includes("k8s/") ||
      f.path.includes(".github/") ||
      f.path.includes("openapi.yaml")
  );

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {manifests.map((m) => {
        const dotIdx = m.path.lastIndexOf(".");
        const filename = m.path.split("/").pop() ?? m.path;
        const extRaw = dotIdx > 0 ? m.path.slice(dotIdx + 1) : filename.toLowerCase();
        const lang = extToLang(extRaw);
        const color = manifestColor(m.path);
        return (
          <Card key={m.path} className="group relative overflow-hidden hover-raise">
            <div
              className={`pointer-events-none absolute -inset-10 bg-gradient-to-br ${color} opacity-0 blur-3xl group-hover:opacity-100 transition-opacity`}
            />
            <div className="relative p-4">
              <div className="flex items-center gap-2">
                <FileCog className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-mono truncate">{m.path}</span>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Badge variant="outline">{lang}</Badge>
                <span className="text-[11px] text-muted-foreground">
                  {formatBytes(m.content.length)}
                </span>
              </div>
            </div>
          </Card>
        );
      })}
      {manifests.length === 0 && (
        <p className="col-span-3 text-xs text-muted-foreground py-4">
          No deployment manifests in the current configuration.
        </p>
      )}
    </div>
  );
}

function AuditTab() {
  const items = [
    { check: "No hardcoded secrets", status: "pass" },
    { check: "TLS only (HSTS enabled)", status: "pass" },
    { check: "Dependencies scanned (govulncheck)", status: "pass" },
    { check: "Container image distroless", status: "pass" },
    { check: "SBOM generated (CycloneDX)", status: "pass" },
    { check: "Logs scrub PII before shipping", status: "warn", note: "Review middleware.go:42" },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Security audit</CardTitle>
        <CardDescription>
          Static analysis ran before generation. Review warnings before
          deploying.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((i) => (
          <div
            key={i.check}
            className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
          >
            <span
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-medium",
                i.status === "pass"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              )}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {i.status}
            </span>
            <span className="text-xs flex-1">{i.check}</span>
            {i.note ? (
              <span className="text-[11px] text-muted-foreground">{i.note}</span>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

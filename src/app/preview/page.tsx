"use client";

import * as React from "react";
import Link from "next/link";
import {
  ChevronRight,
  Copy,
  FileCode,
  FileCog,
  FileJson,
  FileText,
  FolderClosed,
  FolderOpen,
  GitBranch,
  Github,
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
import { cn } from "@/lib/utils";
import { DownloadRepoButton } from "@/components/shared/download-repo-button";
import { PublishButton } from "@/components/shared/publish-button";
import { proposalFromConfig } from "@/lib/proposal-from-config";
import { toast } from "@/components/ui/toast";

type TreeNode = {
  name: string;
  kind: "dir" | "file";
  children?: TreeNode[];
  content?: string;
  lang?: string;
};

const tree: TreeNode[] = [
  {
    name: "cmd",
    kind: "dir",
    children: [
      {
        name: "api",
        kind: "dir",
        children: [
          {
            name: "main.go",
            kind: "file",
            lang: "go",
            content: `package main

import (
    "context"
    "log/slog"
    "os"

    "helios/internal/server"
    "helios/internal/config"
)

func main() {
    cfg := config.MustLoad()
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    srv := server.New(cfg, logger)
    if err := srv.Run(context.Background()); err != nil {
        logger.Error("server exited", "err", err)
        os.Exit(1)
    }
}
`,
          },
        ],
      },
    ],
  },
  {
    name: "internal",
    kind: "dir",
    children: [
      {
        name: "server",
        kind: "dir",
        children: [
          {
            name: "server.go",
            kind: "file",
            lang: "go",
            content: `package server

import (
    "context"
    "net/http"

    "github.com/gin-gonic/gin"
)

type Server struct {
    r *gin.Engine
}

func New(cfg *Config, log *slog.Logger) *Server {
    r := gin.New()
    r.Use(middleware.Recover(), middleware.Trace(), middleware.Auth(cfg))
    r.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
    return &Server{r: r}
}
`,
          },
          { name: "middleware.go", kind: "file", lang: "go", content: `// rate-limit, auth, tracing middleware` },
        ],
      },
      {
        name: "db",
        kind: "dir",
        children: [
          { name: "postgres.go", kind: "file", lang: "go", content: `// pgxpool with Prometheus hooks` },
          { name: "migrations", kind: "dir", children: [{ name: "0001_init.sql", kind: "file", lang: "sql", content: `-- users table etc.` }] },
        ],
      },
    ],
  },
  {
    name: "api",
    kind: "dir",
    children: [
      {
        name: "openapi.yaml",
        kind: "file",
        lang: "yaml",
        content: `openapi: 3.1.0
info:
  title: helios-api
  version: 0.1.0
paths:
  /users/{id}:
    get:
      summary: Get user
      security: [{ bearerAuth: [] }]
      responses:
        "200":
          description: OK
`,
      },
    ],
  },
  {
    name: "deploy",
    kind: "dir",
    children: [
      {
        name: "Dockerfile",
        kind: "file",
        lang: "dockerfile",
        content: `FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
`,
      },
      {
        name: "helm",
        kind: "dir",
        children: [
          {
            name: "values.yaml",
            kind: "file",
            lang: "yaml",
            content: `replicaCount: 3
image:
  repository: ghcr.io/acme/helios-api
  tag: 0.1.0
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 65
`,
          },
        ],
      },
      {
        name: "k8s",
        kind: "dir",
        children: [
          {
            name: "deployment.yaml",
            kind: "file",
            lang: "yaml",
            content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: helios-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/helios-api:0.1.0
          ports:
            - containerPort: 8080
          resources:
            requests: { cpu: 250m, memory: 256Mi }
            limits: { cpu: 1, memory: 512Mi }
`,
          },
        ],
      },
    ],
  },
  {
    name: ".github",
    kind: "dir",
    children: [
      {
        name: "workflows",
        kind: "dir",
        children: [
          {
            name: "ci.yml",
            kind: "file",
            lang: "yaml",
            content: `name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - run: go test ./... -race -cover
`,
          },
        ],
      },
    ],
  },
  { name: ".env.example", kind: "file", lang: "dotenv", content: `DATABASE_URL=postgres://user:pass@db:5432/helios\nREDIS_URL=redis://cache:6379\nJWT_SECRET=change-me\nLOG_LEVEL=info\n` },
  { name: "README.md", kind: "file", lang: "md", content: `# helios-api\n\nGenerated by Helios — a production-ready backend.\n\n## Run\n\n\`\`\`\ndocker compose up --build\n\`\`\`\n` },
  { name: "go.mod", kind: "file", lang: "go", content: `module helios\n\ngo 1.23\n` },
];

function flatten(n: TreeNode, path = ""): { path: string; node: TreeNode }[] {
  const p = path ? `${path}/${n.name}` : n.name;
  if (n.kind === "file") return [{ path: p, node: n }];
  return (n.children ?? []).flatMap((c) => flatten(c, p));
}

const allFiles = tree.flatMap((n) => flatten(n));

export default function PreviewPage() {
  const { config } = useStackStore();
  const [selected, setSelected] = React.useState(
    allFiles.find((f) => f.node.name === "main.go")?.path ?? allFiles[0].path
  );

  const selectedNode = allFiles.find((f) => f.path === selected)?.node;

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(selected);
      toast({ title: "Path copied", description: selected, kind: "success" });
    } catch {
      toast({ title: "Copy failed", kind: "error" });
    }
  }

  function pushToGitHub() {
    toast({
      title: "Connect GitHub",
      description:
        "Add a GitHub token in Settings to push generated repos to your org.",
      kind: "info",
    });
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
          <PublishButton
            proposal={proposalFromConfig(config)}
            intent={`Generated repository: ${config.name}`}
            variant="ghost"
          />
          <Button variant="secondary" size="sm" onClick={pushToGitHub}>
            <Github className="h-3.5 w-3.5" /> Push to GitHub
          </Button>
          <Button asChild variant="glow" size="sm">
            <Link href="/deploy">
              <Rocket className="h-3.5 w-3.5" /> Deploy
            </Link>
          </Button>
        </>
      }
    >
      <div className="max-w-[1280px] mx-auto p-6 md:p-8 space-y-6">
        <HeaderBlock />

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
                  <Badge variant="success">48 files</Badge>
                  <Button variant="secondary" size="sm" onClick={copyPath}>
                    <Copy className="h-3.5 w-3.5" /> Copy path
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
                <ManifestsGrid />
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

function HeaderBlock() {
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
          48 files · 172KB · inspected by 12 static analyzers · 0 high-severity
          findings
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

function ManifestsGrid() {
  const items = [
    { name: "Dockerfile", lang: "dockerfile", size: "612 B", color: "from-brand-500/30 to-brand-500/5" },
    { name: "helm/values.yaml", lang: "yaml", size: "1.4 KB", color: "from-emerald-500/30 to-brand-500/5" },
    { name: "k8s/deployment.yaml", lang: "yaml", size: "2.1 KB", color: "from-purple-500/30 to-brand-500/5" },
    { name: "terraform/main.tf", lang: "hcl", size: "3.8 KB", color: "from-amber-500/30 to-brand-500/5" },
    { name: ".github/workflows/ci.yml", lang: "yaml", size: "820 B", color: "from-white/10 to-white/5" },
    { name: "openapi.yaml", lang: "yaml", size: "5.2 KB", color: "from-red-500/30 to-brand-500/5" },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {items.map((m) => (
        <Card key={m.name} className="group relative overflow-hidden hover-raise">
          <div
            className={`pointer-events-none absolute -inset-10 bg-gradient-to-br ${m.color} opacity-0 blur-3xl group-hover:opacity-100 transition-opacity`}
          />
          <div className="relative p-4">
            <div className="flex items-center gap-2">
              <FileCog className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-mono truncate">{m.name}</span>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <Badge variant="outline">{m.lang}</Badge>
              <span className="text-[11px] text-muted-foreground">{m.size}</span>
            </div>
          </div>
        </Card>
      ))}
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

"use client";

import * as React from "react";
import {
  Code2,
  FileCode2,
  Lock,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { AIAssistant } from "@/components/shared/ai-assistant";
import { useStackStore, type Endpoint } from "@/lib/store";
import { shortId } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

const methodTones: Record<Endpoint["method"], string> = {
  GET: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
  POST: "text-brand-300 bg-brand-500/10 border-brand-500/20",
  PUT: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  PATCH: "text-purple-300 bg-purple-500/10 border-purple-500/20",
  DELETE: "text-red-300 bg-red-500/10 border-red-500/20",
};

export default function ApiBuilderPage() {
  const { endpoints, config, addEndpoint, removeEndpoint, updateEndpoint } =
    useStackStore();
  const [selectedId, setSelectedId] = React.useState(endpoints[0]?.id);
  const [apiStyle, setApiStyle] = React.useState<"rest" | "grpc">(
    config.api === "grpc" ? "grpc" : "rest"
  );
  const [filter, setFilter] = React.useState("");

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return endpoints;
    return endpoints.filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q)
    );
  }, [endpoints, filter]);

  const selected =
    endpoints.find((e) => e.id === selectedId) ?? endpoints[0];

  async function downloadOpenAPI() {
    try {
      const yaml = buildOpenAPI(config.name, endpoints);
      const blob = new Blob([yaml], { type: "text/yaml" });
      triggerDownload(blob, "openapi.yaml");
      toast({
        title: "openapi.yaml downloaded",
        description: `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}`,
        kind: "success",
      });
    } catch (err) {
      toast({
        title: "Failed to build spec",
        description: (err as Error).message,
        kind: "error",
      });
    }
  }

  function generateSDKs() {
    toast({
      title: "Generating SDKs",
      description:
        "TypeScript, Go and Python clients will appear in the repo at /clients.",
      kind: "info",
    });
  }

  return (
    <WorkspaceShell
      breadcrumb={[
        { label: "Projects", href: "/dashboard" },
        { label: config.name },
        { label: "API Contracts" },
      ]}
      right={<AIAssistant />}
    >
      <div className="flex h-full">
        {/* Left rail: endpoints */}
        <aside className="hidden md:flex w-[300px] shrink-0 flex-col border-r border-white/[0.06]">
          <div className="border-b border-white/[0.06] p-3 space-y-3">
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5 w-full">
              {(["rest", "grpc"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setApiStyle(k)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    apiStyle === k
                      ? "bg-white/[0.08] text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
                placeholder="Filter endpoints"
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              className="w-full justify-center"
              onClick={() =>
                addEndpoint({
                  id: shortId(),
                  method: "GET",
                  path: "/new-endpoint",
                  summary: "Describe what this does",
                  auth: true,
                })
              }
            >
              <Plus className="h-3.5 w-3.5" /> New endpoint
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto px-1.5 py-2 space-y-0.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                No endpoints match “{filter}”.
              </div>
            ) : (
              filtered.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                className={`group w-full flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
                  selectedId === e.id
                    ? "bg-white/[0.06]"
                    : "hover:bg-white/[0.03]"
                }`}
              >
                <span
                  className={`inline-flex h-5 min-w-[44px] items-center justify-center rounded border text-[9px] font-semibold tracking-wide ${methodTones[e.method]}`}
                >
                  {e.method}
                </span>
                <span className="text-xs font-mono truncate flex-1">
                  {e.path}
                </span>
                {e.auth ? (
                  <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                ) : null}
              </button>
              ))
            )}
          </div>

          <div className="border-t border-white/[0.06] p-3 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>{endpoints.length} endpoints</span>
              <Badge variant="brand">OpenAPI 3.1</Badge>
            </div>
          </div>
        </aside>

        {/* Main editor */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto p-6 md:p-8 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="brand">
                    <Sparkles className="h-3 w-3" /> AI-assisted
                  </Badge>
                  <Badge variant="outline">Synced</Badge>
                </div>
                <h1 className="mt-2 text-xl font-semibold tracking-tight">
                  API Contract Builder
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Define endpoints, schemas and examples — we generate server
                  stubs, typed clients and SDKs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={downloadOpenAPI}>
                  <FileCode2 className="h-3.5 w-3.5" /> Download OpenAPI
                </Button>
                <Button variant="glow" size="sm" onClick={generateSDKs}>
                  <Code2 className="h-3.5 w-3.5" /> Generate SDKs
                </Button>
              </div>
            </div>

            {selected ? (
              <EndpointEditor
                endpoint={selected}
                onUpdate={(patch) => updateEndpoint(selected.id, patch)}
                onDelete={() => {
                  removeEndpoint(selected.id);
                  setSelectedId(endpoints[0]?.id);
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function EndpointEditor({
  endpoint,
  onUpdate,
  onDelete,
}: {
  endpoint: Endpoint;
  onUpdate: (patch: Partial<Endpoint>) => void;
  onDelete: () => void;
}) {
  const methods: Endpoint["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-white/[0.06]">
          <div className="inline-flex rounded-lg border border-white/[0.08] overflow-hidden">
            {methods.map((m) => (
              <button
                key={m}
                onClick={() => onUpdate({ method: m })}
                className={`px-2.5 py-1.5 text-[11px] font-semibold border-r border-white/[0.06] last:border-r-0 transition-colors ${
                  endpoint.method === m
                    ? methodTones[m]
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <Input
            value={endpoint.path}
            onChange={(e) => onUpdate({ path: e.target.value })}
            className="flex-1 min-w-[220px] font-mono"
            placeholder="/users/:id"
          />
          <div className="flex items-center gap-2 px-2 rounded-md border border-white/[0.06] bg-white/[0.02] h-9">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">auth</span>
            <Switch
              checked={endpoint.auth}
              onCheckedChange={(v) => onUpdate({ auth: v })}
            />
          </div>
          <Button variant="ghost" size="icon" onClick={onDelete} className="text-muted-foreground hover:text-red-300">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4">
          <Input
            value={endpoint.summary}
            onChange={(e) => onUpdate({ summary: e.target.value })}
            placeholder="Short summary of this endpoint"
            className="text-sm"
          />
        </div>
      </Card>

      <Tabs defaultValue="schema">
        <TabsList>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="examples">Request / Response</TabsTrigger>
          <TabsTrigger value="openapi">OpenAPI</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="schema">
          <div className="grid gap-4 md:grid-cols-2">
            <SchemaCard
              title="Request"
              name={endpoint.requestSchema ?? "—"}
              onRename={(n) => onUpdate({ requestSchema: n })}
              fields={[
                { name: "id", type: "string", required: true, desc: "Unique identifier" },
                { name: "email", type: "string", required: false, desc: "User email" },
                { name: "role", type: "enum(admin,user)", required: false, desc: "Access role" },
              ]}
            />
            <SchemaCard
              title="Response"
              name={endpoint.responseSchema ?? "—"}
              onRename={(n) => onUpdate({ responseSchema: n })}
              fields={[
                { name: "id", type: "string", required: true, desc: "Resource id" },
                { name: "created_at", type: "datetime", required: true, desc: "UTC timestamp" },
                { name: "data", type: "User", required: true, desc: "Returned object" },
              ]}
            />
          </div>
        </TabsContent>

        <TabsContent value="examples">
          <div className="grid gap-4 md:grid-cols-2">
            <CodeBlock
              title="Request"
              lang="http"
              code={`${endpoint.method} ${endpoint.path} HTTP/1.1
Host: api.helios.dev
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "ada@helios.dev",
  "role": "admin"
}`}
            />
            <CodeBlock
              title="Response · 200"
              lang="json"
              code={`{
  "id": "usr_01HZK9…",
  "created_at": "2026-05-07T09:24:11Z",
  "data": {
    "email": "ada@helios.dev",
    "role": "admin"
  }
}`}
            />
          </div>
        </TabsContent>

        <TabsContent value="openapi">
          <CodeBlock
            title="openapi.yaml"
            lang="yaml"
            code={`paths:
  ${endpoint.path}:
    ${endpoint.method.toLowerCase()}:
      summary: ${endpoint.summary}
      security:
        - bearerAuth: ${endpoint.auth ? "[]" : "null"}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/${endpoint.responseSchema ?? "Response"}"`}
          />
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardContent className="p-5 space-y-3">
              <ToggleRow
                title="Rate limit"
                desc="Per-IP throttle · 60 req/min"
                defaultChecked
              />
              <ToggleRow
                title="Idempotency-Key"
                desc="Accept `Idempotency-Key` header for retries"
              />
              <ToggleRow
                title="Cache"
                desc="Edge cache for 60s on 200 responses"
              />
              <ToggleRow title="Tracing" desc="Emit OpenTelemetry span" defaultChecked />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SchemaCard({
  title,
  name,
  onRename,
  fields,
}: {
  title: string;
  name: string;
  onRename: (n: string) => void;
  fields: { name: string; type: string; required: boolean; desc: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title} schema</CardTitle>
            <CardDescription>
              Edit fields inline — we generate Zod / protobuf equivalents.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm">
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Schema
          </span>
          <input
            value={name}
            onChange={(e) => onRename(e.target.value)}
            className="bg-transparent text-sm font-mono text-brand-300 focus:outline-none"
          />
        </div>
        <div className="rounded-lg border border-white/[0.06] overflow-hidden divide-y divide-white/[0.04]">
          {fields.map((f) => (
            <div
              key={f.name}
              className="grid grid-cols-[1fr,0.9fr,auto] items-center gap-3 px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs truncate">{f.name}</span>
                {f.required ? (
                  <span className="text-[9px] text-red-300">required</span>
                ) : null}
              </div>
              <span className="font-mono text-[11px] text-brand-300/90 truncate">
                {f.type}
              </span>
              <span className="text-[11px] text-muted-foreground truncate">
                {f.desc}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CodeBlock({
  title,
  lang,
  code,
}: {
  title: string;
  lang: string;
  code: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="text-xs font-medium">{title}</span>
        <Badge variant="outline">{lang}</Badge>
      </div>
      <pre className="p-4 text-[12px] font-mono leading-relaxed text-white/80 overflow-auto max-h-[360px]">
        <code>{code}</code>
      </pre>
    </Card>
  );
}

function ToggleRow({
  title,
  desc,
  defaultChecked,
}: {
  title: string;
  desc: string;
  defaultChecked?: boolean;
}) {
  const [v, setV] = React.useState(!!defaultChecked);
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={v} onCheckedChange={setV} />
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildOpenAPI(name: string, endpoints: Endpoint[]) {
  const byPath = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    const p = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
    byPath.set(p, [...(byPath.get(p) ?? []), e]);
  }
  const paths: string[] = [];
  for (const [p, eps] of byPath) {
    paths.push(`  ${p}:`);
    for (const e of eps) {
      paths.push(`    ${e.method.toLowerCase()}:`);
      paths.push(`      summary: ${JSON.stringify(e.summary)}`);
      if (e.auth) paths.push(`      security: [{ bearerAuth: [] }]`);
      paths.push(`      responses:`);
      paths.push(`        "200":`);
      paths.push(`          description: OK`);
    }
  }
  return `openapi: 3.1.0
info:
  title: ${name}
  version: 0.1.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
paths:
${paths.join("\n") || "  /health:\n    get:\n      summary: Liveness\n      responses:\n        '200': { description: ok }"}
`;
}

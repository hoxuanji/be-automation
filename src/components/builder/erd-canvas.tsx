"use client";

import * as React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Trash2 } from "lucide-react";
import { useStackStore, type Entity, type Relation, type RelationType } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { shortId } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

const TYPE_COLOR: Record<string, string> = {
  uuid: "text-brand-300",
  string: "text-emerald-300",
  text: "text-emerald-300",
  number: "text-amber-300",
  boolean: "text-purple-300",
  date: "text-blue-300",
  json: "text-orange-300",
};

function EntityNode({ data }: NodeProps) {
  const entity = data.entity as Entity;
  return (
    <div className="min-w-[200px] rounded-xl border border-white/[0.1] bg-[hsl(224,30%,7%)] shadow-xl">
      <Handle type="target" position={Position.Left} className="!bg-brand-400 !border-brand-600 !w-2.5 !h-2.5" />
      <div className="border-b border-white/[0.08] px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold font-mono text-foreground">{entity.name}</span>
        <Badge variant="outline" className="text-[9px]">{entity.fields.length} fields</Badge>
      </div>
      <div className="px-3 py-2 space-y-1">
        {entity.fields.slice(0, 6).map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3">
            <span className={`text-[11px] font-mono ${f.primaryKey ? "text-foreground font-medium" : "text-muted-foreground"}`}>
              {f.name}{f.primaryKey ? " 🔑" : ""}
            </span>
            <span className={`text-[10px] font-mono ${TYPE_COLOR[f.type] ?? "text-muted-foreground"}`}>{f.type}</span>
          </div>
        ))}
        {entity.fields.length > 6 && (
          <div className="text-[10px] text-muted-foreground/60">+{entity.fields.length - 6} more</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-brand-400 !border-brand-600 !w-2.5 !h-2.5" />
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

const REL_LABELS: Record<RelationType, string> = {
  "one-to-many": "1:N",
  "many-to-many": "N:M",
  "one-to-one": "1:1",
};

function entitiesToNodes(entities: Entity[]): Node[] {
  return entities.map((e, i) => ({
    id: e.id,
    type: "entity",
    position: { x: (i % 3) * 280 + 40, y: Math.floor(i / 3) * 260 + 40 },
    data: { entity: e },
  }));
}

function relationsToEdges(relations: Relation[]): Edge[] {
  return relations.map((r) => ({
    id: r.id,
    source: r.fromEntity,
    target: r.toEntity,
    label: r.label ? `${REL_LABELS[r.type]} · ${r.label}` : REL_LABELS[r.type],
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
    style: { stroke: "#818cf8", strokeWidth: 1.5 },
    labelStyle: { fill: "#94a3b8", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
    labelBgStyle: { fill: "hsl(224,30%,7%)", fillOpacity: 0.9 },
  }));
}

export function ErdCanvas() {
  const { entities, relations, addRelation, removeRelation } = useStackStore();
  const [nodes, setNodes, onNodesChange] = useNodesState(entitiesToNodes(entities));
  const [edges, setEdges, onEdgesChange] = useEdgesState(relationsToEdges(relations));
  const [newRelType, setNewRelType] = React.useState<RelationType>("one-to-many");
  const [newRelLabel, setNewRelLabel] = React.useState("");

  React.useEffect(() => {
    setNodes(entitiesToNodes(entities));
  }, [entities, setNodes]);

  React.useEffect(() => {
    setEdges(relationsToEdges(relations));
  }, [relations, setEdges]);

  function onConnect(params: Connection) {
    if (!params.source || !params.target) return;
    if (params.source === params.target) {
      toast({ title: "Self-relations not supported", kind: "error" });
      return;
    }
    const existing = relations.find(
      (r) => r.fromEntity === params.source && r.toEntity === params.target
    );
    if (existing) {
      toast({ title: "Relation already exists", kind: "info" });
      return;
    }
    const relation: Relation = {
      id: `rel-${shortId()}`,
      fromEntity: params.source,
      toEntity: params.target,
      type: newRelType,
      label: newRelLabel.trim() || undefined,
    };
    addRelation(relation);
    setEdges((eds) => addEdge({
      ...params,
      id: relation.id,
      label: relation.label ? `${REL_LABELS[relation.type]} · ${relation.label}` : REL_LABELS[relation.type],
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
      style: { stroke: "#818cf8", strokeWidth: 1.5 },
      labelStyle: { fill: "#94a3b8", fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
      labelBgStyle: { fill: "hsl(224,30%,7%)", fillOpacity: 0.9 },
    }, eds));
    toast({ title: "Relation added", description: `${REL_LABELS[relation.type]}${relation.label ? " · " + relation.label : ""}`, kind: "success" });
    setNewRelLabel("");
  }

  function onEdgeClick(_: React.MouseEvent, edge: Edge) {
    removeRelation(edge.id);
    setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    toast({ title: "Relation removed", kind: "info" });
  }

  if (entities.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01]">
        <div className="text-center space-y-2">
          <div className="text-sm font-medium text-muted-foreground">No entities to diagram</div>
          <div className="text-xs text-muted-foreground/60">Add entities in the table view above</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>New relation type:</span>
          {(["one-to-many", "many-to-many", "one-to-one"] as RelationType[]).map((t) => (
            <button
              key={t}
              onClick={() => setNewRelType(t)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-mono transition-colors ${
                newRelType === t
                  ? "border-brand-500/50 bg-brand-500/10 text-brand-300"
                  : "border-white/[0.06] text-muted-foreground hover:border-white/20"
              }`}
            >
              {REL_LABELS[t]}
            </button>
          ))}
        </div>
        <input
          value={newRelLabel}
          onChange={(e) => setNewRelLabel(e.target.value)}
          placeholder="relation label (optional)"
          className="rounded-md border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:border-brand-500/40 w-48"
        />
        <span className="text-[11px] text-muted-foreground">
          Drag from a node handle to another to create a relation · Click an edge to delete it
        </span>
      </div>

      <div className="h-[520px] rounded-xl overflow-hidden border border-white/[0.06]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeClick={onEdgeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          className="bg-[hsl(224,32%,4%)]"
          deleteKeyCode={null}
        >
          <Background color="rgba(255,255,255,0.04)" gap={20} />
          <Controls
            className="[&_button]:bg-[hsl(224,30%,7%)] [&_button]:border-white/[0.08] [&_button]:text-muted-foreground [&_button:hover]:bg-white/[0.06]"
          />
        </ReactFlow>
      </div>

      {relations.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground px-1">{relations.length} relation{relations.length !== 1 ? "s" : ""}</div>
          {relations.map((r) => {
            const from = entities.find((e) => e.id === r.fromEntity);
            const to = entities.find((e) => e.id === r.toEntity);
            return (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-1.5">
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="text-foreground">{from?.name ?? "?"}</span>
                  <span className="text-brand-300/60">{REL_LABELS[r.type]}</span>
                  <span className="text-foreground">{to?.name ?? "?"}</span>
                  {r.label && <span className="text-muted-foreground">· {r.label}</span>}
                </div>
                <button
                  onClick={() => { removeRelation(r.id); setEdges((eds) => eds.filter((e) => e.id !== r.id)); }}
                  className="text-muted-foreground hover:text-red-300 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

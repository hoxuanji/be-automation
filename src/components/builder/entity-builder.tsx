"use client";

import * as React from "react";
import { Plus, Trash2, Database, ChevronDown, ChevronUp, Check } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useStackStore, type Entity, type EntityField, type FieldType } from "@/lib/store";
import { toast } from "@/components/ui/toast";

const FIELD_TYPES: FieldType[] = [
  "uuid",
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "json",
];

const TYPE_LABELS: Record<FieldType, string> = {
  uuid:    "UUID",
  string:  "String",
  text:    "Text",
  number:  "Number",
  boolean: "Bool",
  date:    "DateTime",
  json:    "JSON",
};

const TYPE_COLORS: Record<FieldType, string> = {
  uuid:    "text-brand-300",
  string:  "text-emerald-300",
  text:    "text-emerald-300",
  number:  "text-amber-300",
  boolean: "text-purple-300",
  date:    "text-blue-300",
  json:    "text-orange-300",
};

export function EntityBuilder() {
  const {
    entities,
    addEntity,
    removeEntity,
    addEntityField,
    removeEntityField,
    updateEntityField,
  } = useStackStore();

  const [newEntityName, setNewEntityName] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});

  function handleAddEntity() {
    const name = newEntityName.trim();
    if (!name) {
      toast({ title: "Entity name required", kind: "error" });
      return;
    }
    const pascal = name[0].toUpperCase() + name.slice(1).replace(/[^a-zA-Z0-9]/g, "");
    const ts = Date.now();
    addEntity({
      id: `entity-${ts}`,
      name: pascal,
      fields: [
        { id: `f-${ts}-1`, name: "id", type: "uuid", required: true, unique: true, primaryKey: true },
        { id: `f-${ts}-2`, name: "createdAt", type: "date", required: true, unique: false },
      ],
    });
    setNewEntityName("");
    toast({ title: `Added ${pascal}`, kind: "success" });
  }

  function handleAddField(entityId: string) {
    const ts = Date.now();
    addEntityField(entityId, {
      id: `f-${ts}`,
      name: "newField",
      type: "string",
      required: false,
      unique: false,
    });
  }

  function toggleCollapse(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (entities.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Data Models
          </CardTitle>
          <CardDescription>
            Define your entities — Helios generates Prisma schemas, GORM structs,
            or SQLAlchemy models depending on your language.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-8 text-center space-y-3">
            <Database className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm font-medium">No data models yet</p>
            <p className="text-xs text-muted-foreground">
              Use the AI prompt above or add a model manually.
            </p>
          </div>
          <AddEntityRow
            name={newEntityName}
            setName={setNewEntityName}
            onAdd={handleAddEntity}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Data Models
          </CardTitle>
          <CardDescription>
            {entities.length} model{entities.length !== 1 ? "s" : ""}. Helios generates
            ORM schemas (Prisma, GORM, SQLAlchemy) and Pydantic/Zod types.
          </CardDescription>
        </CardHeader>
      </Card>

      {entities.map((entity) => (
        <EntityCard
          key={entity.id}
          entity={entity}
          collapsed={collapsed[entity.id] ?? false}
          onToggle={() => toggleCollapse(entity.id)}
          onRemove={() => {
            removeEntity(entity.id);
            toast({ title: `Removed ${entity.name}`, kind: "info" });
          }}
          onAddField={() => handleAddField(entity.id)}
          onRemoveField={(fid) => removeEntityField(entity.id, fid)}
          onUpdateField={(fid, updates) => updateEntityField(entity.id, fid, updates)}
        />
      ))}

      <AddEntityRow
        name={newEntityName}
        setName={setNewEntityName}
        onAdd={handleAddEntity}
      />
    </div>
  );
}

function EntityCard({
  entity,
  collapsed,
  onToggle,
  onRemove,
  onAddField,
  onRemoveField,
  onUpdateField,
}: {
  entity: Entity;
  collapsed: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onAddField: () => void;
  onRemoveField: (id: string) => void;
  onUpdateField: (id: string, updates: Partial<EntityField>) => void;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold font-mono">{entity.name}</span>
          <Badge variant="outline" className="text-[10px]">
            {entity.fields.length} field{entity.fields.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            className="grid h-7 w-7 place-items-center rounded-md border border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground transition-colors"
          >
            {collapsed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="grid h-7 w-7 place-items-center rounded-md border border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-red-300 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/[0.04]">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground w-1/3">Name</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-2 text-center font-medium text-muted-foreground">Req</th>
                <th className="px-4 py-2 text-center font-medium text-muted-foreground">Unique</th>
                <th className="px-4 py-2 text-center font-medium text-muted-foreground">PK</th>
                <th className="px-4 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03]">
              {entity.fields.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  onRemove={() => onRemoveField(field.id)}
                  onUpdate={(updates) => onUpdateField(field.id, updates)}
                />
              ))}
            </tbody>
          </table>

          <div className="px-4 py-2 border-t border-white/[0.04]">
            <button
              type="button"
              onClick={onAddField}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-brand-300 transition-colors"
            >
              <Plus className="h-3 w-3" /> Add field
            </button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function FieldRow({
  field,
  onRemove,
  onUpdate,
}: {
  field: EntityField;
  onRemove: () => void;
  onUpdate: (updates: Partial<EntityField>) => void;
}) {
  const [editingName, setEditingName] = React.useState(false);
  const [nameVal, setNameVal] = React.useState(field.name);

  function commitName() {
    const v = nameVal.trim();
    if (v && v !== field.name) onUpdate({ name: v });
    setEditingName(false);
  }

  return (
    <tr className="group hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-2 font-mono">
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-brand-500/40"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setEditingName(true); setNameVal(field.name); }}
            className="hover:text-brand-200 transition-colors"
          >
            {field.name}
          </button>
        )}
      </td>

      <td className="px-4 py-2">
        <select
          value={field.type}
          onChange={(e) => onUpdate({ type: e.target.value as FieldType })}
          className={`bg-transparent text-xs font-mono cursor-pointer focus:outline-none ${TYPE_COLORS[field.type]}`}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t} className="bg-zinc-900 text-foreground">
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </td>

      <td className="px-4 py-2 text-center">
        <Checkbox
          checked={field.required}
          onChange={(v) => onUpdate({ required: v })}
          disabled={!!field.primaryKey}
        />
      </td>

      <td className="px-4 py-2 text-center">
        <Checkbox
          checked={field.unique}
          onChange={(v) => onUpdate({ unique: v })}
          disabled={!!field.primaryKey}
        />
      </td>

      <td className="px-4 py-2 text-center">
        <Checkbox
          checked={!!field.primaryKey}
          onChange={(v) => onUpdate({ primaryKey: v })}
          accent="brand"
        />
      </td>

      <td className="px-4 py-2 text-right">
        <button
          type="button"
          onClick={onRemove}
          disabled={!!field.primaryKey}
          className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-300 transition-opacity disabled:pointer-events-none"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

function Checkbox({
  checked,
  onChange,
  disabled = false,
  accent = "default",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  accent?: "default" | "brand";
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`h-4 w-4 rounded border transition-colors disabled:opacity-40 disabled:pointer-events-none inline-flex items-center justify-center ${
        checked
          ? accent === "brand"
            ? "border-brand-500/60 bg-brand-500/20 text-brand-300"
            : "border-white/30 bg-white/10 text-foreground"
          : "border-white/[0.08] bg-white/[0.02]"
      }`}
    >
      {checked && <Check className="h-2.5 w-2.5" />}
    </button>
  );
}

function AddEntityRow({
  name,
  setName,
  onAdd,
}: {
  name: string;
  setName: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onAdd(); }}
        placeholder="EntityName (PascalCase)"
        className="font-mono text-sm"
      />
      <Button variant="secondary" size="sm" onClick={onAdd} disabled={!name.trim()}>
        <Plus className="h-3.5 w-3.5" /> Add model
      </Button>
    </div>
  );
}

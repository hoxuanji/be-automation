"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, LayoutGrid } from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/shared/brand-icon";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import { templates, type Template } from "@/data/templates";
import { cn } from "@/lib/utils";

const LANGUAGES = ["All", "Go", "TypeScript", "Python"] as const;
type LangFilter = (typeof LANGUAGES)[number];

const CATEGORIES = ["All", "REST API", "Microservice", "SaaS", "E-commerce", "CMS", "Cache Service"] as const;
type CatFilter = (typeof CATEGORIES)[number];

const DIFFICULTIES = ["All", "beginner", "intermediate", "advanced"] as const;
type DiffFilter = (typeof DIFFICULTIES)[number];

const DIFFICULTY_LABELS: Record<string, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };

function langKey(lang: string): LangFilter {
  const l = lang.toLowerCase();
  if (l === "go") return "Go";
  if (l === "typescript") return "TypeScript";
  if (l === "python") return "Python";
  return "All";
}

export default function TemplatesPage() {
  const [search, setSearch] = React.useState("");
  const [lang, setLang] = React.useState<LangFilter>("All");
  const [cat, setCat] = React.useState<CatFilter>("All");
  const [diff, setDiff] = React.useState<DiffFilter>("All");

  const filtered = templates.filter((t) => {
    const matchesLang = lang === "All" || langKey(t.language) === lang;
    const matchesCat = cat === "All" || t.category === cat;
    const matchesDiff = diff === "All" || t.difficulty === diff;
    const q = search.toLowerCase().trim();
    const matchesSearch =
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.includes(q)) ||
      t.framework.toLowerCase().includes(q) ||
      t.database.toLowerCase().includes(q);
    return matchesLang && matchesCat && matchesDiff && matchesSearch;
  });

  return (
    <WorkspaceShell breadcrumb={[{ label: "Templates" }]}>
      <div className="mx-auto max-w-6xl p-6 md:p-8 space-y-8">
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent p-6 md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-[280px] w-[380px] aurora animate-aurora opacity-50" />
          <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
                  Templates
                </h1>
                <Badge variant="brand" className="text-xs">
                  {templates.length} templates
                </Badge>
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground max-w-lg">
                Start from a production-ready blueprint — configure your stack,
                add endpoints, and generate instantly.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 w-full sm:w-64 focus-within:border-brand-500/30">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-xs placeholder:text-muted-foreground/70 focus:outline-none"
                placeholder="Search templates…"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {LANGUAGES.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    lang === l
                      ? "border-brand-500/40 bg-brand-500/10 text-brand-300"
                      : "border-white/10 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider mr-1">Category</span>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCat(c)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  cat === c
                    ? "border-purple-500/40 bg-purple-500/10 text-purple-300"
                    : "border-white/10 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                )}
              >
                {c}
              </button>
            ))}
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider ml-2 mr-1">Difficulty</span>
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDiff(d)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  diff === d
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 bg-white/[0.02] text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                )}
              >
                {d === "All" ? "All" : DIFFICULTY_LABELS[d]}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] p-12 text-center space-y-2">
            <LayoutGrid className="h-8 w-8 text-muted-foreground mx-auto" />
            <div className="text-sm font-medium">No templates match</div>
            <p className="text-xs text-muted-foreground">
              Try a different search or language filter.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

function TemplateCard({ template }: { template: Template }) {
  const { patch, setEndpoints, setEntities } = useStackStore();
  const router = useRouter();

  function useTemplate() {
    patch({ ...template.config, name: template.name });
    setEndpoints(template.endpoints);
    setEntities(template.entities);
    toast({
      title: "Template loaded",
      description: `${template.name} · ${template.entities.length} models · ${template.endpoints.length} endpoints`,
      kind: "success",
    });
    router.push("/builder");
  }

  return (
    <Card className="group relative flex flex-col overflow-hidden p-5 hover-raise transition-all">
      <div className="pointer-events-none absolute -inset-px rounded-xl opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-brand-500/[0.04] to-transparent" />

      <div className="relative flex flex-col flex-1 gap-4">
        <div className="flex items-start justify-between gap-2">
          <BrandIcon id={template.language} size={32} rounded="md" />
          <div className="flex flex-wrap justify-end gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", template.difficulty === "beginner" ? "border-emerald-500/30 text-emerald-300" : template.difficulty === "advanced" ? "border-red-500/30 text-red-300" : "border-amber-500/30 text-amber-300")}>
              {DIFFICULTY_LABELS[template.difficulty]}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {template.entities.length} model{template.entities.length !== 1 ? "s" : ""}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {template.endpoints.length} endpoints
            </Badge>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <BrandIcon id={template.framework} size={16} rounded="sm" />
            <span className="text-[11px] text-muted-foreground font-mono">{template.framework}</span>
            <span className="text-muted-foreground/40 text-[11px]">+</span>
            <BrandIcon id={template.database} size={16} rounded="sm" />
            <span className="text-[11px] text-muted-foreground font-mono">{template.database}</span>
          </div>
        </div>

        <div className="flex-1">
          <div className="text-sm font-semibold tracking-tight">{template.name}</div>
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {template.description}
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          {template.tags.slice(0, 5).map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/[0.08] bg-white/[0.02] px-2 py-0.5 text-[10px] text-muted-foreground/80"
            >
              {tag}
            </span>
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="w-full mt-auto"
          onClick={useTemplate}
        >
          Use template
        </Button>
      </div>
    </Card>
  );
}

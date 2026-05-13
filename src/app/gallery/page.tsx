"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Globe,
  Loader2,
  Search,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BrandIcon } from "@/components/shared/brand-icon";
import { toast } from "@/components/ui/toast";
import { useStackStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { stackConfigSchema, endpointSchema, entitySchema } from "@/lib/schema";
import { z } from "zod";

type GalleryStack = {
  id: string;
  title: string;
  description: string | null;
  language: string;
  framework: string;
  use_case: string | null;
  author: string | null;
  owner_id: string | null;
  stack_url: string;
  stars: number;
  created_at: number;
};

const LANGUAGE_LABELS: Record<string, string> = {
  go: "Go",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
};

const LANGUAGE_COLORS: Record<string, string> = {
  go: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10",
  typescript: "text-blue-400 border-blue-500/30 bg-blue-500/10",
  python: "text-yellow-400 border-yellow-500/30 bg-yellow-500/10",
  rust: "text-orange-400 border-orange-500/30 bg-orange-500/10",
  java: "text-red-400 border-red-500/30 bg-red-500/10",
  kotlin: "text-purple-400 border-purple-500/30 bg-purple-500/10",
};

const LANGUAGES = ["go", "typescript", "python", "rust", "java", "kotlin"];

const importedStackSchema = z.object({
  config: stackConfigSchema,
  endpoints: z.array(endpointSchema).max(200).optional(),
  entities: z.array(entitySchema).max(50).optional(),
});

export default function GalleryPage() {
  const router = useRouter();
  const { authUser } = useStackStore();
  const [stacks, setStacks] = React.useState<GalleryStack[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [language, setLanguage] = React.useState<string>("");
  const [query, setQuery] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [starring, setStarring] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  React.useEffect(() => {
    setLoading(true);
    setStacks([]);
    const params = new URLSearchParams();
    if (language) params.set("language", language);
    if (debouncedQ) params.set("q", debouncedQ);
    fetch(`/api/gallery?${params}`)
      .then((r) => r.json())
      .then((d: { stacks: GalleryStack[]; hasMore: boolean }) => {
        setStacks(d.stacks ?? []);
        setHasMore(d.hasMore ?? false);
      })
      .catch(() => toast({ title: "Failed to load gallery", kind: "error" }))
      .finally(() => setLoading(false));
  }, [language, debouncedQ]);

  async function loadMore() {
    setLoadingMore(true);
    const params = new URLSearchParams();
    if (language) params.set("language", language);
    if (debouncedQ) params.set("q", debouncedQ);
    params.set("offset", String(stacks.length));
    try {
      const d = await fetch(`/api/gallery?${params}`).then((r) => r.json()) as { stacks: GalleryStack[]; hasMore: boolean };
      setStacks((prev) => [...prev, ...(d.stacks ?? [])]);
      setHasMore(d.hasMore ?? false);
    } catch {
      toast({ title: "Failed to load more", kind: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  function loadInBuilder(stack: GalleryStack) {
    try {
      const raw = JSON.parse(atob(stack.stack_url));
      const parsed = importedStackSchema.safeParse(raw);
      if (!parsed.success) {
        toast({ title: "Invalid stack data", description: "This stack entry appears corrupted.", kind: "error" });
        return;
      }
    } catch {
      toast({ title: "Invalid stack data", description: "Could not decode this stack.", kind: "error" });
      return;
    }
    router.push(`/builder?stack=${encodeURIComponent(stack.stack_url)}`);
  }

  async function handleStar(stack: GalleryStack) {
    if (starring) return;
    setStarring(stack.id);
    try {
      await fetch(`/api/gallery?id=${stack.id}`, { method: "PUT" });
      setStacks((prev) =>
        prev.map((s) => (s.id === stack.id ? { ...s, stars: s.stars + 1 } : s))
      );
      toast({ title: "Starred!", kind: "success" });
    } catch {
      toast({ title: "Star failed", kind: "error" });
    } finally {
      setStarring(null);
    }
  }

  async function handleDelete(stack: GalleryStack) {
    if (deleting) return;
    setDeleting(stack.id);
    try {
      const res = await fetch(`/api/gallery?id=${stack.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setStacks((prev) => prev.filter((s) => s.id !== stack.id));
      toast({ title: "Stack removed from gallery", kind: "success" });
    } catch {
      toast({ title: "Delete failed", kind: "error" });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <WorkspaceShell
      breadcrumb={[{ label: "Gallery" }]}
      actions={
        <Button asChild variant="glow" size="sm">
          <Link href="/builder">
            Build your stack <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      }
    >
      <div className="max-w-[1280px] mx-auto p-6 md:p-8 space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-brand-300" />
            <h1 className="text-xl font-semibold tracking-tight">Stack Gallery</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Community-shared stacks. Open any into your builder and customize from there.
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search stacks…"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-brand-500/40"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setLanguage("")}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                !language
                  ? "border-brand-500/50 bg-brand-500/15 text-brand-300"
                  : "border-white/[0.08] text-muted-foreground hover:text-foreground"
              )}
            >
              All
            </button>
            {LANGUAGES.map((l) => (
              <button
                key={l}
                onClick={() => setLanguage(l === language ? "" : l)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  language === l
                    ? LANGUAGE_COLORS[l]
                    : "border-white/[0.08] text-muted-foreground hover:text-foreground"
                )}
              >
                {LANGUAGE_LABELS[l]}
              </button>
            ))}
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="h-[172px] animate-pulse opacity-40" />
            ))}
          </div>
        ) : stacks.length === 0 ? (
          <EmptyState hasFilters={!!(language || debouncedQ)} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {stacks.map((stack) => (
                <StackCard
                  key={stack.id}
                  stack={stack}
                  isOwner={!!authUser && authUser.id === stack.owner_id}
                  starring={starring === stack.id}
                  deleting={deleting === stack.id}
                  onLoad={() => loadInBuilder(stack)}
                  onStar={() => handleStar(stack)}
                  onDelete={() => handleDelete(stack)}
                />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center pt-2">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}

function StackCard({
  stack,
  isOwner,
  starring,
  deleting,
  onLoad,
  onStar,
  onDelete,
}: {
  stack: GalleryStack;
  isOwner: boolean;
  starring: boolean;
  deleting: boolean;
  onLoad: () => void;
  onStar: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="group relative overflow-hidden hover-raise flex flex-col">
      <div className="pointer-events-none absolute -inset-10 bg-gradient-to-br from-brand-500/10 to-transparent opacity-0 blur-3xl group-hover:opacity-100 transition-opacity" />
      <CardContent className="relative flex flex-col gap-3 p-5 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <BrandIcon id={stack.language} size={18} />
            <span className="font-medium text-sm truncate">{stack.title}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isOwner && (
              <button
                onClick={onDelete}
                disabled={deleting}
                className="text-muted-foreground/50 hover:text-red-400 transition-colors"
                aria-label="Delete"
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            <button
              onClick={onStar}
              disabled={starring}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-amber-300 transition-colors"
            >
              <Star className={cn("h-3.5 w-3.5", starring && "animate-pulse")} />
              {stack.stars}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge
            variant="outline"
            className={cn("text-[10px] border", LANGUAGE_COLORS[stack.language] ?? "")}
          >
            {LANGUAGE_LABELS[stack.language] ?? stack.language}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            <BrandIcon id={stack.framework} size={11} />
            {stack.framework}
          </Badge>
          {stack.use_case && (
            <Badge variant="outline" className="text-[10px]">
              {stack.use_case}
            </Badge>
          )}
        </div>

        {stack.description && (
          <p className="text-[12px] text-muted-foreground line-clamp-2">
            {stack.description}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between pt-1">
          {stack.author ? (
            <span className="text-[11px] text-muted-foreground">
              by {stack.author}
            </span>
          ) : (
            <span />
          )}
          <Button variant="secondary" size="sm" onClick={onLoad} className="h-7 text-[11px] px-2.5">
            <Zap className="h-3 w-3" /> Open in builder
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
      <Globe className="h-8 w-8 text-muted-foreground/40" />
      <p className="text-sm font-medium">
        {hasFilters ? "No stacks match your filters" : "The gallery is empty"}
      </p>
      <p className="text-xs text-muted-foreground max-w-xs">
        {hasFilters
          ? "Try adjusting your search or language filter."
          : "Be the first to share a stack — generate one in the builder and click Share to gallery."}
      </p>
      <Button asChild variant="secondary" size="sm" className="mt-2">
        <Link href="/builder">
          Build a stack <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}

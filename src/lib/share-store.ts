import type { ArchitectureProposal } from "@/lib/architect-schema";

/**
 * Simple in-memory share store for public architecture pages.
 *
 * MVP scope: in-process Map; not persistent across restarts. Swap for KV
 * (Upstash, Vercel KV, Postgres) when this graduates from demo.
 *
 * The module-scope Map survives across requests within a single Next.js
 * server instance, so dev + single-region production both work today.
 */

export type SharedArchitecture = {
  slug: string;
  intent: string;
  proposal: ArchitectureProposal;
  createdAt: string;
  forks: number;
  views: number;
};

const MAX_ENTRIES = 1000;
const store = new Map<string, SharedArchitecture>();

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomSuffix(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

function safeSlug(name: string) {
  const base = (name || "stack")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "stack";
}

export function publish(
  intent: string,
  proposal: ArchitectureProposal
): SharedArchitecture {
  const base = safeSlug(proposal.config.name);
  let slug = `${base}-${randomSuffix()}`;
  // ultra-rare collisions; bump suffix length on retry
  let attempts = 0;
  while (store.has(slug) && attempts < 4) {
    slug = `${base}-${randomSuffix(6 + attempts)}`;
    attempts++;
  }

  const shared: SharedArchitecture = {
    slug,
    intent,
    proposal,
    createdAt: new Date().toISOString(),
    forks: 0,
    views: 0,
  };

  store.set(slug, shared);

  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }

  return shared;
}

export function get(slug: string): SharedArchitecture | undefined {
  return store.get(slug);
}

export function recordView(slug: string) {
  const s = store.get(slug);
  if (s) s.views++;
}

export function recordFork(slug: string) {
  const s = store.get(slug);
  if (s) s.forks++;
}

export function recent(limit = 10): SharedArchitecture[] {
  return Array.from(store.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function size() {
  return store.size;
}

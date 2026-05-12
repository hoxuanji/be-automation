# CLAUDE.md

Guidance for Claude Code (or any agent) working on this repo.

## What this is

**Helios** — an AI-native backend infrastructure generator. The user configures a stack visually; the backend emits a real, buildable repository as a zip. Claude Sonnet 4.6 powers an in-app copilot that audits the stack and explains trade-offs.

The UI is Next.js 15 (App Router) + React 19 + Tailwind + Framer Motion + Zustand + Radix primitives. The generation backend is Node-runtime Next.js API routes using `archiver` for streaming zip output and `@anthropic-ai/sdk` for SSE chat.

## Quick commands

```bash
npm run dev     # local dev server on :3000
npm run build   # production build
npm run start   # start production server
npm run lint    # Next.js ESLint
```

No tests yet. No prisma / no DB — state is Zustand only, per-tab.

## Architecture in one screen

```
Browser                          Next.js server
──────────                       ──────────────
Zustand store  ──┐
(src/lib/store)  │
                 │  POST /api/generate        → Zod validate → generate() → archiver zip stream
                 │    body: {config, endpoints}
                 │    resp: application/zip
                 │
                 └─▶ POST /api/ai/chat        → Anthropic SDK messages.stream() → SSE
                      body: {messages, config?}
                      resp: text/event-stream
```

The client is the source of truth for `StackConfig` and `Endpoint[]`. The server is stateless — it takes the current state and emits artifacts.

## Directory map

- `src/app/` — Next.js App Router. Each page is a route.
  - `page.tsx` — Landing (marketing).
  - `dashboard/` — Workspace overview.
  - `builder/` — **Core surface.** 10 tabs (Runtime, Database, Cache, Queue, APIs, Security, Deployment, Scaling, CI/CD, Monitoring) + architecture preview + AI assistant + summary.
  - `api-builder/` — REST/gRPC endpoint editor.
  - `preview/` — Generated repository browser with Download zip CTA.
  - `deploy/` — Provider grid + credentials + simulated deploy flow.
  - `api/generate/route.ts` — zip stream endpoint.
  - `api/ai/chat/route.ts` — Anthropic SSE endpoint.
- `src/components/`
  - `ui/` — shadcn-style primitives (Button, Card, Tabs, Switch, Slider, Badge, Input, Tooltip, ScrollArea, SelectableCard, Dropdown, Toast, Separator, Kbd).
  - `layout/` — Sidebar, Topbar, WorkspaceShell.
  - `landing/` — hero + features + demo + logo wall + CTA.
  - `builder/` — ArchitecturePreview, StackSummary.
  - `shared/` — Logo, Terminal, AIAssistant, DownloadRepoButton, BrandIcon.
- `src/lib/`
  - `store.ts` — Zustand: `config`, `endpoints`, `workspace[s]`. Mutators: `set`, `patch`, `addEndpoint`, `removeEndpoint`, `updateEndpoint`, `addEnvVar`, `removeEnvVar`, `setWorkspace`.
  - `schema.ts` — Zod schemas for API request validation. Mirrors store types.
  - `utils.ts` — `cn()`, `formatBytes()`, `shortId()`.
  - `generators/` — Templated file emitters.
    - `index.ts` — `generate(config, endpoints) → GeneratedFile[]`.
    - `common.ts` — README, env, Dockerfile, docker-compose, K8s, Helm, CI, OpenAPI.
    - `go.ts` / `typescript.ts` / `python.ts` / `others.ts` (Rust/Java/Kotlin).
- `src/data/stack-options.ts` — Catalog of languages, frameworks, DBs, caches, queues, auth, deployments, monitoring, CI. Brand ids in this file must match keys in `BrandIcon`'s registry.

## State model

`StackConfig` is the single source of truth. Anything user-configurable in the builder lives here. The architecture preview, stack summary, and recommendations card are all *derived* from it.

```ts
type StackConfig = {
  name: string
  language: "go" | "typescript" | "python" | "rust" | "java" | "kotlin"
  framework: string           // id scoped to language
  database: string            // "postgres", "mongodb", "neon", …
  cache: string               // "redis", "memcached", …
  queue: string               // "rabbitmq", "kafka", "nats", …
  api: "rest" | "grpc" | "graphql" | "trpc"
  auth: string                // "clerk", "auth0", …
  deployment: string          // "vercel", "aws", "k8s", …
  scaling: string
  monitoring: string
  cicd: string
  docker: boolean
  kubernetes: boolean
  helm: boolean
  tracing: boolean
  rateLimit: boolean
  audit: boolean
  autoscale: boolean
  replicas: number
  region: string
  envVars: { key: string; value: string; secret?: boolean }[]
}
```

`Endpoint` represents a single REST/gRPC route (`id`, `method`, `path`, `summary`, `auth`, optional `requestSchema` / `responseSchema`).

## Generators

`generate()` composes a repo from `commonFiles()` + a language-specific file set. Adding a new language:

1. Add to the `StackConfig["language"]` enum in `src/lib/schema.ts` and `src/lib/store.ts`.
2. Add options in `src/data/stack-options.ts` (language entry + matching frameworks, and the language's meta in `common.ts` if commands differ).
3. Create `src/lib/generators/<lang>.ts` exporting `<lang>Files(config, endpoints): GeneratedFile[]` — must include a Dockerfile, a main entry file, and a CI-friendly layout.
4. Wire it into `src/lib/generators/index.ts`.
5. Optionally add a brand in `src/components/shared/brand-icon.tsx`.

Generators must output **plain text** files — no binary. Use `dedent` / template strings, keep paths POSIX (forward slashes), and keep filenames deterministic; `generate()` sorts by path for stable zip contents.

## AI chat

`src/app/api/ai/chat/route.ts`:
- Model: `claude-sonnet-4-6`.
- System prompt is split into two blocks — static persona + the current `StackConfig` as a cached ephemeral block (`cache_control: { type: "ephemeral" }`). Repeated turns hit the prompt cache.
- Streams via `client.messages.stream(...).on("text", …)`. Forwarded to the client as SSE (`event: text` / `event: done` / `event: error`).
- Returns **503** with `{ error: "missing_api_key" }` when `ANTHROPIC_API_KEY` is not set. `AIAssistant` renders a friendly banner for that case — do not crash the UI when the key is missing.
- The client strips any leading `assistant` turn before POSTing — Anthropic requires the message array to start with `user`.

## Design system

- **Dark-first.** Tokens in `src/app/globals.css` under `:root`. Don't ship light-mode styles unless asked.
- **Glassmorphism** via `.glass` / `.glass-strong` classes. Avoid over-blurring — 12–18px is the sweet spot.
- **Aurora + dot backgrounds** via `.aurora`, `.dot-bg`, `.grid-bg`, `.mask-radial`. Prefer composing these over one-off CSS.
- **Typography:** Inter for UI, JetBrains Mono for code. Loaded from Google Fonts in `src/app/layout.tsx`.
- **Brand tiles:** Always render stack choices with `<BrandIcon id={...} size={22} />`. Each registry entry has a real accent color, real SVG path, or branded monogram — do not add plain lucide icons for known brand ids.
- **Rounded corners:** `rounded-lg` for buttons / pills, `rounded-xl` for cards, `rounded-2xl` for hero sections.
- **Animations:** Use Framer Motion's `initial/animate/transition` with subtle y-translate + opacity. Keep durations ≤ 0.5s; avoid spring for UI chrome.

## Conventions

- **Client vs server components:** default to server; add `"use client"` only when you need state, effects, or Framer Motion. Pages that read `useStackStore` must be client.
- **No external API calls from client components** except to `/api/*` routes.
- **Handlers > hrefs for placeholder destinations.** Show a toast with meaningful context instead of linking to `#`. Every clickable element in the product has a handler — keep that invariant.
- **Toasts** via `toast({ title, description?, kind: "success" | "info" | "error" })` from `src/components/ui/toast.tsx`. The `Toaster` is already mounted globally.
- **Dropdowns** use the in-house primitive in `src/components/ui/dropdown.tsx` — don't reach for Radix DropdownMenu unless you need focus trapping / nesting.
- **Imports use `@/…` alias** (configured in `tsconfig.json`).
- **No barrel files** in `src/components/ui/` — import each primitive directly.
- **Icons:** lucide-react for UI glyphs, `BrandIcon` for stack choices. Don't mix them for the same concept on the same page.

## Things to watch out for

- `package-lock.json` is checked in — keep it in sync when adding deps.
- The generators return raw source files with hardcoded module paths like `github.com/your-org/<name>`. If you add a language, prefer the same convention so the README stays accurate.
- `ANTHROPIC_API_KEY` is optional at build time but required at runtime for `/api/ai/chat`. Do not crash the app if it's missing — `route.ts` must return a structured 503.
- `archiver` requires Node runtime — the `/api/generate` route sets `export const runtime = "nodejs"`. Do not change to edge.
- `SelectableCard`'s outer tile has its own `h-9 w-9` container. Pass `BrandIcon size={22}` so it fits without a double-tile look.
- The workspace dropdown (`Dropdown` primitive) needs `className="block w-full"` on its root to span the sidebar width.
- When adding a new stack option to `src/data/stack-options.ts`, either add a matching entry to `src/components/shared/brand-icon.tsx` or accept the monogram fallback — do not introduce generic lucide icons in the selectable cards.

## Things not to do

- Don't run `git config --global …` — keep identity changes scoped to the repo (`git config user.email "…"`).
- Don't commit `.env*.local` or `.claude/` (both are gitignored).
- Don't add a CSS framework beyond Tailwind. Don't add another state library. Don't add a component library on top of the current primitives.
- Don't replace the Zustand store with Redux/Jotai/Context. Don't add persistence unless asked.
- Don't lift the AI copilot into global state — it's a panel, rendered per-page via `WorkspaceShell.right`.

## Glossary of ids (must stay consistent)

- Languages: `go`, `typescript`, `python`, `rust`, `java`, `kotlin`.
- Go frameworks: `gin`, `fiber`, `echo`, `chi`.
- TS frameworks: `nestjs`, `express`, `fastify`, `hono`.
- Python frameworks: `fastapi`, `django`, `litestar`.
- Rust: `axum`, `actix`.
- Java: `spring`, `quarkus`.
- Kotlin: `ktor`, `spring-kt`.
- Deployments: `vercel`, `railway`, `render`, `fly`, `aws`, `gcp`, `azure`, `k8s`.
- APIs: `rest`, `grpc`, `graphql`, `trpc`.

New ids must be added to **three** places: `stack-options.ts`, the matching generator, and (ideally) `BrandIcon`'s registry.
# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Rule 5 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

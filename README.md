<div align="center">

# Helios

**AI-native backend infrastructure generator.**

Visually configure a production-ready stack — language, database, cache, queue, auth, API, deployment — and export a typed, tested, deployable repository. Vercel × Railway × Cursor × Terraform, reimagined as one workspace.

![Next.js](https://img.shields.io/badge/Next.js-15-000?logo=next.js) ![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=000) ![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=fff) ![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38bdf8?logo=tailwindcss&logoColor=fff) ![Anthropic](https://img.shields.io/badge/Claude-Sonnet%204.6-D97757)

</div>

---

## What it does

Helios is a full-stack **infrastructure generator**: pick a stack visually, watch the live architecture diagram update, and download a real, buildable backend repository. An AI copilot (Claude Sonnet 4.6) audits your choices, recommends upgrades, and explains trade-offs.

The generated repo is not scaffolded — it is tailored. Your chosen language, framework, database, cache, queue, auth provider, deployment target, and feature flags all drive the output: source files, Dockerfile, `docker-compose.yml` with the right service dependencies, Kubernetes manifests, Helm chart, GitHub Actions workflow, and an OpenAPI 3.1 spec derived from the endpoints you defined.

## Highlights

- **Six polished pages** — Landing, Dashboard, Stack Builder, API Contract Builder, Repository Preview, Deployment Center.
- **Real generation backend** — `POST /api/generate` validates with Zod, composes a templated repo, and streams a zip back to the browser (Node `archiver`, no buffering).
- **Real AI copilot** — `POST /api/ai/chat` streams tokens from Claude via SSE with the current stack config attached as a cached prompt block.
- **Six languages, ~14 frameworks** — Go (gin/fiber/echo/chi), TypeScript (NestJS/Express/Fastify/Hono), Python (FastAPI/Litestar/Django), Rust (Axum), Java (Spring), Kotlin (Ktor).
- **Brand-aware UI** — every stack choice renders with a real logo (Postgres, Redis, Kafka, Vercel, AWS, GCP, Azure, Kubernetes, Supabase, and dozens more) or a branded monogram tile.
- **Every interactive element is wired** — toasts, dropdowns, filters, clipboard copy, live previews. No placeholder buttons.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router, React 19 server/client split) |
| Styling | TailwindCSS 3.4 + custom design tokens, glassmorphism, aurora gradients |
| Primitives | Hand-rolled shadcn-style components on Radix primitives |
| Animation | Framer Motion |
| State | Zustand |
| Forms / validation | React Hook Form + Zod |
| Icons | Lucide + custom `BrandIcon` registry |
| AI | `@anthropic-ai/sdk` (Claude Sonnet 4.6, prompt caching, SSE streaming) |
| Zip streaming | `archiver` over Node streams via Web `ReadableStream` |

## Getting started

```bash
# 1. Clone
git clone https://github.com/hoxuanji/be-automation.git
cd be-automation

# 2. Install
npm install

# 3. Configure
cp .env.example .env.local
# paste your ANTHROPIC_API_KEY to enable the real AI copilot.
# Without the key, the UI shows a friendly "not configured" banner instead.

# 4. Run
npm run dev
# → http://localhost:3000
```

## Pages

### 1 — Landing `/`
Hero with an animated, live infrastructure graph. Features grid, scripted terminal demo, CTA.

### 2 — Dashboard `/dashboard`
Workspace overview: recent projects, metric sparklines, activity feed, quick actions, **production-ready templates** that seed the store and route you into the builder (SaaS Starter, Realtime Chat, Event-Driven API, ML Inference).

### 3 — Stack Builder `/builder`
The core surface. Ten tabs — **Runtime · Database · Cache · Queue · APIs · Security · Deployment · Scaling · CI/CD · Monitoring** — each populated with brand-labelled selectable cards. A live architecture graph rerenders on every change. A sticky right sidebar streams an AI copilot, stack summary, cost estimate, derived recommendations, and a projected utilization gauge. Every recommendation's *Apply* button patches the store.

### 4 — API Contract Builder `/api-builder`
REST / gRPC toggle, searchable endpoint list, inline method/path/auth editor, schema editor, request + response examples, OpenAPI preview, per-endpoint settings (rate limit, idempotency, cache, tracing). **Download OpenAPI** exports a real YAML spec built from your endpoints.

### 5 — Repository Preview `/preview`
Filtered file tree, syntax-numbered viewer, environment preview, manifests grid, and a security-audit tab. **Download zip** calls the real `/api/generate` endpoint and saves the repo locally.

### 6 — Deployment Center `/deploy`
Provider grid with real brand marks (Vercel, Railway, Render, Fly, AWS, GCP, Azure, Kubernetes), encrypted credentials panel with paste-from-clipboard + test-connection, latency-aware region picker, scaling config, and an animated deploy flow (configure → deploying → live) with streaming logs.

## Backend API

### `POST /api/generate`

Validates `{ config, endpoints }` with Zod and streams a generated zip back.

```ts
// request
{
  config: StackConfig,      // see src/lib/schema.ts
  endpoints: Endpoint[]
}

// response
200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="<name>.zip"
X-Helios-Files: 42
```

The generators are modular by language — see [`src/lib/generators/`](src/lib/generators/). The common generator emits README, `.env.example`, Dockerfile composition, `docker-compose.yml` (with service deps resolved from the chosen database/cache/queue), Kubernetes Deployment/Service/HPA, Helm chart + templates, GitHub Actions CI, and an OpenAPI 3.1 spec.

### `POST /api/ai/chat`

Server-sent events stream from Claude. Requires `ANTHROPIC_API_KEY`.

```ts
// request
{
  messages: { role: "user" | "assistant"; content: string }[],
  config?: StackConfig  // attached as cached prompt block
}

// response
200 OK
Content-Type: text/event-stream

event: text
data: { "text": "For that workload I'd pair…" }

event: done
data: { "usage": {...}, "stopReason": "end_turn" }
```

The system prompt scopes the model to stack-design questions. The stack config is injected as an **ephemeral cache block** (`cache_control: { type: "ephemeral" }`), so repeated turns hit the prompt cache.

## Project structure

```
src/
├── app/
│   ├── page.tsx                 # Landing
│   ├── dashboard/page.tsx
│   ├── builder/page.tsx         # Stack Builder (10 tabs)
│   ├── api-builder/page.tsx
│   ├── preview/page.tsx
│   ├── deploy/page.tsx
│   ├── layout.tsx
│   ├── globals.css              # design tokens + Tailwind layers
│   └── api/
│       ├── generate/route.ts    # zip stream
│       └── ai/chat/route.ts     # Anthropic SSE
│
├── components/
│   ├── ui/                      # Button, Card, Tabs, Switch, Slider,
│   │                            # Badge, Input, Tooltip, ScrollArea,
│   │                            # SelectableCard, Dropdown, Toast, …
│   ├── layout/                  # Sidebar, Topbar, WorkspaceShell
│   ├── landing/                 # hero + features + demo + CTA
│   ├── builder/                 # architecture preview, stack summary
│   └── shared/                  # Logo, Terminal, AIAssistant,
│                                # DownloadRepoButton, BrandIcon
│
├── data/stack-options.ts        # Catalog of languages/DBs/caches/…
│
└── lib/
    ├── store.ts                 # Zustand: config, endpoints, workspace
    ├── schema.ts                # Zod schemas for API validation
    ├── utils.ts
    └── generators/              # Templated file emitters, per language
        ├── index.ts
        ├── types.ts
        ├── common.ts            # README, env, Docker, K8s, Helm, CI, OpenAPI
        ├── go.ts
        ├── typescript.ts
        ├── python.ts
        └── others.ts            # Rust / Java / Kotlin
```

## Environment

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables the real AI copilot at `/api/ai/chat`. Optional — the UI degrades gracefully without it. |

## Scripts

```bash
npm run dev       # dev server
npm run build     # production build
npm run start     # start production server
npm run lint      # Next.js ESLint
```

## Design system

- **Dark-first**, soft gradients, subtle glassmorphism, animated aurora + dot backgrounds.
- **Brand registry** (`src/components/shared/brand-icon.tsx`) — inline monochrome SVG marks for ~12 flagship brands + gradient-filled monogram tiles for the long tail. Every tile uses the brand's real accent color and auto-picks a contrasting foreground.
- **Toast system** (`src/components/ui/toast.tsx`) — lightweight, Zustand-backed, animated via Framer Motion.
- **Dropdown primitive** (`src/components/ui/dropdown.tsx`) — click-outside + Escape-to-close, used by the workspace switcher and avatar menu.

## Status

Everything you see is functional:
- Every button has a handler.
- Every input is state-backed.
- Every filter actually filters.
- The Download zip button produces a real, buildable repository.
- The AI assistant streams real tokens from Claude when the API key is set.

The only *simulated* surface is the deployment progress bar in `/deploy` — it does not provision real infrastructure. Everything upstream of that is real.

## License

MIT.

---

<div align="center">
  Generated with ❤️ and a lot of Tailwind.
</div>

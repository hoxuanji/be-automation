# Helios — Roadmap & Product Knowledge Base

> **Purpose:** Single source of truth for agents and contributors. Covers what is built, how to verify it works, and what to build next. Update this file when features ship or gaps are closed.

---

## 1. What's Built

### Authentication
- **Email/password signup & login** — `POST /api/auth/signup`, `POST /api/auth/login`. Passwords hashed with bcrypt. JWT stored in `helios_token` cookie (HttpOnly).
- **GitHub OAuth** — `GET /api/auth/github` → callback → sets `github_token` cookie. Used for both login and connecting a GitHub account to an existing session (mode=connect).
- **Forgot / reset password** — token-based email flow. `POST /api/auth/forgot-password` generates a reset token; `POST /api/auth/reset-password` consumes it.
- **JWT middleware** — `src/middleware.ts` protects all workspace routes. Redirects unauthenticated users to `/login?returnTo=...`.
- **Session invalidation** — sessions tracked in SQLite; `DELETE /api/auth/logout` deletes the session row.

### Database (SQLite via better-sqlite3)
Tables: `users`, `sessions`, `password_reset_tokens`, `projects`, `deploy_creds`, `teams`, `team_members`, `team_invites`, `gallery_stacks`, `rate_limits`.

### Stack Builder (`/builder`)
- **Language picker** — Go, TypeScript, Python, Rust (all functional). Java, Kotlin marked **Coming soon**.
- **Framework picker** — filtered to selected language. All frameworks have generators.
- **Database, Cache, Queue, Auth, CI/CD, Monitoring, Deployment** — selectable options stored in Zustand `StackConfig`.
- **API type** — REST and gRPC are functional generators. GraphQL and tRPC marked **Coming soon**.
- **Security toggles** — Rate limit, tracing, audit log flags in config (included in generated code).
- **AI recommendations panel** — calls `POST /api/ai/suggest`; returns stack-aware suggestions via Claude.
- **Save / auto-save** — `POST /api/projects`, `PATCH /api/projects/:id`. Auto-saves on page unmount. Manual "Save" button in topbar.
- **Load saved project** — from Dashboard or the builder's own project list dropdown.

### API Builder (`/api-builder`)
- Define REST/gRPC endpoints: method, path, summary, auth flag, request/response JSON schema.
- Endpoints stored in Zustand `endpoints[]`. Included in zip generation.
- **Pattern-based endpoints** — select from named patterns (CRUD, paginated search, aggregate stats, cache read, auth flow). Generates idiomatic handlers per language/framework.

### Code Generator (`POST /api/generate`)
Produces a downloadable zip of a real, buildable repository. Streams as `application/zip`.

**Go** (gin, fiber, echo, chi):
- `cmd/api/main.go` — graceful shutdown, signal handling
- `internal/server/server.go` — framework-specific HTTP server
- `internal/config/config.go` — env-var config via `caarlos0/env`
- `internal/server/middleware.go` — request ID, structured logging, CORS, auth
- `internal/server/health.go` — `/health` endpoint
- `internal/auth/jwt.go` — JWKS-based JWT verification (when auth enabled)
- `internal/db/gorm.go` + `internal/db/sql.go` — database adapters
- `internal/models/models.go` — GORM struct models from entity definitions
- `internal/handlers/<entity>.go` + `_test.go` — CRUD handlers with in-memory SQLite tests
- gRPC mode: proto file, generated stubs, buf config
- Dockerfile (multi-stage, distroless final image)
- `go.mod` with pinned dependency versions

**TypeScript** (nestjs, express, fastify, hono):
- `src/main.ts` — framework bootstrap, graceful shutdown
- Entity CRUD: controllers, services, Prisma models, route files
- `vitest` unit tests with vi.fn() mocks
- `tsconfig.json`, `package.json` with correct devDependencies (including `@nestjs/testing` for NestJS)
- Dockerfile (proper two-stage: `npm ci` all deps to build, `npm ci --omit=dev` in runtime)

**Python** (fastapi, django, litestar):
- `app/main.py` — FastAPI/Litestar/Django bootstrap with lifespan hooks
- `app/config.py` — pydantic-settings
- `app/models.py` — SQLAlchemy ORM models
- `app/routers/<entity>.py` — CRUD routers
- `app/auth.py` — PyJWT JWKS verification (when auth enabled; conditionally imported)
- `app/logging_config.py` — JSON structured logging
- `tests/conftest.py` + `tests/test_<entity>.py` — pytest with in-memory SQLite
- `pyproject.toml` — proper Poetry format with `[tool.poetry]` + `[build-system]`
- Dockerfile — Poetry install with `--without dev`

**Rust** (axum, actix):
- Basic HTTP server scaffold, Dockerfile

**Common (all languages)**:
- `README.md` with architecture overview
- `QUICKSTART.md` — 7 steps: unzip → install deps → env vars → start deps → migrate → run → test
- `.env.example` — all required env vars documented
- `docker-compose.yml` — postgres/redis/rabbit/kafka services
- GitHub Actions CI workflow (lint + test + build)
- Kubernetes manifests (when K8s enabled): Deployment, Service, HPA, ConfigMap
- Helm chart skeleton (when Helm enabled)
- OpenAPI spec (`openapi.yaml`)
- Database migration files (SQL + language-specific runner)
- Client SDK stub

### Preview (`/preview`)
- File tree browser of all generated files.
- Syntax-highlighted code view per file.
- **Monaco editor** — toggle between view and edit mode per file. Edits stored as `overrides` in component state.
- **Edit-before-download** — overrides merged server-side before zip is streamed. "N edited" badge in topbar.
- **Download zip** — `DownloadRepoButton` POSTs config + endpoints + entities + overrides to `/api/generate`.

### Railway Deploy (`/deploy`)
Full end-to-end automated deploy to Railway:
1. Generate repository files in memory
2. Push to a new GitHub repo (via `POST /api/github/push`)
3. Create Railway project via GraphQL API
4. Create Railway service linked to the GitHub repo
5. Set environment variables on the service
6. Provision a public domain

- **Streaming progress** — `POST /api/deploy/stream` emits SSE events (`stage`, `progress`, `warn`, `error`, `done`).
- **Prerequisites check** — GitHub connected + Railway token saved, shown before deploy button.
- **Deploy history** — reads GitHub Actions workflow runs for a connected repo. Polls every 10s while a run is live.
- **Branch protection display** — shows `main`/`staging` branch rules from git config.
- **Other providers** (Vercel, Render, Fly, AWS, GCP, Azure, K8s) — **Coming soon**. Non-selectable in UI.

### From Repo (`/from-repo`)
Import an existing GitHub repo and detect its stack:
- Paste any GitHub URL (https, SSH, bare).
- Optional GitHub PAT for private repos (falls back to `github_token` cookie).
- Fetches 12 probe files via `raw.githubusercontent.com` (no rate-limit bucket). Falls back to REST API for private repos.
- **Heuristic detection** — pure-function analysis in `src/lib/repo-analyzer.ts`: language, framework, database, cache, queue, auth, CI/CD, Docker, Kubernetes.
- **LLM enrichment** — optional Claude Haiku pass to fill in fields the heuristics couldn't determine (medium-confidence only; high-confidence heuristics always win).
- **Override UI** — per-field `<select>` for non-high-confidence detections.
- **"Load into builder"** — `patch(config)` into Zustand + navigate to `/builder`.
- **"Preview generated files"** — `patch(config)` + navigate to `/preview`.

### Templates (`/templates`)
- 6 pre-built templates: Go REST (Gin+PG+Redis), TS Express+PG, Python FastAPI+PG, Go Fiber+MongoDB, TS NestJS+PG (SaaS), TS Hono+Neon.
- Search by name/description.
- Language filter (All / Go / TypeScript / Python).
- "Use template" button loads config into Zustand + navigates to builder.

### Gallery (`/gallery`)
- Community-submitted stacks stored in SQLite `gallery_stacks` table.
- `GET /api/gallery` — list with language filter + text search + pagination.
- `POST /api/gallery` — authenticated; submit current stack (rate-limited to 10/min).
- Star a stack (`PATCH /api/gallery/:id/star`). Delete own stack.
- "Fork" — loads stack config into Zustand + navigates to builder.

### Code Editor (`/editor`)
- Connect a GitHub repo by URL.
- Browse the full file tree (GitHub Contents API, lazy-loaded directories).
- View any file in Monaco with syntax highlighting.
- Edit a file and commit the change directly to GitHub (`POST /api/github/commit`).
- Stack detection banner — shows detected language/framework from repo files.

### Dashboard (`/dashboard`)
- Recent projects list (from SQLite, sorted by `updated_at`). Click to load into builder.
- Quick actions: New stack, Import from repo, Templates, Deploy.
- Team projects section — fetches `/api/teams`, shows all team members' projects grouped by team.
- Stats: total project count from `/api/stats`.

### Settings (`/settings`)
- **Profile** — update name, change password (current password required).
- **LLM API key** — save personal Anthropic key (encrypted AES-256-GCM in DB). Used instead of server key for AI chat/suggest.
- **GitHub integration** — connect/disconnect GitHub OAuth. Shows connected account name.
- **Railway integration** — save/delete Railway Personal API Token (encrypted in DB).
- **Teams** — create team, invite members by email (generates invite link), view/remove members.
- **Danger zone** — delete account (cascades to all projects/sessions).

### Teams
- `POST /api/teams` — create team.
- `GET /api/teams/:id` — get team + members.
- `POST /api/teams/:id/invite` — generate invite token (24h expiry).
- `GET /api/invites/:token` — accept invite page.
- `DELETE /api/teams/:id/members/:userId` — remove member.
- `GET /api/teams/:id/projects` — list all projects for team members.

### AI Assistant
- **Floating panel** (all workspace pages) — opens `AIAssistant` component.
- **Stack copilot** — `POST /api/ai/chat` streams Claude Sonnet 4.6 responses. System prompt includes current `StackConfig` as cached ephemeral block. SSE stream.
- **Suggestions** — `POST /api/ai/suggest` returns structured recommendations.
- **Logic generation** — `POST /api/ai/generate-logic` generates handler logic for a specific endpoint.
- **Missing API key** — graceful 503 with banner; never crashes UI.

### Git Settings (`/git-settings`)
- Configure default branch, PR strategy, protected branch patterns.
- Deploy environment definitions (production, staging) with target branches.
- Included in generated CI/CD workflow files.

---

## 2. Manual Test Plan

Test in order. Each section is a discrete flow. Use a fresh account unless noted.

### Auth Flow
1. **Signup** — go to `/signup`, create account with email + password. Expect redirect to `/dashboard`.
2. **Login** — sign out, go to `/login`, log back in. Expect redirect to `/dashboard`.
3. **Protected routes** — while logged out, visit `/builder`. Expect redirect to `/login?returnTo=/builder`. After login, expect redirect back to `/builder`.
4. **Forgot password** — click "Forgot password", enter email, check that a reset token is created (check server logs or DB). Visit reset link, set new password, log in with new password.
5. **GitHub OAuth** — click "Connect GitHub" in Settings. Authorize. Expect `github_token` cookie set and connected account shown.

### Core Build → Download Flow
6. **Builder — Go/Gin/Postgres** — select Go → Gin → Postgres → REST. Name project "test-go". Click Save. Expect success toast.
7. **Navigate to Preview** — click the preview/download CTA in builder. Expect file tree with `go.mod`, `cmd/api/main.go`, `Dockerfile`, `internal/server/server.go`, etc.
8. **Edit a file** — click edit on `README.md`, change a line, click save. Expect "1 edited" badge in topbar.
9. **Download zip** — click Download. Expect `test-go.zip` download starts. Unzip locally, confirm files are present and the edited README reflects the change.
10. **TypeScript/NestJS/Postgres** — repeat steps 6–9 with TypeScript → NestJS → Postgres. Confirm `package.json` has `@nestjs/testing` in devDependencies. Confirm Dockerfile has two FROM stages.
11. **Python/FastAPI/Postgres** — repeat with Python → FastAPI → Postgres. Confirm `pyproject.toml` has `[tool.poetry]` + `[build-system]`. Confirm `app/main.py` does not import `auth_required` (no auth selected).

### API Builder
12. **Add endpoint** — go to `/api-builder`, add `GET /users/:id`. Name it "Get user". Save.
13. **Verify in generated zip** — go back to Preview, download. Confirm the endpoint appears in `openapi.yaml` and in the relevant handler file.
14. **Pattern endpoint** — add a CRUD pattern for entity "Post". Download. Confirm CRUD routes and handler are generated.

### Entity Builder
15. **Add entity** — in builder, add entity "Order" with fields: id (uuid, pk), total (number, required), status (string). Download. Confirm `internal/models/models.go` has `Order` struct (Go) or Prisma model (TS).

### From Repo
16. **Public repo** — paste `https://github.com/gin-gonic/gin`. Expect language=Go, framework=gin detected at high confidence. Click "Load into builder". Expect builder pre-filled.
17. **Private repo** — paste a private repo URL with a valid PAT. Expect files fetched and stack detected.
18. **Invalid URL** — paste `https://github.com/notareal/repo999`. Expect 404 error state, not a crash.

### Templates
19. **Browse templates** — go to `/templates`. Confirm 6 cards visible. Filter by "Go" — expect 2 cards.
20. **Use template** — click "Use template" on "Go REST API". Expect builder loaded with Go/Gin/Postgres/Redis config.

### Gallery
21. **Submit to gallery** — build a Go/Gin stack, go to `/gallery`, submit with a title. Expect it appears in the list.
22. **Star a stack** — star any gallery item. Expect star count increments.
23. **Fork** — click fork on any gallery item. Expect builder loaded with that config.

### Railway Deploy
24. **Prerequisites** — go to `/deploy` without GitHub connected. Expect "GitHub not connected" prereq row with a "Connect →" link.
25. **Connect GitHub** — connect via Settings. Return to `/deploy`. Expect GitHub row turns green.
26. **Add Railway token** — go to Settings → Integrations → add Railway token. Return to `/deploy`. Expect Railway row turns green. Deploy button becomes active.
27. **Deploy** — click "Deploy to Railway". Watch 5-stage progress: push → project → service → variables → domain. On success, expect Railway project URL and GitHub repo URL displayed.
28. **Deploy history** — connect a GitHub repo in the Deploy History card. Expect workflow runs listed with status badges. Confirm it polls while a run is in_progress.

### AI Assistant
29. **Chat** — open the floating AI panel on any page. Type "What database should I use for a social app?" Expect a relevant response streamed in.
30. **Stack-aware response** — in builder with Go/Gin/MongoDB selected, ask "Is MongoDB a good fit for this stack?" Expect the answer to reference the current config.
31. **Missing API key** — remove `ANTHROPIC_API_KEY` from `.env.local`. Restart. Open AI panel. Expect a banner saying the key is missing, not a crash.

### Settings
32. **Change password** — go to Settings → Profile. Change password. Sign out. Sign in with new password. Confirm it works.
33. **LLM key** — save a personal Anthropic key. Use AI chat. Confirm it works (check logs to verify the user key is used, not server key).
34. **Delete account** — create a throwaway account, go to Settings → Danger Zone, delete it. Confirm you are signed out and cannot log back in.

### Teams
35. **Create team** — go to Settings → Teams → Create team "Test Team".
36. **Invite** — click Invite, copy the invite link. Open it in a different browser (logged in as a different user). Accept. Confirm the new member appears in the team list.
37. **Team projects** — the invitee creates a project. The team owner goes to Dashboard. Confirm the invitee's project appears under "Test Team" in the team projects section.

### Code Editor
38. **Connect repo** — go to `/editor`, paste a GitHub repo URL. Expect file tree loads.
39. **Browse files** — expand a directory. Click a file. Expect Monaco editor shows content with syntax highlighting.
40. **Edit and commit** — edit a file, click "Commit". Expect a new commit appears on GitHub.

---

## 3. Critical Missing Features

### P0 — Blocks real usage

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Onboarding flow** | ✅ Done | `localStorage`-gated 2-step modal on `/dashboard`. Checks `helios_onboarded`. Sets language and navigates to builder. |
| 2 | **Email delivery for password reset** | ❌ Open | Reset tokens are created but never emailed. Wire `nodemailer` or Resend into `POST /api/auth/forgot-password`. Needs `SMTP_*` or `RESEND_API_KEY` env vars. |
| 3 | **Generated code actually builds** | ✅ Done | `.github/workflows/ci.yml` has a `smoke-build` matrix job covering Go, TypeScript, Python, Rust, Java, Kotlin. Generates a repo and runs the language toolchain against it. |
| 4 | **Project config persists in builder** | ✅ Done | Zustand persist middleware writes to `localStorage`. Builder fires a debounced silent `saveCurrentProject()` 2s after any config/endpoint/entity change. |

### P1 — Significant UX gaps

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 5 | **More templates + filters** | ✅ Done | 12 templates in `src/data/templates.ts`. Templates page now has category filter (REST API, Microservice, SaaS, E-commerce, CMS, Cache Service) and difficulty filter (Beginner / Intermediate / Advanced). Difficulty badge shown on each card. |
| 6 | **Deploy to Render / Fly.io** | ❌ Open | Railway is the only live deploy target. Render: `POST /api/v1/services`. Fly: `flyctl` CLI or GraphQL API. |
| 7 | **Builder quick mode** | ✅ Done | Collapsible "Quick start" panel at top of builder — name + language + database → "Preview & download" in one click. |
| 8 | **Git & CI/CD page accessible** | ✅ Done | "Configure branch rules & PR strategy →" link added to the CI/CD section of the builder. Links to `/git-settings`. |

### P2 — Polish and completeness

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 9 | **GraphQL code generation** | ❌ Open | Marked coming soon in UI. Needs schema SDL, resolver scaffold, and `graphql-yoga` / `gqlgen` integration. |
| 10 | **tRPC code generation** | ✅ Done | Full tRPC v11 generator for TypeScript. Emits `src/trpc.ts`, `src/router.ts`, `src/server.ts`, `src/client.ts`, `src/types.ts`. One procedure per endpoint (GET → query, mutations → mutation). Entity CRUD procedures included when entities are defined. |
| 11 | **Java / Kotlin generators** | ❌ Open | Generators exist but are less complete than Go/TS/Python. Need full entity, test, and Dockerfile output verified. |
| 12 | **Team project sharing** | ❌ Open | Teams can see each other's projects but cannot edit them. Needs `project_shares` DB table + permission checks on project API routes + share UI. |
| 13 | **Gallery moderation** | ✅ Done | Report button (Flag icon) on non-owned gallery cards. `POST /api/gallery/[id]/report` route. `gallery_reports` table in SQLite. Rate-limited to 5/user. |
| 14 | **Audit log middleware** | ✅ Done | `audit: true` flag now wires a real `auditLog` middleware in all 4 Go frameworks (gin/fiber/echo/chi) and Express. Logs method, path, status, IP via `slog`. Express also emits `src/middleware/audit.ts`. |
| 15 | **Monitoring integration** | ✅ Done | All 3 languages now emit real monitoring bootstraps: Go emits `internal/monitoring/metrics.go` (Prometheus), `sentry.go`, or `datadog.go` + updates `go.mod`. Express adds `prom-client`/`@sentry/node`/`dd-trace` to `package.json` + imports in `main.ts` + `/metrics` endpoint. FastAPI adds `prometheus-fastapi-instrumentator`/`sentry-sdk`/`ddtrace` to `pyproject.toml` + instruments the app. |

---

## 4. Architecture Notes for Agents

### Key files
- `src/lib/store.ts` — Zustand store. `StackConfig` is the single source of truth for builder state.
- `src/lib/generators/index.ts` — `generate(config, endpoints, entities) → GeneratedFile[]`. Entry point for all code generation.
- `src/lib/generators/common.ts` — Files shared across all languages (README, QUICKSTART, Dockerfile, docker-compose, K8s, Helm, CI, OpenAPI).
- `src/lib/deploy-pipeline.ts` — Async generator that runs the Railway deploy stages, emitting `PipelineEvent` objects.
- `src/lib/db.ts` — All SQLite DB access. No ORM — raw `better-sqlite3`.
- `src/lib/auth.ts` — `getCurrentUser(req)` extracts and verifies the JWT from the `helios_token` cookie.
- `src/middleware.ts` — Next.js middleware. Protects `/dashboard`, `/builder`, `/preview`, `/deploy`, `/settings`, `/from-repo`, etc.

### Conventions
- API routes validate input with Zod. Never trust `req.json()` directly.
- Auth in API routes: always call `getCurrentUser(req)` first; return 401 if null.
- Rate limiting: call `checkRateLimit(getRateLimitKey(req), N)` at the top of sensitive routes.
- Generators return `GeneratedFile[]` — `{ path: string, content: string }`. Paths are POSIX (forward slashes). No binary files.
- AI calls: use `claude-haiku-4-5-20251001` for fast/cheap enrichment, `claude-sonnet-4-6` for the main copilot.
- All `updated_at` timestamps from SQLite are Unix epoch **seconds** — multiply by 1000 before passing to `new Date()`.

### Environment variables required
```
ANTHROPIC_API_KEY       # Optional at build time, required for AI features
JWT_SECRET              # Required. Min 32 chars.
ENCRYPTION_KEY          # Required. 32-byte hex for AES-256-GCM (deploy creds + LLM keys).
GITHUB_CLIENT_ID        # Required for GitHub OAuth.
GITHUB_CLIENT_SECRET    # Required for GitHub OAuth.
NEXT_PUBLIC_APP_URL     # Required. Used for OAuth callback URL.
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  # Needed for password reset emails (P0 gap).
```

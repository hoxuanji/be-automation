# Helios — Roadmap & Product Knowledge Base

> **Purpose:** Single source of truth for agents and contributors. Covers what is built, how to verify it works, and what to build next. Update this file when features ship or gaps are closed.

---

## 1. What's Built

### Authentication (SSO-only)
- **GitHub OAuth** — `GET /api/auth/github` → callback → creates or links a user keyed off `github_id`, issues a JWT, sets the `helios_token` cookie. The same route powers "connect GitHub to an existing session" via `?mode=connect`.
- **Bitbucket OAuth** — `GET /api/auth/bitbucket` → callback → mirror of the GitHub flow, keyed off `bitbucket_id`. Tokens stored in a `bitbucket_token` cookie. State parameter is HMAC-signed with a `bb:` prefix so a state from one provider can't replay against the other's callback.
- **No email/password flow** — signup, login, forgot-password and reset-password were removed. Helios is SSO-only: signing in with either provider on first use creates the account; subsequent sign-ins resolve by provider id (with email match as a fallback so users who connect both providers get a single account). No passwords stored, no reset emails to deliver.
- **JWT middleware** — `src/middleware.ts` protects all workspace routes. Redirects unauthenticated users to `/login?returnTo=...`. The login page now renders only "Continue with GitHub" / "Continue with Bitbucket" buttons.
- **Session invalidation** — sessions tracked in SQLite; `DELETE /api/auth/logout` deletes the session row.
- **Stale-session auto-recovery** — `GET /api/auth/me` detects when a browser has a valid JWT cookie but no matching session row (e.g. after a DB wipe or server restart) and returns a `Set-Cookie` clear header. `loadAuth` in the Zustand store then redirects to `/login` when `user` is null on a protected route, preventing a state where the app loads but every API call returns 401.
- **Topbar identity** — "Signed in as" dropdown shows the user's display name (populated from SSO provider on login) and email beneath it. The avatar renders initials; `??` is shown only transiently while `loadAuth` is in flight.

### Database (SQLite via better-sqlite3)
Tables: `users` (with `github_id` + `bitbucket_id` columns), `sessions`, `projects`, `project_shares`, `deploy_creds`, `teams`, `team_members`, `team_invites`, `gallery_stacks`, `gallery_reports`, `rate_limits`. The legacy `password_reset_tokens` table is no longer created on new dbs (existing dbs keep it as dead weight; nothing reads it).

### Stack Builder (`/builder`)
- **Layout** — 10-tab horizontal scrollable bar: Runtime, Database, Cache, Queue, APIs, Security, Deployment, Scaling, CI/CD, Monitoring. Active tab underlined in brand color; tabs scroll horizontally on narrow viewports.
- **Language picker** — Go, TypeScript, Python, Rust, Java, Kotlin (all functional). Each language has working REST + Dockerfile + K8s + CI generation; Java and Kotlin pick up Spring Security + Flyway out of the box.
- **Framework picker** — filtered to selected language. All frameworks have generators.
- **Database, Cache, Queue, Auth, CI/CD, Monitoring, Deployment** — selectable options stored in Zustand `StackConfig`.
- **API type** — REST, gRPC, GraphQL, and tRPC are all fully implemented — no "coming soon" badges. GraphQL emits a real server for Go (gqlgen), TypeScript (graphql-yoga), and Python (Strawberry); Rust/Java/Kotlin fall back to REST with a README banner. tRPC is TypeScript-only — the tile shows a "TS only" badge and is non-selectable for other languages.
- **`owner` field in StackConfig** — populated automatically from the authenticated user's GitHub username on login. Used in generated Docker image tags (`ghcr.io/{owner}/{name}`), K8s manifests, Helm chart image repository, and CI workflow push tags. Falls back to `"your-org"` if unset (new projects before first login).
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
- GraphQL mode: `gqlgen.yml`, `graph/resolver.go`, per-entity `<entity>.resolvers.go`, Makefile target `make gql`, gqlgen playground at `/`
- Dockerfile (multi-stage, distroless final image)
- `go.mod` with pinned dependency versions

**TypeScript** (nestjs, express, fastify, hono):
- `src/main.ts` — framework bootstrap, graceful shutdown
- Entity CRUD: controllers, services, Prisma models, route files
- `vitest` unit tests with vi.fn() mocks
- `tsconfig.json`, `package.json` with correct devDependencies (including `@nestjs/testing` for NestJS)
- gRPC mode: @grpc/grpc-js server with proto-loader, grpc-health-check, graceful shutdown
- tRPC mode: typedefs + router + Express adapter + typed client
- GraphQL mode: graphql-yoga server with framework adapter (Express/NestJS use express; Fastify and Hono get native adapters), DateTime + JSON scalars, per-entity in-memory resolvers
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
- gRPC mode: grpcio server with health + reflection, multi-stage Dockerfile compiling protos at build time
- GraphQL mode: Strawberry schema with type/input per entity, in-memory dict store, mounted on FastAPI at `/graphql`
- Dockerfile — Poetry install with `--without dev`

**Rust** (axum, actix):
- HTTP server with tracing-subscriber JSON logging, sqlx with retry, distroless Dockerfile, graceful shutdown via tokio::signal. GraphQL not yet generated — README banner explains the fallback to REST.

**Java** (spring, quarkus) and **Kotlin** (ktor, spring-kt):
- Spring Security OAuth2 Resource Server, Flyway migrations, HikariCP pool tuning, logstash-logback-encoder for JSON logs, non-root multi-stage Dockerfile. GraphQL not yet generated — README banner explains the fallback to REST.

**Common (all languages)**:
- `README.md` with architecture overview (auto-includes a banner when gRPC/GraphQL was requested on an unsupported language)
- `QUICKSTART.md` — 7 steps: unzip → install deps → env vars → start deps → migrate → run → test
- `.env.example` — all required env vars documented, secrets redacted via heuristic
- `docker-compose.yml` — postgres/redis/rabbit/kafka services with healthchecks + service_healthy gating
- GitHub Actions CI workflow (lint + test + build, plus gitleaks + CodeQL security pass)
- Kubernetes manifests (when K8s enabled): Deployment, Service, HPA, ConfigMap, PodDisruptionBudget when replicas>1, language-aware resource profiles, native gRPC probes, non-root securityContext
- Helm chart with Bitnami OCI dependencies (postgresql/mysql/mongodb/redis/rabbitmq) and condition toggles
- OpenAPI spec (`openapi.yaml`)
- `graphql/schema.graphql` (when api=graphql) — same SDL drives Go gqlgen, TS yoga, and Python Strawberry; client codegen can target the same file
- Database migration files (SQL + language-specific runner: golang-migrate, Alembic, sqlx, Flyway, or Prisma seed)
- Client SDK stub (TypeScript + Python typed clients derived from the endpoint list)
- Contract tests — one test file per endpoint, covering status codes + content-type

### Preview (`/preview`)
- File tree browser of all generated files.
- Syntax-highlighted code view per file.
- **Monaco editor** — toggle between view and edit mode per file. Edits stored as `overrides` in component state.
- **Edit-before-download** — overrides merged server-side before zip is streamed. "N edited" badge in topbar.
- **Download zip** — `DownloadRepoButton` POSTs config + endpoints + entities + overrides to `/api/generate`.

### One-click Deploy (`/deploy`)
Full end-to-end automated deploys to **Railway**, **Render**, **Fly**, and **Vercel**. The flow:
1. Generate repository files in memory
2. Push to a new GitHub repo (via `POST /api/github/push`)
3. Provision the provider-specific resource (Railway project + service, Render web service, Fly app, or Vercel project)
4. Set environment variables / secrets
5. Surface a public hostname or a one-line follow-up command

- **Provider clients** — `src/lib/railway.ts`, `src/lib/render.ts`, `src/lib/fly.ts`, `src/lib/vercel.ts`. Each has a typed error class with retry-aware codes (`not_authorized`, `rate_limited`, `validation`, `network_error`, `conflict`, `server_error`).
- **Pipelines** — `runDeployPipeline` (Railway), `runRenderDeployPipeline`, `runFlyDeployPipeline`, `runVercelDeployPipeline` are async generators that yield `PipelineEvent`s. Identical first stage (GitHub push); diverge on provider provisioning.
- **Streaming progress** — `POST /api/deploy/stream` dispatches by `provider` in the body and emits SSE events (`stage`, `progress`, `warn`, `error`, `done`). Accepts `"railway" | "render" | "fly" | "vercel"`.
- **JSON adapters** — `/api/railway/deploy`, `/api/render/deploy`, `/api/fly/deploy`, `/api/vercel/deploy` drain the same generators into a single JSON response.
- **Verification probes** — `/api/railway/verify`, `/api/render/verify`, `/api/fly/verify`, `/api/vercel/verify` confirm a token is live and surface the user identity / org slug for Settings → Integrations.
- **Provider differences** — Render and Vercel auto-deploy on first build via the GitHub repo connection; Fly's git-driven flow is user-driven, so the pipeline returns a `nextStep` instruction with a one-liner like `flyctl deploy` rather than building automatically. Vercel requires the Vercel GitHub App to be installed on the account/org that owns the pushed repo — the pipeline throws `vercel_no_github` with an install link if it isn't.
- **Prerequisites check** — GitHub connected + provider token saved, shown before the deploy button.
- **Deploy history** — reads GitHub Actions workflow runs for a connected repo. Polls every 10s while a run is live.
- **Branch protection display** — shows `main`/`staging` branch rules from git config.
- **Other providers** (AWS, GCP, Azure, K8s) — **Coming soon**. Non-selectable in the deploy UI; CLI guide shown instead.

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
- 16 pre-built templates spanning Go, TypeScript, Python, Rust, and Java. Recent additions: Rust Axum REST + Postgres, Java Spring Boot REST + Postgres, TS Realtime Chat (Hono + WebSocket + MongoDB), Background Job Worker (TS Express + RabbitMQ + Redis).
- Search by name/description.
- Language filter (All / Go / TypeScript / Python / Rust / Java).
- Category filter (REST API / Microservice / SaaS / E-commerce / CMS / Cache Service / Real-time) and difficulty filter (Beginner / Intermediate / Advanced).
- "Use template" button loads config + endpoints + entities into Zustand and navigates to builder.

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
- Recent projects list (from SQLite, sorted by `updated_at`). Click to load into builder. Each card has a Share button (owner-only, opens `ShareProjectDialog`).
- Quick actions: New stack, Import from repo, Templates, Deploy.
- **Shared with me** section — fetches `/api/shared-with-me`, shows projects others have granted access to, with view/edit badge and owner attribution.
- Team projects section — fetches `/api/teams`, shows all team members' projects grouped by team with effective permission badge per row.
- Stats: total project count from `/api/stats`.

### Settings (`/settings`)
- **Profile** — update display name and email (both pulled from the SSO provider on first sign-in; users can correct typos here).
- **LLM API key** — save personal Anthropic key (encrypted AES-256-GCM in DB). Used instead of server key for AI chat/suggest.
- **GitHub integration** — connect/disconnect GitHub OAuth. Shows connected account name.
- **Bitbucket integration** — connect/disconnect Bitbucket OAuth. Same surface as GitHub for SSO sign-in or attaching to an existing account.
- **Deploy provider integrations** — save/delete encrypted tokens for Railway (Personal API Token), Render (Personal API Key), Fly (Personal Access Token), and Vercel (Personal Access Token). Each row verifies the token against the provider's API before saving and surfaces the connected identity (email / username / org slug).
- **Teams** — create team, invite members by email (generates invite link), view/remove members.
- **Danger zone** — delete account (cascades to all projects/sessions).

### Teams
- `POST /api/teams` — create team.
- `GET /api/teams/:id` — get team + members.
- `POST /api/teams/:id/invite` — generate invite token (24h expiry).
- `GET /api/invites/:token` — accept invite page.
- `DELETE /api/teams/:id/members/:userId` — remove member.
- `GET /api/teams/:id/projects` — list all projects for team members, each tagged with the caller's effective permission (`owner` / `edit` / `view`).

### Project sharing
- **`project_shares`** table — explicit row per (project, principal, permission). Principal is either a single user or a whole team; the CHECK constraint enforces exactly one.
- **`POST /api/projects/:id/shares`** — owner-only. Body: `{ principal: { type: "user"|"team", ... }, permission: "view"|"edit" }`. Owners must be a member of any team they share with.
- **`GET /api/projects/:id/shares`** — owner-only list of active shares.
- **`DELETE /api/projects/:id/shares/:shareId`** — owner-only revoke.
- **`GET /api/shared-with-me`** — projects shared with the current user (directly or via team membership), with effective permission and owner name attached.
- **`src/lib/permissions.ts`** is the single source of truth for access decisions: `getProjectAccess(projectId, userId)` returns `"owner" | "edit" | "view" | null`. All project routes go through this — no inline `WHERE user_id = ?` filters remain. Owners always win; otherwise direct user shares and team shares are merged with the highest permission winning.
- **`ShareProjectDialog`** — Radix Dialog mounted on each owned project card on the dashboard. Owner picks team + permission, sees active shares, can revoke.

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

### Auth Flow (SSO-only)
1. **GitHub sign-in** — go to `/login`. Expect two SSO buttons (GitHub + Bitbucket) and no email/password form. Click "Continue with GitHub". Authorize. Expect redirect to `/dashboard` and `helios_token` + `github_token` cookies set.
2. **Bitbucket sign-in** — sign out, return to `/login`, click "Continue with Bitbucket". Authorize. Expect redirect to `/dashboard` and `helios_token` + `bitbucket_token` cookies set. The created user has `bitbucket_id` populated.
3. **Account linking** — sign in with one provider, then connect the other from Settings → Integrations. Expect a single user row with both `github_id` and `bitbucket_id` set (verify via `GET /api/auth/me`).
4. **Protected routes** — while logged out, visit `/builder`. Expect redirect to `/login?returnTo=/builder`. After SSO completes, expect redirect back to `/builder`.
5. **Removed routes** — confirm `/signup`, `/forgot-password`, `/reset-password`, `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password` all return 404.

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
19. **Browse templates** — go to `/templates`. Confirm 16 cards visible. Filter by "Go" — expect 4 cards. Filter by "Rust" — expect 1 card (the new Axum template). Filter by category "Real-time" — expect 1 card (the new Hono chat template).
20. **Use template** — click "Use template" on "Go REST API". Expect builder loaded with Go/Gin/Postgres/Redis config, plus the template's endpoints + entities populated.
20a. **New templates** — click "Use template" on Rust Axum REST + Postgres, Java Spring Boot REST + Postgres, TS Realtime Chat (Hono + MongoDB), and Background Job Worker (TS + RabbitMQ). For each, confirm the builder loads with the right language/framework/entities and that "Preview generated files" produces a buildable repo.

### Gallery
21. **Submit to gallery** — build a Go/Gin stack, go to `/gallery`, submit with a title. Expect it appears in the list.
22. **Star a stack** — star any gallery item. Expect star count increments.
23. **Fork** — click fork on any gallery item. Expect builder loaded with that config.

### One-click Deploy
24. **Prerequisites** — go to `/deploy` without GitHub connected. Expect "GitHub not connected" prereq row with a "Connect →" link.
25. **Connect GitHub** — connect via Settings. Return to `/deploy`. Expect GitHub row turns green.
26. **Add provider token** — go to Settings → Integrations → pick Railway / Render / Fly / Vercel → paste a token. The Settings panel verifies the token against the provider's API before saving and shows the connected identity. Return to `/deploy`. Provider row turns green; Deploy button becomes active.
27. **Deploy to Railway** — pick Railway in the provider grid, click "Deploy to Railway". Watch 5-stage progress: push → project → service → variables → domain. On success, expect Railway project URL and GitHub repo URL displayed.
27a. **Deploy to Render** — pick Render in the provider grid, click "Deploy to Render". Watch 3-stage progress: push → owner → service. Expect a Render dashboard link; the public URL becomes visible once the first build finishes.
27b. **Deploy to Fly** — pick Fly in the provider grid, click "Deploy to Fly". Watch 5-stage progress: push → org → app → secrets → handoff. Expect the success card to surface a `flyctl deploy` one-liner and a hostname like `https://<repo>.fly.dev` that activates after the first build.
27c. **Deploy to Vercel** — ensure the Vercel GitHub App is installed at vercel.com/integrations/github. Pick Vercel in the provider grid, click "Deploy to Vercel". Watch 4-stage progress: push → project → env → domain. Expect `https://<name>.vercel.app` in the success card; Vercel dashboard link also surfaced. If the GitHub App isn't installed, expect a `vercel_no_github` error with an install link hint — not a crash.
28. **Deploy history** — connect a GitHub repo in the Deploy History card. Expect workflow runs listed with status badges. Confirm it polls while a run is in_progress.
29. **Token rejection** — replace a saved token with a string that's syntactically valid but unauthorized (paste 30 random hex chars). Save → expect a structured error toast with hint, not a crash. Then deploy with the bad token still in place — the deploy button is gated, but if you bypass via API the error stage shows "rejected the saved token" with the same hint.

### AI Assistant
29. **Chat** — open the floating AI panel on any page. Type "What database should I use for a social app?" Expect a relevant response streamed in.
30. **Stack-aware response** — in builder with Go/Gin/MongoDB selected, ask "Is MongoDB a good fit for this stack?" Expect the answer to reference the current config.
31. **Missing API key** — remove `ANTHROPIC_API_KEY` from `.env.local`. Restart. Open AI panel. Expect a banner saying the key is missing, not a crash.

### Settings
32. **Update profile** — go to Settings → Profile. Change display name + email. Save. Refresh — confirm the new values stick. (Helios is SSO-only — there is no password to change.)
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

### Project sharing
41. **Share with team (view)** — as owner, on a saved project card click the Share icon. Pick a team, leave permission at "view", click Share. Confirm a row appears in "Active shares" with the team name and a `view` badge.
42. **Recipient sees it** — sign in as a member of that team in another browser. On the dashboard, expect a "Shared with me" section with the project, owner name, `view` badge, and "via team" label. Click — expect builder loads with the project content.
43. **Read-only enforcement** — as the recipient (view-only), attempt to PATCH the project (rename or save). Expect a 403 response (browser network panel). Owner-only delete is hidden.
44. **Upgrade to edit** — owner returns to dashboard, opens Share dialog, revokes the view share, and creates a new share with permission `edit` for the same team. Recipient refreshes — saving now succeeds.
45. **Direct user share** — in a future UI iteration, an owner could pick a specific team member instead of the whole team. The API already accepts `principal: { type: "user", userId }`; the dialog defaults to team-based shares to keep the surface small.
46. **Revoke** — owner clicks the trash icon on an active share. Confirm the share disappears and the recipient's next save returns 403 without crashing the builder.

### GraphQL generation
47. **TypeScript + GraphQL** — in the builder, set api=GraphQL with TS + Express + Postgres + entities. Click "Preview generated files". Expect `graphql/schema.graphql`, `src/main.ts`, `src/schema.ts`, `src/resolvers.ts`, `src/scalars.ts`, and per-entity resolver files. Download → `npm install` → `npm run dev` → hit `http://localhost:4000/graphql` for GraphiQL. Run `{ health }` query and a per-entity `list<Entities>` query.
48. **Go + GraphQL** — set api=GraphQL with Go + Gin + Postgres + entities. Confirm `gqlgen.yml`, `graph/resolver.go`, per-entity `<entity>.resolvers.go`, and the Makefile target `make gql`. After `make gql && go run ./cmd/api`, expect the gqlgen playground to load on `:4000`.
49. **Python + GraphQL** — set api=GraphQL with Python + FastAPI + Postgres + entities. Confirm `app/schema.py` (Strawberry), `app/graphql_store.py`, and a `/graphql` mount in `app/main.py`. `poetry install && uvicorn app.main:app` should serve the schema with Strawberry's GraphiQL.
50. **Unsupported language fallback** — set api=GraphQL with Rust + Axum. Expect the README to include the banner: "GraphQL not yet generated for Rust — Helios emitted a REST server instead." The downloaded repo is a working REST server.

---

## 3. Critical Missing Features

### P0 — Blocks real usage

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | **Onboarding flow** | ✅ Done | `localStorage`-gated 2-step modal on `/dashboard`. Checks `helios_onboarded`. Sets language and navigates to builder. |
| 2 | **Email delivery for password reset** | ✅ Closed (won't fix) | Helios moved to SSO-only auth (GitHub + Bitbucket). Email/password signup, login, and the reset flow were deleted entirely — there is no longer a password to reset. The legacy `password_reset_tokens` table is no longer created on new dbs. |
| 3 | **Generated code actually builds** | ✅ Done | `.github/workflows/ci.yml` has a `smoke-build` matrix job covering Go, TypeScript, Python, Rust, Java, Kotlin. Generates a repo and runs the language toolchain against it. |
| 4 | **Project config persists in builder** | ✅ Done | Zustand persist middleware writes to `localStorage`. Builder fires a debounced silent `saveCurrentProject()` 2s after any config/endpoint/entity change. |

### P1 — Significant UX gaps

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 5 | **More templates + filters** | ✅ Done | 16 templates in `src/data/templates.ts` (added Rust Axum, Java Spring, TS Realtime Chat, TS Background Worker). Templates page has category filter (REST API, Microservice, SaaS, E-commerce, CMS, Cache Service, Real-time) and difficulty filter (Beginner / Intermediate / Advanced). Difficulty badge shown on each card. Quality pass: fixed `ts-express-redis-cache` template (was incorrectly setting Redis as primary database — now Postgres + Redis cache). |
| 6 | **Deploy to Render / Fly.io** | ✅ Done | Render and Fly are now first-class deploy targets alongside Railway. New API clients (`src/lib/render.ts`, `src/lib/fly.ts`) handle auth, retry/backoff, and typed error classes. Pipeline functions `runRenderDeployPipeline` and `runFlyDeployPipeline` mirror the Railway flow (push → provision → set env). New routes: `/api/render/deploy`, `/api/render/verify`, `/api/fly/deploy`, `/api/fly/verify`. `/api/deploy/stream` dispatches by `provider` in the body. Settings → Integrations now has Render and Fly token rows; the deploy page renders a provider-aware `DeployPanel` and `CredentialsPanel`. Render auto-deploys on first build via the GitHub repo connection; Fly returns a `nextStep` instruction with a `flyctl deploy` one-liner since Fly's git-driven flow is user-driven. |
| 7 | **Builder quick mode** | ✅ Done | Collapsible "Quick start" panel at top of builder — name + language + database → "Preview & download" in one click. |
| 8 | **Git & CI/CD page accessible** | ✅ Done | "Configure branch rules & PR strategy →" link added to the CI/CD section of the builder. Links to `/git-settings`. |

### P2 — Polish and completeness

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 9 | **GraphQL code generation** | ✅ Done | Schema-first SDL generator at `src/lib/generators/graphql/schema.ts` emits `graphql/schema.graphql`. Per-language servers: Go (gqlgen + Makefile target), TypeScript (graphql-yoga with Express/NestJS/Fastify/Hono adapters, custom DateTime + JSON scalars), Python (Strawberry mounted on FastAPI). Rust/Java/Kotlin fall back to REST with a banner in the README. Snapshot tests cover the full language × framework × graphql matrix (621 tests / 53 suites all green). |
| 10 | **tRPC code generation** | ✅ Done | Full tRPC v11 generator for TypeScript. Emits `src/trpc.ts`, `src/router.ts`, `src/server.ts`, `src/client.ts`, `src/types.ts`. One procedure per endpoint (GET → query, mutations → mutation). Entity CRUD procedures included when entities are defined. |
| 11 | **Java / Kotlin generators** | ✅ Done | All four framework variants (Spring, Quarkus, Ktor, Spring-Kt) emit per-entity entity class, repository (where idiomatic), controller/resource, and a smoke test file. Java Spring uses MockMvc; Quarkus uses `@QuarkusTest` + REST-assured; Kotlin Ktor uses Ktor's test client; Kotlin Spring-Kt uses MockMvc. Spring Security OAuth2 + Flyway + HikariCP + logstash-logback-encoder + non-root multi-stage Dockerfile. New Java Spring template added. CI smoke-build matrix covers all four variants. |
| 12 | **Team project sharing** | ✅ Done | `project_shares` table (per-project explicit shares — principal is user OR team, permission is view OR edit). Single-source-of-truth helper `src/lib/permissions.ts` (`getProjectAccess`); all project routes go through it. New routes: `POST/GET /api/projects/:id/shares`, `DELETE /api/projects/:id/shares/:shareId`, `GET /api/shared-with-me`. UI: `ShareProjectDialog` on each owned dashboard card + "Shared with me" section showing inherited projects with permission badges. |
| 13 | **Gallery moderation** | ✅ Done | Report button (Flag icon) on non-owned gallery cards. `POST /api/gallery/[id]/report` route. `gallery_reports` table in SQLite. Rate-limited to 5/user. |
| 14 | **Audit log middleware** | ✅ Done | `audit: true` flag now wires a real `auditLog` middleware in all 4 Go frameworks (gin/fiber/echo/chi) and Express. Logs method, path, status, IP via `slog`. Express also emits `src/middleware/audit.ts`. |
| 15 | **Monitoring integration** | ✅ Done | All 3 languages now emit real monitoring bootstraps: Go emits `internal/monitoring/metrics.go` (Prometheus), `sentry.go`, or `datadog.go` + updates `go.mod`. Express adds `prom-client`/`@sentry/node`/`dd-trace` to `package.json` + imports in `main.ts` + `/metrics` endpoint. FastAPI adds `prometheus-fastapi-instrumentator`/`sentry-sdk`/`ddtrace` to `pyproject.toml` + instruments the app. |
| 16 | **Deploy to Vercel** | ✅ Done | Vercel is now a first-class deploy target. New API client `src/lib/vercel.ts` (token verify → `GET /v2/user`, project create → `POST /v10/projects` with `gitRepository` link, env vars → `POST /v10/projects/{id}/env`). Pipeline `runVercelDeployPipeline` (4 stages: push → project → env → domain). New routes: `/api/vercel/deploy`, `/api/vercel/verify`. `/api/deploy/stream` accepts `provider: "vercel"`. Deploy page and Settings → Integrations both include Vercel. Vercel auto-deploys on first build via the GitHub repo connection. Prerequisite: Vercel GitHub App must be installed on the repo's org/account — `vercel_no_github` error surfaces the install link if it isn't. |
| 17 | **Builder tab bar restored** | ✅ Done | Builder reverted from accordion sections back to the 10-tab horizontal scrollable layout (Runtime, Database, Cache, Queue, APIs, Security, Deployment, Scaling, CI/CD, Monitoring). Active tab has a brand-color underline; tabs scroll horizontally on narrow viewports. |
| 18 | **GraphQL / tRPC "coming soon" removed** | ✅ Done | Stale `COMING_SOON_APIS` set removed from `ApiPanel`. GraphQL and tRPC are fully generated — tiles are now selectable. tRPC shows a "TS only" badge and is non-clickable for non-TypeScript languages (tRPC is TypeScript-only by design). |
| 19 | **`owner` field in StackConfig** | ✅ Done | Added `owner?: string` to `StackConfig` (schema + store type). Populated from `authUser.name` (GitHub display name / username) on login via `loadAuth`. Used in all generated Docker image tags, K8s deployment manifests, Helm chart image repository, and CI workflow push tags — replacing the hardcoded `your-org` placeholder. Falls back to `"your-org"` when unset. |
| 20 | **Stale-session auto-recovery** | ✅ Done | `GET /api/auth/me` now clears the `helios_token` cookie when the JWT is valid but the session row is missing (e.g. after a DB reset). `loadAuth` in the Zustand store redirects to `/login` when `user` is null on a protected route, preventing a state where pages load but every API call returns 401. |

---

## 4. Architecture Notes for Agents

### Key files
- `src/lib/store.ts` — Zustand store. `StackConfig` is the single source of truth for builder state.
- `src/lib/generators/index.ts` — `generate(config, endpoints, entities) → GeneratedFile[]`. Entry point for all code generation.
- `src/lib/generators/common.ts` — Files shared across all languages (README, QUICKSTART, Dockerfile, docker-compose, K8s, Helm, CI, OpenAPI). Surfaces gRPC/GraphQL "unsupported language" banners.
- `src/lib/generators/graphql/` — Schema-first GraphQL: `schema.ts` emits the SDL; `typescript.ts`, `go.ts`, and `python.ts` emit the matching server bindings. `isGraphqlSupported(language)` lives in `types.ts` next to `isGrpcSupported`.
- `src/lib/generators/__tests__/generate.test.ts` — 621 snapshot tests across language × framework × api combos. Run with `npm test`; regenerate with `UPDATE_SNAPSHOTS=1 npm test`.
- `src/lib/deploy-pipeline.ts` — Async generators for all four deploy providers. `runDeployPipeline` (Railway), `runRenderDeployPipeline`, `runFlyDeployPipeline`, `runVercelDeployPipeline` all follow the same push-then-provision pattern.
- `src/lib/railway.ts`, `src/lib/render.ts`, `src/lib/fly.ts`, `src/lib/vercel.ts` — Typed provider API clients with retry/backoff and structured error classes.
- `src/lib/db.ts` — All SQLite DB access. No ORM — raw `better-sqlite3`. Includes `project_shares` helpers (`createProjectShare`, `listProjectShares`, `deleteProjectShare`, `getProjectAccessRow`, `listSharedWithUser`) and raw project getters/setters used after permission checks (`getProjectByIdRaw`, `updateProjectRaw`).
- `src/lib/permissions.ts` — `getProjectAccess(projectId, userId)` is the only place project access is decided. `canRead`, `canWrite`, `canManage` wrap the rank check.
- `src/lib/auth.ts` — `getCurrentUser(req)` extracts and verifies the JWT from the `helios_token` cookie.
- `src/components/builder/ShareProjectDialog.tsx` — Radix Dialog for granting/revoking project shares (owner-only). Mounted from each saved-project card on the dashboard.
- `src/middleware.ts` — Next.js middleware. Protects `/dashboard`, `/builder`, `/preview`, `/deploy`, `/settings`, `/from-repo`, etc.

### Conventions
- API routes validate input with Zod. Never trust `req.json()` directly.
- Auth in API routes: always call `getCurrentUser(req)` first; return 401 if null.
- **Project access**: never write `WHERE user_id = ?` inline in a project route — call `getProjectAccess(projectId, userId)` from `src/lib/permissions.ts`. Use `canRead` / `canWrite` / `canManage` helpers to gate the action. Routes that mutate must call `getProjectByIdRaw` / `updateProjectRaw` (the access helper is the gate, not the SQL filter).
- Rate limiting: call `checkRateLimit(getRateLimitKey(req), N)` at the top of sensitive routes.
- Generators return `GeneratedFile[]` — `{ path: string, content: string }`. Paths are POSIX (forward slashes). No binary files.
- Generators use schema-first dispatch for protocol modes: gRPC and GraphQL both emit a shared schema file (`*.proto` / `schema.graphql`) then call into per-language emitters. Languages that don't yet implement a protocol fall back to REST and the README banner explains the swap.
- AI calls: use `claude-haiku-4-5-20251001` for fast/cheap enrichment, `claude-sonnet-4-6` for the main copilot.
- All `updated_at` timestamps from SQLite are Unix epoch **seconds** — multiply by 1000 before passing to `new Date()`.

### Environment variables required
```
ANTHROPIC_API_KEY       # Optional at build time, required for AI features
JWT_SECRET              # Required. Min 32 chars.
ENCRYPTION_KEY          # Required. 32-byte hex for AES-256-GCM (deploy creds + LLM keys).
GITHUB_CLIENT_ID        # Required for GitHub SSO + push.
GITHUB_CLIENT_SECRET    # Required for GitHub SSO + push.
BITBUCKET_CLIENT_ID     # Required for Bitbucket SSO + push.
BITBUCKET_CLIENT_SECRET # Required for Bitbucket SSO + push.
NEXT_PUBLIC_APP_URL     # Required. Used for OAuth callback URL.
```

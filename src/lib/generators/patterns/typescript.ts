import type { Endpoint, Entity, StackConfig } from "../types";
import type { PatternId } from "./index";
import { authProviderSpec } from "../auth/providers";
import { tsQueueKind } from "../queue/typescript";

// ── helpers ───────────────────────────────────────────────────────────────────

function inferTableName(path: string): string {
  const skip = new Set(["api", "v1", "v2", "v3", "v4"]);
  const parts = path.split("/").filter((p) => p && !p.startsWith(":") && !skip.has(p));
  return parts[parts.length - 1] || "items";
}

type TsFw = "express" | "fastify" | "hono";

// How authRequired verifies bearer tokens — mirrors goAuthMode / pyAuthMode:
//   jwks  — external provider configured: verify provider tokens via JWKS.
//   hs256 — auth "none" but auth_* patterns are used: the service issues its
//           own HS256 tokens (JWT_SECRET) and verifies exactly those.
//   off   — nothing to verify.
export type TsAuthMode = "jwks" | "hs256" | "off";
export function tsAuthMode(config: StackConfig, endpoints: Endpoint[]): TsAuthMode {
  const authPatterns = endpoints.some((e) => e.pattern?.startsWith("auth_"));
  if (authProviderSpec(config)) return endpoints.some((e) => e.auth) || authPatterns ? "jwks" : "off";
  return authPatterns ? "hs256" : "off";
}

// Routes that run behind authRequired: explicitly protected ones, plus the
// patterns that read the caller's identity.
export const tsGuarded = (e: Endpoint, mode: TsAuthMode) =>
  mode !== "off" && (e.auth || e.pattern === "auth_me" || e.pattern === "auth_change_password");

const CREDENTIAL_PATTERNS = ["auth_login", "auth_register", "auth_refresh", "auth_change_password"];

// ── framework adapter ─────────────────────────────────────────────────────────

interface TsFwCtx {
  queryStr: (key: string, def?: string) => string;
  queryInt: (key: string, def: number) => string;
  pathParam: (name: string) => string;
  sendJSON: (status: number | string, expr: string) => string;
  sendCreated: (expr: string) => string;
  sendNoContent: () => string;
  sendErr: (status: number, msg: string) => string;
  getBody: string; // variable name containing parsed body
  bindBody: string; // lines to parse body into `body`
  getCtxUser: () => string; // expression for authenticated user ID
  getCtxClaims: string; // expression for the verified token payload
  logErr: (msg: string, err: string) => string;
}

function tsCtx(fw: TsFw): TsFwCtx {
  if (fw === "express") return {
    queryStr: (k, d = "") => `(req.query[${JSON.stringify(k)}] as string) || ${JSON.stringify(d)}`,
    queryInt: (k, d) => `parseInt((req.query[${JSON.stringify(k)}] as string) || ${JSON.stringify(String(d))}, 10) || ${d}`,
    pathParam: (n) => `req.params[${JSON.stringify(n)}]`,
    sendJSON: (s, e) => `res.status(${s}).json(${e});`,
    sendCreated: (e) => `res.status(201).json(${e});`,
    sendNoContent: () => `res.sendStatus(204);`,
    sendErr: (s, m) => `res.status(${s}).json({ error: ${JSON.stringify(m)} }); return;`,
    getBody: "req.body",
    bindBody: "",
    getCtxUser: () => `(req as any).user?.sub`,
    getCtxClaims: `(req as any).user?.claims`,
    logErr: (msg, err) => `console.error(${JSON.stringify(msg)}, ${err});`,
  };

  if (fw === "fastify") return {
    queryStr: (k, d = "") => `((request.query as any)[${JSON.stringify(k)}] as string) || ${JSON.stringify(d)}`,
    queryInt: (k, d) => `parseInt(((request.query as any)[${JSON.stringify(k)}]) || ${JSON.stringify(String(d))}, 10) || ${d}`,
    pathParam: (n) => `(request.params as any)[${JSON.stringify(n)}]`,
    sendJSON: (s, e) => `reply.status(${s}).send(${e});`,
    sendCreated: (e) => `reply.status(201).send(${e});`,
    sendNoContent: () => `reply.status(204).send();`,
    sendErr: (s, m) => `reply.status(${s}).send({ error: ${JSON.stringify(m)} }); return;`,
    getBody: "request.body as any",
    bindBody: "",
    getCtxUser: () => `(request as any).user?.sub`,
    getCtxClaims: `(request as any).user?.claims`,
    logErr: (msg, err) => `request.log.error({ err: ${err} }, ${JSON.stringify(msg)});`,
  };

  return {
    queryStr: (k, d = "") => `c.req.query(${JSON.stringify(k)}) || ${JSON.stringify(d)}`,
    queryInt: (k, d) => `parseInt(c.req.query(${JSON.stringify(k)}) || ${JSON.stringify(String(d))}, 10) || ${d}`,
    pathParam: (n) => `c.req.param(${JSON.stringify(n)})`,
    sendJSON: (s, e) => `return c.json(${e}, ${s});`,
    sendCreated: (e) => `return c.json(${e}, 201);`,
    sendNoContent: () => `return c.body(null, 204);`,
    sendErr: (s, m) => `return c.json({ error: ${JSON.stringify(m)} }, ${s});`,
    getBody: "await c.req.json()",
    bindBody: "",
    getCtxUser: () => `c.get("user")?.sub`,
    getCtxClaims: `c.get("user")?.claims`,
    logErr: (msg, err) => `console.error(${JSON.stringify(msg)}, ${err});`,
  };
}

// ── model resolution ──────────────────────────────────────────────────────────

// Prisma backs the generated repositories for SQL databases only. Mongo keeps
// an in-memory repository; DynamoDB has no Prisma connector at all.
export function usesPrisma(config: StackConfig, entities: Entity[]): boolean {
  return entities.length > 0 && !/mongo/.test(config.database) && config.database !== "dynamodb";
}

export const hasRedisCache = (c: StackConfig) => /redis|upstash|dragonfly/.test(c.cache);

type PrismaModel = {
  accessor: string; // prisma.<accessor>
  pk: string;
  pkIsNumber: boolean;
  fields: string[]; // writable (non-PK) fields
  searchFields: string[]; // string/text fields usable with `contains`
};

// Map the route's resource segment ("users", "blog-posts") to a declared
// entity. Returns null when there is no matching entity or no Prisma, in which
// case the handler stays an explicit stub.
function resolveModel(table: string, config: StackConfig, entities: Entity[]): PrismaModel | null {
  if (!usesPrisma(config, entities)) return null;
  const singular = table.replace(/s$/, "").replace(/[-_]/g, "").toLowerCase();
  const entity = entities.find((e) => e.name.toLowerCase() === singular);
  if (!entity) return null;
  const pk = entity.fields.find((f) => f.primaryKey);
  if (!pk) return null;
  const nonPk = entity.fields.filter((f) => !f.primaryKey);
  return {
    accessor: entity.name[0].toLowerCase() + entity.name.slice(1),
    pk: pk.name,
    pkIsNumber: pk.type === "number",
    fields: nonPk.map((f) => f.name),
    searchFields: nonPk.filter((f) => f.type === "string" || f.type === "text").map((f) => f.name),
  };
}

const idOf = (m: PrismaModel, raw: string) => (m.pkIsNumber ? `Number(${raw})` : raw);
// Whitelist writable fields so clients cannot set the PK or unknown columns.
const pickData = (m: PrismaModel) => `{ ${m.fields.map((f) => `${f}: body.${f}`).join(", ")} }`;
// Handlers whose sendJSON doesn't already return need an explicit one.
const andReturn = (stmt: string) => (/^(return|throw)\b/.test(stmt) ? stmt : `${stmt} return;`);

const stub = (what: string) => `// No Prisma model matches this route — wire ${what} to your data layer.`;

// ── pattern bodies ────────────────────────────────────────────────────────────

function crudList(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  const where = m && m.searchFields.length
    ? `q ? { OR: [${m.searchFields.map((f) => `{ ${f}: { contains: q } }`).join(", ")}] } : {}`
    : "{}";
  const query = m
    ? `    const where = ${where};
    const [data, total] = await Promise.all([
      prisma.${m.accessor}.findMany({ where, skip, take: limit }),
      prisma.${m.accessor}.count({ where }),
    ]);`
    : `    ${stub("the list query")}
    const data: unknown[] = [];
    const total = 0;`;
  return `  const page = Math.max(1, ${x.queryInt("page", 1)});
  const limit = Math.min(100, Math.max(1, ${x.queryInt("limit", 20)}));
  const skip = (page - 1) * limit;
  const q = ${x.queryStr("q")};

  try {
${query}
    const pages = Math.max(1, Math.ceil(total / limit));
    ${x.sendJSON(200, "{ data, meta: { page, limit, total, pages } }")}
  } catch (err) {
    ${x.logErr("list " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudGet(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  const lookup = m
    ? `const row = await prisma.${m.accessor}.findUnique({ where: { ${m.pk}: ${idOf(m, "id")} } });`
    : `${stub("the lookup")}\n    const row: unknown = null;`;
  return `  const id = ${x.pathParam("id")};
  try {
    ${lookup}
    if (!row) { ${x.sendErr(404, "not found")} }
    ${x.sendJSON(200, "row")}
  } catch (err) {
    ${x.logErr("get " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudCreate(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  const create = m
    ? `const row = await prisma.${m.accessor}.create({ data: ${pickData(m)} });`
    : `${stub("the insert")}\n    const row = { id: crypto.randomUUID(), ...body, createdAt: new Date().toISOString() };`;
  return `${x.bindBody}  const body = ${x.getBody};
  if (!body || typeof body !== "object") { ${x.sendErr(400, "invalid request body")} }
  try {
    ${create}
    ${x.sendCreated("row")}
  } catch (err: any) {
    if (err?.name === "PrismaClientValidationError") { ${x.sendErr(400, "invalid request body")} }
    if (err?.code === "P2002") { ${x.sendErr(409, "already exists")} }
    ${x.logErr("create " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudUpdate(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  // Prisma throws P2025 when the row doesn't exist → mapped to 404 below.
  const update = m
    ? `const row = await prisma.${m.accessor}.update({ where: { ${m.pk}: ${idOf(m, "id")} }, data: ${pickData(m)} });`
    : `${stub("the update")}\n    const row: unknown = null;`;
  return `  const id = ${x.pathParam("id")};
${x.bindBody}  const body = ${x.getBody};
  if (!body || typeof body !== "object") { ${x.sendErr(400, "invalid request body")} }
  try {
    ${update}
    if (!row) { ${x.sendErr(404, "not found")} }
    ${x.sendJSON(200, "row")}
  } catch (err: any) {
    if (err?.code === "P2025") { ${x.sendErr(404, "not found")} }
    if (err?.name === "PrismaClientValidationError") { ${x.sendErr(400, "invalid request body")} }
    ${x.logErr("update " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudDelete(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  const del = m
    ? `await prisma.${m.accessor}.delete({ where: { ${m.pk}: ${idOf(m, "id")} } });`
    : stub("the delete");
  return `  const id = ${x.pathParam("id")};
  try {
    ${del}
    ${x.sendNoContent()}
  } catch (err: any) {
    if (err?.code === "P2025") { ${x.sendErr(404, "not found")} }
    ${x.logErr("delete " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function authLogin(fw: TsFw): string {
  const x = tsCtx(fw);
  return `${x.bindBody}  const { email, password } = ${x.getBody} as { email: string; password: string };
  if (!email || !password) { ${x.sendErr(400, "email and password required")} }
  try {
    // 1. Fetch user by email
    // const user = await prisma.user.findUnique({ where: { email } });
    const user = null as { id: string; passwordHash: string } | null; // replace (the cast keeps TS from narrowing to never)
    if (!user) {
      // Constant-time compare to prevent timing-based user enumeration
      await bcrypt.compare(password, "$2b$12$invalidhashforenumprotect");
      ${x.sendErr(401, "invalid_credentials")}
    }
    // 2. Verify password
    const valid = await bcrypt.compare(password, user!.passwordHash);
    if (!valid) { ${x.sendErr(401, "invalid_credentials")} }
    // 3. Issue JWT
    const token = jwt.sign({ sub: user!.id }, process.env.JWT_SECRET!, { expiresIn: "24h" });
    ${x.sendJSON(200, '{ token, tokenType: "Bearer" }')}
  } catch (err) {
    ${x.logErr("auth login", "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function authRegister(fw: TsFw): string {
  const x = tsCtx(fw);
  return `${x.bindBody}  const { email, password, name } = ${x.getBody} as { email: string; password: string; name?: string };
  if (!email || !password) { ${x.sendErr(400, "email and password required")} }
  if (password.length < 8) { ${x.sendErr(400, "password must be at least 8 characters")} }
  try {
    // Check for existing user
    // const existing = await prisma.user.findUnique({ where: { email } });
    // if (existing) sendErr 409
    const passwordHash = await bcrypt.hash(password, 12);
    // const user = await prisma.user.create({ data: { email, passwordHash, name } });
    const user = { id: crypto.randomUUID(), email, name, createdAt: new Date().toISOString() };
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET!, { expiresIn: "24h" });
    ${x.sendCreated('{ token, tokenType: "Bearer", user }')}
  } catch (err: any) {
    if (err?.code === "P2002") { ${x.sendErr(409, "email_already_registered")} }
    ${x.logErr("auth register", "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function authMe(fw: TsFw, mode: TsAuthMode): string {
  const x = tsCtx(fw);
  if (mode === "jwks") return `  // Claims verified by authRequired against the provider's JWKS.
  const claims = ${x.getCtxClaims};
  if (!claims) { ${x.sendErr(401, "missing_or_invalid_token")} }
  ${x.sendJSON(200, "claims")}`;
  return `  const sub = ${x.getCtxUser()};
  if (!sub) { ${x.sendErr(401, "missing_or_invalid_token")} }
  // Optional: fetch full user from DB
  // const user = await prisma.user.findUnique({ where: { id: sub } });
  ${x.sendJSON(200, "{ sub }")}`;
}

function authLogout(fw: TsFw): string {
  const x = tsCtx(fw);
  return `  // Stateless JWT — client discards the token.
  // For server-side revocation: add token to a Redis blocklist here.
  ${x.sendNoContent()}`;
}

function authRefresh(fw: TsFw): string {
  const x = tsCtx(fw);
  return `${x.bindBody}  const { refreshToken } = ${x.getBody} as { refreshToken: string };
  if (!refreshToken) { ${x.sendErr(400, "refreshToken required")} }
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET!) as any;
    const token = jwt.sign({ sub: payload.sub }, process.env.JWT_SECRET!, { expiresIn: "24h" });
    ${x.sendJSON(200, '{ token, tokenType: "Bearer" }')}
  } catch {
    ${x.sendErr(401, "invalid_refresh_token")}
  }`;
}

function authChangePassword(fw: TsFw): string {
  const x = tsCtx(fw);
  return `  const sub = ${x.getCtxUser()};
  if (!sub) { ${x.sendErr(401, "missing_or_invalid_token")} }
${x.bindBody}  const { currentPassword, newPassword } = ${x.getBody} as { currentPassword: string; newPassword: string };
  if (!currentPassword || !newPassword) { ${x.sendErr(400, "currentPassword and newPassword required")} }
  if (newPassword.length < 8) { ${x.sendErr(400, "new password must be at least 8 characters")} }
  try {
    // const user = await prisma.user.findUnique({ where: { id: sub } });
    // if (!user) sendErr 404
    // const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    // if (!valid) sendErr 401 "invalid_current_password"
    const passwordHash = await bcrypt.hash(newPassword, 12);
    // await prisma.user.update({ where: { id: sub }, data: { passwordHash } });
    ${x.sendNoContent()}
  } catch (err) {
    ${x.logErr("change password", "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function healthCheck(fw: TsFw, db: boolean, cache: boolean, queue: boolean): string {
  const x = tsCtx(fw);
  return `  const checks: Record<string, string> = { status: "ok" };
  let httpStatus: 200 | 503 = 200;
${db ? `  try { await prisma.$queryRaw\`SELECT 1\`; checks.db = "ok"; } catch { checks.db = "degraded"; httpStatus = 503; }\n` : ""}${cache ? `  try { await redis.ping(); checks.cache = "ok"; } catch { checks.cache = "degraded"; httpStatus = 503; }\n` : ""}${queue ? `  try { await queuePing(); checks.queue = "ok"; } catch { checks.queue = "degraded"; httpStatus = 503; }\n` : ""}  ${x.sendJSON("httpStatus", "checks")}`;
}

function webhookReceive(fw: TsFw, config: StackConfig): string {
  const x = tsCtx(fw);
  return `  const secret = process.env.WEBHOOK_SECRET || "";
  const sigHeader = ${fw === "express" ? 'req.headers["x-hub-signature-256"] as string' : fw === "fastify" ? 'request.headers["x-hub-signature-256"] as string' : fw === "hono" ? 'c.req.header("x-hub-signature-256") || ""' : 'req.headers["x-hub-signature-256"] as string'};

  ${fw === "hono" ? "const rawBody = await c.req.text();" : fw === "fastify" ? "const rawBody = JSON.stringify(request.body);" : "const rawBody = JSON.stringify(req.body);"}

  if (secret) {
    const expected = "sha256=" + crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    if (sigHeader !== expected) { ${x.sendErr(401, "invalid_signature")} }
  }

${queued(x, config, "webhook",
    `await publish(TOPICS.webhooks, { receivedAt: new Date().toISOString(), body: rawBody });
    ${x.sendJSON(202, "{ received: true }")}`)}`;
}

// Wraps a publish in the queue-unavailable handling; with no queue configured
// the route answers 503 rather than pretending the event was accepted.
function queued(x: TsFwCtx, config: StackConfig, what: string, body: string): string {
  if (!tsQueueKind(config)) return `  // No message queue configured (Queue tab) — nothing can accept the ${what}.
  ${andReturn(x.sendJSON(503, '{ error: "queue_not_configured" }'))}`;
  return `  try {
    ${body}
  } catch (err) {
    ${x.logErr(`publish ${what}`, "err")}
    ${x.sendErr(503, "queue_unavailable")}
  }`;
}

function fileUpload(fw: TsFw): string {
  const x = tsCtx(fw);
  return `  // File upload — use multer (express), @fastify/multipart (fastify), or hono's body for hono.
  // Validate MIME type and file size before storing.
  const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"];
  const maxBytes = 10 * 1024 * 1024; // 10 MB

  // Example with multer (express):
  // const file = (req as any).file;
  // if (!file) { return res.status(400).json({ error: "file field required" }); }
  // if (!allowedMimes.includes(file.mimetype)) { return res.status(415).json({ error: "unsupported file type" }); }
  // if (file.size > maxBytes) { return res.status(413).json({ error: "file too large" }); }
  // const url = await uploadToStorage(file); // S3, GCS, R2, etc.
  const url = "/uploads/placeholder";
  ${x.sendCreated('{ url, mime: "application/octet-stream" }')}`;
}

function paginatedSearch(fw: TsFw, table: string, m: PrismaModel | null): string {
  const x = tsCtx(fw);
  const query = m
    ? `    const rows = await prisma.${m.accessor}.findMany({
      where: ${m.searchFields.length ? `q ? { OR: [${m.searchFields.map((f) => `{ ${f}: { contains: q } }`).join(", ")}] } : {}` : "{}"},
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { ${m.pk}: ${idOf(m, "cursor")} } } : {}),
      orderBy: { ${m.pk}: "asc" },
    });
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? rows[rows.length - 1]?.${m.pk} ?? null : null;`
    : `    ${stub("the search query")}
    const rows: { id: string }[] = [];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? rows[rows.length - 1]?.id ?? null : null;`;
  return `  const q = ${x.queryStr("q")};
  const cursor = ${x.queryStr("cursor")};
  const limit = Math.min(100, Math.max(1, ${x.queryInt("limit", 20)}));

  try {
${query}
    ${x.sendJSON(200, "{ data: rows, nextCursor, hasMore }")}
  } catch (err) {
    ${x.logErr("search " + table, "err")}
    ${x.sendErr(500, "search failed")}
  }`;
}

function aggregateStats(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  return `  const groupBy = ${x.queryStr("group_by", "day")};
  const from = ${x.queryStr("from")};
  const to = ${x.queryStr("to")};

  try {
    // Example using Prisma groupBy:
    // const rows = await prisma.${table.replace(/s$/, "")}.groupBy({
    //   by: ["createdAt"],
    //   _count: { id: true },
    //   _sum: { amount: true },
    //   where: { createdAt: { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } },
    //   orderBy: { createdAt: "desc" },
    // });
    const rows: unknown[] = [];
    ${x.sendJSON(200, "{ data: rows }")}
  } catch (err) {
    ${x.logErr("aggregate stats", "err")}
    ${x.sendErr(500, "stats query failed")}
  }`;
}

function sendNotification(fw: TsFw, config: StackConfig): string {
  const x = tsCtx(fw);
  return `${x.bindBody}  const { recipient, channel, template, payload } = ${x.getBody} as {
    recipient: string; channel: "email" | "sms" | "push"; template: string; payload?: Record<string, unknown>;
  };
  if (!recipient || !channel) { ${x.sendErr(400, "recipient and channel required")} }
${queued(x, config, "notification",
    `// Delivered by the worker (src/worker.ts).
    await publish(TOPICS.notifications, { recipient, channel, template, payload });
    ${x.sendJSON(202, "{ queued: true, channel }")}`)}`;
}

function cacheRead(fw: TsFw, table: string, m: PrismaModel | null, cache: boolean): string {
  const x = tsCtx(fw);
  const lookup = m
    ? `const row = await prisma.${m.accessor}.findUnique({ where: { ${m.pk}: ${idOf(m, "id")} } });`
    : `${stub("the lookup")}\n    const row: unknown = null;`;
  if (!cache) {
    return `  const id = ${x.pathParam("id")};
  // No Redis-compatible cache configured — this reads straight from the DB.
  try {
    ${lookup}
    if (!row) { ${x.sendErr(404, "not found")} }
    ${x.sendJSON(200, "row")}
  } catch (err) {
    ${x.logErr("cache read " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
  }
  return `  const id = ${x.pathParam("id")};
  const cacheKey = \`${table}:\${id}\`;
  try {
    // A cache outage falls through to the DB instead of failing the request.
    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) { ${andReturn(x.sendJSON(200, "JSON.parse(cached)"))} }

    // Cache miss — fetch from the DB, then populate.
    // ponytail: TTL-only (5 min), no invalidation on write; add redis.del(cacheKey) in update/delete if staleness matters.
    ${lookup}
    if (!row) { ${x.sendErr(404, "not found")} }
    await redis.set(cacheKey, JSON.stringify(row), "EX", 300).catch(() => undefined);
    ${x.sendJSON(200, "row")}
  } catch (err) {
    ${x.logErr("cache read " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function customHandler(fw: TsFw, e: Endpoint): string {
  if (e.logicCode) return e.logicCode;
  const x = tsCtx(fw);
  return `  // ${e.logic || e.summary || "TODO: implement handler logic"}
  // Pattern: custom
  ${x.sendJSON(200, `{ ok: true, op: ${JSON.stringify(e.method + " " + e.path)} }`)}`;
}

// ── route wrapper by framework ─────────────────────────────────────────────────

function expressPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
}

export function tsPatternRoute(
  e: Endpoint,
  target: TsFw | "nestjs",
  config: StackConfig,
  entities: Entity[],
  mode: TsAuthMode
): string {
  // Nest runs on platform-express and its pattern methods take @Req()/@Res(),
  // so they share the Express handler bodies.
  const fw: TsFw = target === "nestjs" ? "express" : target;
  const table = inferTableName(e.path);
  const pattern = e.pattern as PatternId | undefined;
  const m = resolveModel(table, config, entities);
  const cache = hasRedisCache(config);
  let body: string;

  // Token design (mirrors Go/Python): with an external provider authRequired
  // verifies provider-issued tokens via JWKS, so this service must not mint its
  // own — credential endpoints answer 501 and auth_me reads the provider's claims.
  if (mode === "jwks" && CREDENTIAL_PATTERNS.includes(pattern ?? "")) {
    body = `  // Credentials are managed by ${config.auth}; tokens minted here would fail JWKS verification.
  ${andReturn(tsCtx(fw).sendJSON(501, `{ error: "handled_by_${config.auth}" }`))}`;
  } else switch (pattern) {
    case "crud_list":    body = crudList(fw, table, m); break;
    case "crud_get":     body = crudGet(fw, table, m); break;
    case "crud_create":  body = crudCreate(fw, table, m); break;
    case "crud_update":  body = crudUpdate(fw, table, m); break;
    case "crud_delete":  body = crudDelete(fw, table, m); break;
    case "auth_login":   body = authLogin(fw); break;
    case "auth_register":body = authRegister(fw); break;
    case "auth_me":      body = authMe(fw, mode); break;
    case "auth_logout":  body = authLogout(fw); break;
    case "auth_refresh": body = authRefresh(fw); break;
    case "auth_change_password": body = authChangePassword(fw); break;
    case "health_check": body = healthCheck(fw, usesPrisma(config, entities), cache, tsQueueKind(config) !== null); break;
    case "webhook_receive": body = webhookReceive(fw, config); break;
    case "file_upload":  body = fileUpload(fw); break;
    case "paginated_search": body = paginatedSearch(fw, table, m); break;
    case "aggregate_stats":  body = aggregateStats(fw, table); break;
    case "send_notification": body = sendNotification(fw, config); break;
    case "cache_read":   body = cacheRead(fw, table, m, cache); break;
    default:             body = customHandler(fw, e); break;
  }

  const path = expressPath(e.path);
  const method = e.method.toLowerCase();
  const guarded = tsGuarded(e, mode);

  if (target === "nestjs") return body; // caller wraps in decorator + method
  if (fw === "express") {
    // Express keeps authRequired on protected routes even with auth "off" (fail closed).
    return `app.${method}(${JSON.stringify(path)}, ${guarded || e.auth ? "authRequired, " : ""}async (req, res) => {\n${body}\n});`;
  }
  if (fw === "fastify") {
    return `app.${method}(${JSON.stringify(path)}, ${guarded ? "{ preHandler: authRequired }, " : ""}async (request, reply) => {\n${body}\n});`;
  }
  return `app.${method}(${JSON.stringify(path)}, ${guarded ? "authRequired, " : ""}async (c) => {\n${body}\n});`;
}

/** Extra imports needed in main.ts when auth or bcrypt patterns are present. */
export function tsPatternImports(config: StackConfig, endpoints: Endpoint[]): { needsBcrypt: boolean; needsJwt: boolean; needsCrypto: boolean } {
  const patterns = endpoints.map((e) => e.pattern ?? "");
  // With an external provider the credential patterns are 501 stubs — no hashing or signing.
  const selfIssued = tsAuthMode(config, endpoints) === "hs256";
  return {
    needsBcrypt: selfIssued && patterns.some((p) => ["auth_login", "auth_register", "auth_change_password"].includes(p)),
    // Only login/register/refresh sign or verify tokens themselves.
    needsJwt: selfIssued && patterns.some((p) => ["auth_login", "auth_register", "auth_refresh"].includes(p)),
    // crypto.createHmac (webhook) is node:crypto-only; the global is WebCrypto.
    needsCrypto: patterns.includes("webhook_receive"),
  };
}

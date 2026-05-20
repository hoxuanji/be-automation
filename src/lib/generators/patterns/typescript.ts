import type { Endpoint, Entity, StackConfig } from "../types";
import type { PatternId } from "./index";

// ── helpers ───────────────────────────────────────────────────────────────────

function inferTableName(path: string): string {
  const skip = new Set(["api", "v1", "v2", "v3", "v4"]);
  const parts = path.split("/").filter((p) => p && !p.startsWith(":") && !skip.has(p));
  return parts[parts.length - 1] || "items";
}

type TsFw = "express" | "fastify" | "hono" | "nestjs";

// ── framework adapter ─────────────────────────────────────────────────────────

interface TsFwCtx {
  queryStr: (key: string, def?: string) => string;
  queryInt: (key: string, def: number) => string;
  pathParam: (name: string) => string;
  sendJSON: (status: number, expr: string) => string;
  sendCreated: (expr: string) => string;
  sendNoContent: () => string;
  sendErr: (status: number, msg: string) => string;
  getBody: string; // variable name containing parsed body
  bindBody: string; // lines to parse body into `body`
  getCtxUser: () => string; // expression for authenticated user ID
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
    logErr: (msg, err) => `request.log.error({ err: ${err} }, ${JSON.stringify(msg)});`,
  };

  if (fw === "hono") return {
    queryStr: (k, d = "") => `c.req.query(${JSON.stringify(k)}) || ${JSON.stringify(d)}`,
    queryInt: (k, d) => `parseInt(c.req.query(${JSON.stringify(k)}) || ${JSON.stringify(String(d))}, 10) || ${d}`,
    pathParam: (n) => `c.req.param(${JSON.stringify(n)})`,
    sendJSON: (s, e) => `return c.json(${e}, ${s});`,
    sendCreated: (e) => `return c.json(${e}, 201);`,
    sendNoContent: () => `return c.body(null, 204);`,
    sendErr: (s, m) => `return c.json({ error: ${JSON.stringify(m)} }, ${s});`,
    getBody: "await c.req.json()",
    bindBody: `  const body = await c.req.json();\n`,
    getCtxUser: () => `c.get("sub") as string`,
    logErr: (msg, err) => `console.error(${JSON.stringify(msg)}, ${err});`,
  };

  // nestjs — return method body (caller wraps in class method)
  return {
    queryStr: (k, d = "") => `query[${JSON.stringify(k)}] || ${JSON.stringify(d)}`,
    queryInt: (k, d) => `parseInt(query[${JSON.stringify(k)}] || ${JSON.stringify(String(d))}, 10) || ${d}`,
    pathParam: (n) => `params[${JSON.stringify(n)}]`,
    sendJSON: (s, e) => `return ${e};`,
    sendCreated: (e) => `return ${e};`,
    sendNoContent: () => `return;`,
    sendErr: (s, m) => `throw new HttpException(${JSON.stringify(m)}, ${s});`,
    getBody: "body",
    bindBody: "",
    getCtxUser: () => `req.user?.sub`,
    logErr: (msg, err) => `this.logger?.error(${JSON.stringify(msg)}, ${err});`,
  };
}

// ── pattern bodies ────────────────────────────────────────────────────────────

function crudList(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const page = Math.max(1, ${x.queryInt("page", 1)});
  const limit = Math.min(100, Math.max(1, ${x.queryInt("limit", 20)}));
  const skip = (page - 1) * limit;
  const q = ${x.queryStr("q")};

  // If using Prisma: replace raw query with prisma.${prismaModel}.findMany(...)
  try {
    // Raw approach — adapt to your ORM
    const where = q ? { where: { name: { contains: q, mode: "insensitive" } } } : {};
    // Stub: replace with actual DB query
    const data: unknown[] = [];
    const total = 0;
    const pages = Math.max(1, Math.ceil(total / limit));
    ${x.sendJSON(200, "{ data, meta: { page, limit, total, pages } }")}
  } catch (err) {
    ${x.logErr("list " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudGet(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const id = ${x.pathParam("id")};
  try {
    // Prisma: const row = await prisma.${prismaModel}.findUnique({ where: { id } });
    const row: unknown = null; // replace with actual DB lookup
    if (!row) { ${x.sendErr(404, "not found")} }
    ${x.sendJSON(200, "row")}
  } catch (err) {
    ${x.logErr("get " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudCreate(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `${x.bindBody}  const body = ${x.getBody};
  if (!body || typeof body !== "object") { ${x.sendErr(400, "invalid request body")} }
  try {
    // Prisma: const row = await prisma.${prismaModel}.create({ data: body });
    const row = { id: crypto.randomUUID(), ...body, createdAt: new Date().toISOString() };
    ${x.sendCreated("row")}
  } catch (err) {
    ${x.logErr("create " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudUpdate(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const id = ${x.pathParam("id")};
${x.bindBody}  const body = ${x.getBody};
  if (!body || typeof body !== "object") { ${x.sendErr(400, "invalid request body")} }
  try {
    // Prisma: const row = await prisma.${prismaModel}.update({ where: { id }, data: body });
    const row: unknown = null; // replace — throw if not found
    if (!row) { ${x.sendErr(404, "not found")} }
    ${x.sendJSON(200, "row")}
  } catch (err: any) {
    if (err?.code === "P2025") { ${x.sendErr(404, "not found")} }
    ${x.logErr("update " + table, "err")}
    ${x.sendErr(500, "internal server error")}
  }`;
}

function crudDelete(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const id = ${x.pathParam("id")};
  try {
    // Prisma: await prisma.${prismaModel}.delete({ where: { id } });
    // Check row exists before deleting — throw 404 if not found
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
    const user: { id: string; passwordHash: string } | null = null; // replace
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

function authMe(fw: TsFw): string {
  const x = tsCtx(fw);
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

function healthCheck(fw: TsFw, _config: StackConfig): string {
  const x = tsCtx(fw);
  return `  const checks: Record<string, string> = { status: "ok" };
  let httpStatus = 200;
  // Add real health checks:
  // try { await prisma.$queryRaw\`SELECT 1\`; checks.db = "ok"; } catch { checks.db = "degraded"; httpStatus = 503; }
  // try { await redis.ping(); checks.cache = "ok"; } catch { checks.cache = "degraded"; httpStatus = 503; }
  ${x.sendJSON(200, "checks")}`;
}

function webhookReceive(fw: TsFw): string {
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

  // TODO: enqueue event for async processing
  console.log("webhook received", rawBody.length, "bytes");
  ${x.sendJSON(200, '{ received: true }')}`;
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

function paginatedSearch(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const q = ${x.queryStr("q")};
  const cursor = ${x.queryStr("cursor")};
  const limit = Math.min(100, Math.max(1, ${x.queryInt("limit", 20)}));

  try {
    // Prisma cursor pagination:
    // const rows = await prisma.${prismaModel}.findMany({
    //   where: q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {},
    //   take: limit + 1,
    //   ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    //   orderBy: { createdAt: "desc" },
    // });
    const rows: unknown[] = [];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? (rows[rows.length - 1] as any)?.id : null;
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
  const queueNote = config.queue === "kafka"
    ? "kafkajs producer"
    : config.queue === "rabbitmq"
    ? "amqplib channel"
    : config.queue === "nats"
    ? "nats.publish()"
    : "your message broker";
  return `${x.bindBody}  const { recipient, channel, template, payload } = ${x.getBody} as {
    recipient: string; channel: "email" | "sms" | "push"; template: string; payload?: Record<string, unknown>;
  };
  if (!recipient || !channel) { ${x.sendErr(400, "recipient and channel required")} }
  try {
    // TODO: publish via ${queueNote}
    // await broker.publish("notifications", { recipient, channel, template, payload });
    console.info("notification queued", { channel, recipient });
    ${x.sendJSON(200, '{ queued: true, channel }')}
  } catch (err) {
    ${x.logErr("send notification", "err")}
    ${x.sendErr(500, "failed to queue notification")}
  }`;
}

function cacheRead(fw: TsFw, table: string): string {
  const x = tsCtx(fw);
  const prismaModel = table.replace(/s$/, "");
  return `  const id = ${x.pathParam("id")};
  const cacheKey = \`${table}:\${id}\`;
  try {
    // Check Redis cache
    // const cached = await redis.get(cacheKey);
    // if (cached) { ${x.sendJSON(200, "JSON.parse(cached)")} }

    // Cache miss — fetch from DB
    // const row = await prisma.${prismaModel}.findUnique({ where: { id } });
    const row: unknown = null; // replace with actual DB lookup
    if (!row) { ${x.sendErr(404, "not found")} }

    // Populate cache (TTL 5 minutes)
    // await redis.set(cacheKey, JSON.stringify(row), "EX", 300);
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
  fw: TsFw,
  config: StackConfig,
  _entities: Entity[]
): string {
  const table = inferTableName(e.path);
  const pattern = e.pattern as PatternId | undefined;
  let body: string;

  switch (pattern) {
    case "crud_list":    body = crudList(fw, table); break;
    case "crud_get":     body = crudGet(fw, table); break;
    case "crud_create":  body = crudCreate(fw, table); break;
    case "crud_update":  body = crudUpdate(fw, table); break;
    case "crud_delete":  body = crudDelete(fw, table); break;
    case "auth_login":   body = authLogin(fw); break;
    case "auth_register":body = authRegister(fw); break;
    case "auth_me":      body = authMe(fw); break;
    case "auth_logout":  body = authLogout(fw); break;
    case "auth_refresh": body = authRefresh(fw); break;
    case "auth_change_password": body = authChangePassword(fw); break;
    case "health_check": body = healthCheck(fw, config); break;
    case "webhook_receive": body = webhookReceive(fw); break;
    case "file_upload":  body = fileUpload(fw); break;
    case "paginated_search": body = paginatedSearch(fw, table); break;
    case "aggregate_stats":  body = aggregateStats(fw, table); break;
    case "send_notification": body = sendNotification(fw, config); break;
    case "cache_read":   body = cacheRead(fw, table); break;
    default:             body = customHandler(fw, e); break;
  }

  const path = expressPath(e.path);
  const method = e.method.toLowerCase();
  const auth = e.auth ? "authRequired, " : "";

  if (fw === "express") {
    return `app.${method}(${JSON.stringify(path)}, ${auth}async (req, res) => {\n${body}\n});`;
  }
  if (fw === "fastify") {
    return `app.${method}(${JSON.stringify(path)}, async (request, reply) => {\n${body}\n});`;
  }
  if (fw === "hono") {
    return `app.${method}(${JSON.stringify(path)}, async (c) => {\n${body}\n});`;
  }
  // nestjs — body only, caller wraps in decorator+method
  return body;
}

/** Extra imports needed in main.ts when auth or bcrypt patterns are present. */
export function tsPatternImports(endpoints: Endpoint[]): { needsBcrypt: boolean; needsJwt: boolean } {
  const patterns = endpoints.map((e) => e.pattern ?? "");
  return {
    needsBcrypt: patterns.some((p) => ["auth_login", "auth_register", "auth_change_password"].includes(p)),
    needsJwt: patterns.some((p) => (p as string).startsWith("auth_")),
  };
}

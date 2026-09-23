import type { Endpoint, Entity, StackConfig } from "../types";
import type { PatternId } from "./index";
import { authProviderSpec } from "../auth/providers";

// ── helpers ───────────────────────────────────────────────────────────────────

const SKIP_SEGMENTS = new Set(["api", "v1", "v2", "v3", "v4"]);

function resourceSegments(path: string): string[] {
  return path.split("/").filter((p) => p && !p.startsWith(":") && !SKIP_SEGMENTS.has(p));
}

function inferTableName(path: string): string {
  const parts = resourceSegments(path);
  return parts[parts.length - 1] || "items";
}

function pyPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

function pathParams(p: string): string[] {
  return (p.match(/:([a-zA-Z0-9_]+)/g) ?? []).map((m) => m.slice(1));
}

// Unique per route, so two handlers on the same resource don't shadow each other.
function fnName(e: Endpoint): string {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "by_" + p.slice(1) : p.replace(/[^a-zA-Z0-9]/g, "_")));
  return (e.method.toLowerCase() + "_" + parts.join("_")).replace(/_+$/g, "");
}

type PyFw = "fastapi" | "django" | "litestar";

// How auth_required verifies bearer tokens — mirrors goAuthMode:
//   jwks  — external provider configured: verify provider tokens via JWKS.
//   hs256 — auth "none" but auth_* patterns are used: the service issues its
//           own HS256 tokens (JWT_SECRET) and verifies exactly those.
//   off   — nothing to verify; no app/auth.py is emitted.
// Only the FastAPI entrypoint renders pattern handlers, so patterns only
// switch the mode there.
export type PyAuthMode = "jwks" | "hs256" | "off";
export function pyAuthMode(config: StackConfig, endpoints: Endpoint[]): PyAuthMode {
  const authPatterns = config.framework === "fastapi" && endpoints.some((e) => e.pattern?.startsWith("auth_"));
  if (authProviderSpec(config)) return endpoints.some((e) => e.auth) || authPatterns ? "jwks" : "off";
  return authPatterns ? "hs256" : "off";
}

// Entity declared for this route's resource ("/users/search" → User), if any.
// Scans segments right-to-left so action suffixes like "search" still resolve.
function resolveEntity(path: string, entities: Entity[]): Entity | undefined {
  for (const seg of resourceSegments(path).reverse()) {
    const singular = seg.replace(/s$/, "").replace(/[-_]/g, "").toLowerCase();
    const hit = entities.find((e) => e.name.toLowerCase() === singular);
    if (hit) return hit;
  }
  return undefined;
}

type PyModel = { name: string; pk: string; created: string; search: string[] };

function pyModel(entity: Entity): PyModel {
  const has = (n: string) => entity.fields.some((f) => f.name === n);
  return {
    name: entity.name,
    pk: entity.fields.find((f) => f.primaryKey)?.name ?? "id",
    // sqlalchemyModels adds created_at unless the entity declares createdAt.
    created: has("createdAt") ? "createdAt" : "created_at",
    search: entity.fields.filter((f) => !f.primaryKey && (f.type === "string" || f.type === "text")).map((f) => f.name),
  };
}

// The self-issued auth flow needs a User entity with email + password hash columns.
type PyUser = { name: string; pk: string; email: string; hash: string };
function userEntity(entities: Entity[]): PyUser | undefined {
  const u = entities.find((e) => e.name.toLowerCase() === "user");
  const email = u?.fields.find((f) => f.name === "email");
  const hash = u?.fields.find((f) => /^password_?hash$/i.test(f.name));
  if (!u || !email || !hash) return undefined;
  return { name: u.name, pk: u.fields.find((f) => f.primaryKey)?.name ?? "id", email: email.name, hash: hash.name };
}

const stub = (why: string) => `async def handler():
    # ${why}
    raise HTTPException(status_code=501, detail="not_implemented")`;
const NO_ENTITY = stub("No entity matches this route — declare one (or wire this handler to your data layer).");
const NO_USER = stub("Declare a User entity with `email` and `password_hash` fields to enable self-managed auth.");

const searchFilter = (m: PyModel) =>
  m.search.length ? `or_(${m.search.map((f) => `${m.name}.${f}.ilike(f"%{q}%")`).join(", ")})` : "";

// ── pattern bodies (FastAPI) ─────────────────────────────────────────────────

function crudList(m: PyModel): string {
  const filter = searchFilter(m);
  return `async def handler(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(${m.name})
${filter ? `    if q:\n        query = query.filter(${filter})\n` : ""}    total = query.count()
    items = query.order_by(${m.name}.${m.created}.desc()).offset((page - 1) * limit).limit(limit).all()
    pages = max(1, math.ceil(total / limit))
    return {"data": [_row(i) for i in items], "meta": {"page": page, "limit": limit, "total": total, "pages": pages}}`;
}

function crudGet(m: PyModel, param: string): string {
  return `async def handler(${param}: str, db: Session = Depends(get_db)):
    item = db.query(${m.name}).filter(${m.name}.${m.pk} == ${param}).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    return _row(item)`;
}

function crudCreate(m: PyModel): string {
  return `async def handler(payload: dict, db: Session = Depends(get_db)):
    # Whitelist real columns so clients cannot set the PK or unknown attributes.
    item = ${m.name}(**{k: v for k, v in payload.items() if k in ${m.name}.__table__.columns and k != "${m.pk}"})
    db.add(item)
    db.commit()
    db.refresh(item)
    return _row(item)`;
}

function crudUpdate(m: PyModel, param: string): string {
  return `async def handler(${param}: str, payload: dict, db: Session = Depends(get_db)):
    item = db.query(${m.name}).filter(${m.name}.${m.pk} == ${param}).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    for key, value in payload.items():
        if key != "${m.pk}" and key in ${m.name}.__table__.columns:
            setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return _row(item)`;
}

function crudDelete(m: PyModel, param: string): string {
  return `async def handler(${param}: str, db: Session = Depends(get_db)):
    item = db.query(${m.name}).filter(${m.name}.${m.pk} == ${param}).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    db.delete(item)
    db.commit()
    return Response(status_code=204)`;
}

function authLogin(u: PyUser): string {
  return `async def handler(credentials: Credentials, db: Session = Depends(get_db)):
    user = db.query(${u.name}).filter(${u.name}.${u.email} == credentials.email).first()
    if not user or not user.${u.hash}:
        # Burn a bcrypt check anyway so response timing doesn't reveal which emails exist.
        bcrypt.checkpw(credentials.password.encode(), _DUMMY_HASH)
        raise HTTPException(status_code=401, detail="invalid_credentials")
    if not bcrypt.checkpw(credentials.password.encode(), user.${u.hash}.encode()):
        raise HTTPException(status_code=401, detail="invalid_credentials")
    return {"token": create_access_token(str(user.${u.pk})), "token_type": "Bearer"}`;
}

function authRegister(u: PyUser): string {
  return `async def handler(payload: Credentials, db: Session = Depends(get_db)):
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
    if db.query(${u.name}).filter(${u.name}.${u.email} == payload.email).first():
        raise HTTPException(status_code=409, detail="email_already_registered")
    user = ${u.name}(${u.email}=payload.email, ${u.hash}=bcrypt.hashpw(payload.password.encode(), bcrypt.gensalt()).decode())
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token(str(user.${u.pk}))
    return JSONResponse(status_code=201, content={"token": token, "token_type": "Bearer", "user": {"id": str(user.${u.pk}), "email": user.${u.email}}})`;
}

// auth_required returns the verified claims — provider-issued (jwks) or self-issued (hs256).
function authMe(): string {
  return `async def handler(claims: dict = Depends(auth_required)):
    return {"sub": claims.get("sub"), "email": claims.get("email")}`;
}

function authLogout(): string {
  return `async def handler(claims: dict = Depends(auth_required)):
    # Stateless JWT — client discards the token.
    # For server-side revocation: add token to a Redis blocklist.
    return Response(status_code=204)`;
}

function authRefresh(): string {
  // ponytail: refresh reuses the access-token key and TTL; split secrets/TTLs if refresh tokens must outlive access tokens.
  return `async def handler(payload: RefreshRequest):
    try:
        sub = verify_token(payload.refresh_token)["sub"]
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="invalid_refresh_token")
    return {"token": create_access_token(sub), "token_type": "Bearer"}`;
}

function authChangePassword(u: PyUser): string {
  return `async def handler(
    payload: ChangePasswordRequest,
    claims: dict = Depends(auth_required),
    db: Session = Depends(get_db),
):
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    user = db.query(${u.name}).filter(${u.name}.${u.pk} == claims["sub"]).first()
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if not user.${u.hash} or not bcrypt.checkpw(payload.current_password.encode(), user.${u.hash}.encode()):
        raise HTTPException(status_code=401, detail="invalid_current_password")
    user.${u.hash} = bcrypt.hashpw(payload.new_password.encode(), bcrypt.gensalt()).decode()
    db.commit()
    return Response(status_code=204)`;
}

export const pyHasRedis = (c: StackConfig) => /redis|upstash|dragonfly/.test(c.cache);

function healthCheck(config: StackConfig, hasDb: boolean): string {
  const hasCache = pyHasRedis(config);
  return `async def handler(${hasDb ? "db: Session = Depends(get_db)" : ""}):
    checks: dict = {"status": "ok"}
    http_status = 200
${hasDb ? `    try:
        db.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception:
        checks["db"] = "degraded"
        http_status = 503
` : ""}${hasCache ? `    try:
        await redis_client.ping()
        checks["cache"] = "ok"
    except Exception:
        checks["cache"] = "degraded"
        http_status = 503
` : ""}    return JSONResponse(status_code=http_status, content=checks)`;
}

function webhookReceive(): string {
  return `async def handler(request: Request):
    secret = os.getenv("WEBHOOK_SECRET", "")
    raw_body = await request.body()
    if secret:
        sig = request.headers.get("x-hub-signature-256", "")
        expected = "sha256=" + hmac_lib.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        if not hmac_lib.compare_digest(sig, expected):
            raise HTTPException(status_code=401, detail="invalid_signature")
    # TODO: enqueue event for async processing
    logger.info("webhook received", extra={"bytes": len(raw_body)})
    return {"received": True}`;
}

function fileUpload(): string {
  return `async def handler(file: UploadFile):
    ALLOWED_MIMES = {"image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"}
    MAX_BYTES = 10 * 1024 * 1024  # 10 MB

    if file.content_type not in ALLOWED_MIMES:
        raise HTTPException(status_code=415, detail="unsupported file type")
    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large")
    # TODO: upload contents to cloud storage (S3, GCS, R2)
    # url = await storage.upload(contents, file.filename, file.content_type)
    file_id = str(uuid4())
    url = f"/uploads/{file_id}-{file.filename}"
    return JSONResponse(status_code=201, content={"id": file_id, "url": url, "mime": file.content_type})`;
}

function paginatedSearch(m: PyModel): string {
  const filter = searchFilter(m);
  return `async def handler(
    q: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(${m.name})
${filter ? `    if q:\n        query = query.filter(${filter})\n` : ""}    if cursor:
        ref = db.query(${m.name}).filter(${m.name}.${m.pk} == cursor).first()
        if ref:
            query = query.filter(${m.name}.${m.created} < ref.${m.created})
    items = query.order_by(${m.name}.${m.created}.desc()).limit(limit + 1).all()
    has_more = len(items) > limit
    if has_more:
        items = items[:limit]
    next_cursor = str(items[-1].${m.pk}) if has_more and items else None
    return {"data": [_row(i) for i in items], "next_cursor": next_cursor, "has_more": has_more}`;
}

function aggregateStats(table: string): string {
  return `async def handler(
    group_by: str = Query("day"),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    db: Session = Depends(get_db),
):
    # Raw SQL for flexible aggregation — adapt to your schema
    sql = text("""
        SELECT DATE_TRUNC(:period, created_at) AS period,
               COUNT(*) AS count,
               COALESCE(SUM(amount), 0) AS total
        FROM ${table}
        WHERE (:from_date IS NULL OR created_at >= :from_date::timestamptz)
          AND (:to_date IS NULL OR created_at <= :to_date::timestamptz)
        GROUP BY period
        ORDER BY period DESC
    """)
    result = db.execute(sql, {"period": group_by, "from_date": from_date, "to_date": to_date})
    rows = [dict(r._mapping) for r in result]
    return {"data": rows}`;
}

function sendNotification(config: StackConfig): string {
  const queueNote = config.queue === "kafka"
    ? "aiokafka producer"
    : config.queue === "rabbitmq"
    ? "aio_pika channel"
    : config.queue === "nats"
    ? "nats.publish()"
    : "your message broker";
  return `async def handler(payload: NotificationRequest):
    if not payload.recipient or not payload.channel:
        raise HTTPException(status_code=400, detail="recipient and channel required")
    # TODO: publish via ${queueNote}
    # await broker.publish("notifications", payload.model_dump())
    logger.info("notification queued", extra={"channel": payload.channel, "recipient": payload.recipient})
    return {"queued": True, "channel": payload.channel}`;
}

function cacheRead(table: string, param: string, entity: Entity | undefined, hasCache: boolean): string {
  const pk = entity?.fields.find((f) => f.primaryKey)?.name ?? "id";
  const sig = `async def handler(${param}: str${entity ? ", db: Session = Depends(get_db)" : ""}):`;
  const lookup = entity
    ? `    item = db.query(${entity.name}).filter(${entity.name}.${pk} == ${param}).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    payload = _row(item)`
    : `    # No entity matches this route — wire the lookup to your data layer.
    raise HTTPException(status_code=404, detail="not found")`;
  if (!hasCache) {
    return `${sig}
    # No Redis-compatible cache configured — this reads straight from the DB.
${lookup}${entity ? "\n    return payload" : ""}`;
  }
  return `${sig}
    cache_key = f"${table}:{${param}}"
    try:
        cached = await redis_client.get(cache_key)
    except Exception:  # cache outage → fall through to the DB
        cached = None
    if cached:
        return json.loads(cached)

    # Cache miss — fetch from the DB, then populate.
    # ponytail: TTL-only (5 min), no invalidation on write; delete the key in update/delete if staleness matters.
${lookup}${entity ? `
    try:
        await redis_client.set(cache_key, json.dumps(payload), ex=300)
    except Exception:
        pass  # serving from the DB is still correct
    return payload` : ""}`;
}

function customHandler(e: Endpoint): string {
  if (e.logicCode) return e.logicCode;
  return `async def handler():
    # ${e.logic || e.summary || "TODO: implement handler logic"}
    return {"ok": True, "op": "${e.method} ${e.path}"}`;
}

const DB_PATTERNS = new Set(["crud_list", "crud_get", "crud_create", "crud_update", "crud_delete", "paginated_search", "aggregate_stats"]);
const CREDENTIAL_PATTERNS = new Set(["auth_login", "auth_register", "auth_refresh", "auth_change_password"]);

function patternBody(e: Endpoint, config: StackConfig, entities: Entity[], mode: PyAuthMode): string {
  const pattern = e.pattern as PatternId | undefined;
  const table = inferTableName(e.path);
  const params = pathParams(e.path);
  const param = params[params.length - 1] ?? "id";
  const entity = resolveEntity(e.path, entities);
  const m = entity && pyModel(entity);
  const hasDb = entities.length > 0;

  // Token design (mirrors Go): with an external provider auth_required verifies
  // provider-issued tokens via JWKS, so this service must not mint its own —
  // credential endpoints answer 501 and auth_me reads the provider's claims.
  if (mode === "jwks" && CREDENTIAL_PATTERNS.has(pattern ?? "")) {
    return `async def handler():
    # Credentials are managed by ${config.auth}; tokens minted here would fail JWKS verification.
    raise HTTPException(status_code=501, detail="handled_by_${config.auth}")`;
  }
  if (pattern === "aggregate_stats" && !hasDb) return NO_ENTITY;
  if (DB_PATTERNS.has(pattern ?? "") && pattern !== "aggregate_stats" && !m) return NO_ENTITY;
  const user = userEntity(entities);
  if ((pattern === "auth_login" || pattern === "auth_register" || pattern === "auth_change_password") && !user) return NO_USER;

  switch (pattern) {
    case "crud_list":    return crudList(m!);
    case "crud_get":     return crudGet(m!, param);
    case "crud_create":  return crudCreate(m!);
    case "crud_update":  return crudUpdate(m!, param);
    case "crud_delete":  return crudDelete(m!, param);
    case "auth_login":   return authLogin(user!);
    case "auth_register":return authRegister(user!);
    case "auth_me":      return authMe();
    case "auth_logout":  return authLogout();
    case "auth_refresh": return authRefresh();
    case "auth_change_password": return authChangePassword(user!);
    case "health_check": return healthCheck(config, hasDb);
    case "webhook_receive": return webhookReceive();
    case "file_upload":  return fileUpload();
    case "paginated_search": return paginatedSearch(m!);
    case "aggregate_stats":  return aggregateStats(table);
    case "send_notification": return sendNotification(config);
    case "cache_read":   return cacheRead(table, param, entity, pyHasRedis(config));
    default:             return customHandler(e);
  }
}

// ── route builder ─────────────────────────────────────────────────────────────

export function pyPatternRoute(
  e: Endpoint,
  fw: PyFw,
  config: StackConfig,
  entities: Entity[],
  mode: PyAuthMode = "off"
): string {
  const table = inferTableName(e.path);
  const pyPathStr = pyPath(e.path);
  const params = pathParams(e.path);
  const method = e.method.toLowerCase();

  if (fw === "fastapi") {
    const handlerBody = patternBody(e, config, entities, mode);
    const auth = e.auth && mode !== "off" ? ", dependencies=[Depends(auth_required)]" : "";
    const statusCode = method === "post" ? ", status_code=201" : method === "delete" ? ", status_code=204" : "";
    const body = handlerBody.replace(/^async def handler/, `async def ${fnName(e)}`);
    return `@app.${method}(${JSON.stringify(pyPathStr)}${statusCode}${auth})\n${body}`;
  }

  if (fw === "litestar") {
    const decorator = method === "get" ? "@get" : method === "post" ? "@post" : method === "put" ? "@put" : method === "patch" ? "@patch" : "@delete";
    const fnName = `${method}_${table.replace(/-/g, "_")}`;
    return `${decorator}(${JSON.stringify(pyPathStr)})\nasync def ${fnName}() -> dict:\n    # ${e.logic || e.summary || "TODO: implement"}\n    return {"ok": True}`;
  }

  // Django — function-based view stub
  return `@api_view([${JSON.stringify(e.method)}])\ndef ${method}_${table.replace(/-/g, "_")}(request${params.length ? ", " + params.join(", ") : ""}):\n    # ${e.logic || e.summary || "TODO: implement"}\n    return Response({"ok": True})`;
}

/**
 * Module-level lines app/main.py needs for the pattern handlers: imports plus
 * the request models / helpers their signatures reference. Derived from the
 * emitted handler code so every referenced name is defined exactly when used.
 */
export function pyPatternImports(endpoints: Endpoint[], config: StackConfig, entities: Entity[] = [], mode: PyAuthMode = "off"): string[] {
  const patterned = endpoints.filter((e) => e.pattern);
  if (!patterned.length) return [];
  const code = patterned.map((e) => patternBody(e, config, entities, mode)).join("\n");
  const uses = (re: RegExp) => re.test(code);
  const lines: string[] = [
    // Names the handler signatures use as defaults / annotations — evaluated
    // at import time, so they must exist in both FastAPI entrypoints.
    "from typing import Optional",
    "from fastapi import Query, Request, Response",
    "from fastapi.responses import JSONResponse",
  ];
  if (uses(/\bget_db\b/)) lines.push("from sqlalchemy.orm import Session", "from .db import get_db");
  const models = entities.filter((en) => new RegExp(`\\b${en.name}\\b`).test(code)).map((en) => en.name);
  if (models.length) lines.push(`from .models import ${[...new Set(models)].join(", ")}`);
  if (uses(/\b_row\(/)) lines.push("from fastapi.encoders import jsonable_encoder");
  if (uses(/\bredis_client\b/)) lines.push("from .cache import redis_client");
  if (uses(/\bjson\.loads\b/)) lines.push("import json");
  if (uses(/\bmath\./)) lines.push("import math");
  if (uses(/\btext\(/)) lines.push("from sqlalchemy import text");
  if (uses(/\bor_\(/)) lines.push("from sqlalchemy import or_");
  if (uses(/\bhmac_lib\b/)) lines.push("import hmac as hmac_lib", "import hashlib", "import os");
  if (uses(/\bUploadFile\b/)) lines.push("from fastapi import UploadFile");
  if (uses(/\buuid4\(/)) lines.push("from uuid import uuid4");
  if (uses(/\bbcrypt\./)) lines.push("import bcrypt");
  if (uses(/\bjwt\./)) lines.push("import jwt");
  const authNames = ["create_access_token", "verify_token"].filter((n) => code.includes(n + "("));
  if (authNames.length) lines.push(`from .auth import ${authNames.join(", ")}`);
  if (uses(/\bBaseModel\b|: (Credentials|RefreshRequest|ChangePasswordRequest|NotificationRequest)\b/)) lines.push("from pydantic import BaseModel");
  if (uses(/\blogger\./)) lines.push("import logging", "", "logger = logging.getLogger(__name__)");

  // Request bodies + helpers, defined only when a handler references them.
  if (uses(/\b_row\(/)) lines.push(`

def _row(item) -> dict:
    """ORM row → JSON-safe dict of its columns (password hashes never leave the service)."""
    return jsonable_encoder({c.name: getattr(item, c.name) for c in item.__table__.columns if not c.name.startswith("password")})`);
  if (uses(/\b_DUMMY_HASH\b/)) lines.push(`
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt())`);
  if (uses(/: Credentials\b/)) lines.push(`

class Credentials(BaseModel):
    email: str
    password: str`);
  if (uses(/: RefreshRequest\b/)) lines.push(`

class RefreshRequest(BaseModel):
    refresh_token: str`);
  if (uses(/: ChangePasswordRequest\b/)) lines.push(`

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str`);
  if (uses(/: NotificationRequest\b/)) lines.push(`

class NotificationRequest(BaseModel):
    recipient: str
    channel: str
    message: Optional[str] = None`);
  return [...new Set(lines)];
}

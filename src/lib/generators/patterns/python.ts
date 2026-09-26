import type { Endpoint, Entity, StackConfig } from "../types";
import { selfAuthUser, type PatternId, type SelfAuthUser } from "./index";
import { authProviderSpec } from "../auth/providers";
import { pyQueue } from "../queue/python";

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

// How auth_required verifies bearer tokens — mirrors goAuthMode:
//   jwks  — external provider configured: verify provider tokens via JWKS.
//   hs256 — auth "none" but auth_* patterns are used: the service issues its
//           own HS256 tokens (JWT_SECRET) and verifies exactly those.
//   off   — nothing to verify; no app/auth.py is emitted.
export type PyAuthMode = "jwks" | "hs256" | "off";
export function pyAuthMode(config: StackConfig, endpoints: Endpoint[]): PyAuthMode {
  const authPatterns = endpoints.some((e) => e.pattern?.startsWith("auth_"));
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

const stub = (why: string) => `async def handler():
    # ${why}
    raise HTTPException(status_code=501, detail="not_implemented")`;
const NO_ENTITY = stub("No entity matches this route — declare one (or wire this handler to your data layer).");
const NO_USER = stub("Declare a User entity with an `email` field and a uuid/string primary key to enable self-managed auth.");

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

function authLogin(u: SelfAuthUser): string {
  const U = u.entity.name;
  return `async def handler(credentials: Credentials, db: Session = Depends(get_db)):
    user = db.query(${U}).filter(${U}.${u.email.name} == credentials.email).first()
    cred = db.get(AuthCredential, user.${u.pk.name}) if user else None
    if not cred:
        # Burn a bcrypt check anyway so response timing doesn't reveal which emails exist.
        bcrypt.checkpw(credentials.password.encode(), _DUMMY_HASH)
        raise HTTPException(status_code=401, detail="invalid_credentials")
    if not bcrypt.checkpw(credentials.password.encode(), cred.password_hash.encode()):
        raise HTTPException(status_code=401, detail="invalid_credentials")
    return {"token": create_access_token(str(user.${u.pk.name})), "token_type": "Bearer"}`;
}

// The body carries email + password plus the User's own columns; required ones
// the client omits answer 400 by name, required dates are stamped with "now".
function authRegister(u: SelfAuthUser): string {
  const U = u.entity.name;
  const list = (fs: { name: string }[]) => `[${fs.map((f) => JSON.stringify(f.name)).join(", ")}]`;
  const cols = [
    `${u.email.name}=email`,
    // uuid PKs get a model default; string PKs are minted here.
    ...(u.pk.type === "uuid" ? [] : [`${u.pk.name}=str(uuid4())`]),
    ...u.dates.map((f) => `${f.name}=datetime.utcnow()`),
    ...(u.settable.length ? [`**{k: payload[k] for k in ${list(u.settable)} if k in payload}`] : []),
  ];
  return `async def handler(payload: dict, db: Session = Depends(get_db)):
    email, password = payload.get("email"), payload.get("password")
    if not isinstance(email, str) or not email or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="email and password required")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
${u.required.length ? `    missing = [f for f in ${list(u.required)} if payload.get(f) is None]
    if missing:
        raise HTTPException(status_code=400, detail="missing required fields: " + ", ".join(missing))
` : ""}    if db.query(${U}).filter(${U}.${u.email.name} == email).first():
        raise HTTPException(status_code=409, detail="email_already_registered")
    user = ${U}(${cols.join(", ")})
    db.add(user)
    db.flush()  # assigns the PK before the credential row references it
    db.add(AuthCredential(user_id=user.${u.pk.name}, password_hash=bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()))
    db.commit()
    token = create_access_token(str(user.${u.pk.name}))
    return JSONResponse(status_code=201, content={"token": token, "token_type": "Bearer", "user": {"id": str(user.${u.pk.name}), "email": user.${u.email.name}}})`;
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

function authChangePassword(): string {
  return `async def handler(
    payload: ChangePasswordRequest,
    claims: dict = Depends(auth_required),
    db: Session = Depends(get_db),
):
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    cred = db.query(AuthCredential).filter(AuthCredential.user_id == claims["sub"]).first()
    if not cred or not bcrypt.checkpw(payload.current_password.encode(), cred.password_hash.encode()):
        raise HTTPException(status_code=401, detail="invalid_current_password")
    cred.password_hash = bcrypt.hashpw(payload.new_password.encode(), bcrypt.gensalt()).decode()
    db.commit()
    return Response(status_code=204)`;
}

export const pyHasRedis = (c: StackConfig) => /redis|upstash|dragonfly/.test(c.cache);

function healthCheck(config: StackConfig, hasDb: boolean): string {
  const hasCache = pyHasRedis(config);
  const hasQueue = !!pyQueue(config);
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
` : ""}${hasQueue ? `    if await broker.ping():
        checks["queue"] = "ok"
    else:
        checks["queue"] = "degraded"
        http_status = 503
` : ""}    return JSONResponse(status_code=http_status, content=checks)`;
}

function webhookReceive(config: StackConfig): string {
  return `async def handler(request: Request):
    secret = os.getenv("WEBHOOK_SECRET", "")
    raw_body = await request.body()
    if secret:
        sig = request.headers.get("x-hub-signature-256", "")
        expected = "sha256=" + hmac_lib.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        if not hmac_lib.compare_digest(sig, expected):
            raise HTTPException(status_code=401, detail="invalid_signature")
${publish(config, "webhooks", '{"body": raw_body.decode("utf-8", "replace")}')}
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
  return `async def handler(payload: NotificationRequest):
    if not payload.recipient or not payload.channel:
        raise HTTPException(status_code=400, detail="recipient and channel required")
${publish(config, "notifications", "payload.model_dump()")}
    logger.info("notification queued", extra={"channel": payload.channel, "recipient": payload.recipient})
    return {"queued": True, "channel": payload.channel}`;
}

// Publish to the configured broker (app/queue.py, imported as `broker` by main.py);
// without one there is nowhere to hand the event off to, so answer 503.
function publish(config: StackConfig, topic: string, payload: string): string {
  if (!pyQueue(config)) {
    return `    # No queue configured — choose one in the builder to deliver this asynchronously.
    raise HTTPException(status_code=503, detail="no_queue_configured")`;
  }
  return `    try:
        await broker.publish("${topic}", ${payload})
    except Exception:
        logger.exception("queue publish failed", extra={"topic": "${topic}"})
        raise HTTPException(status_code=503, detail="queue_unavailable")`;
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
  const user = selfAuthUser(entities);
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
    case "auth_change_password": return authChangePassword();
    case "health_check": return healthCheck(config, hasDb);
    case "webhook_receive": return webhookReceive(config);
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
  config: StackConfig,
  entities: Entity[],
  mode: PyAuthMode = "off"
): string {
  const method = e.method.toLowerCase();
  const handlerBody = patternBody(e, config, entities, mode);
  const auth = e.auth && mode !== "off" ? ", dependencies=[Depends(auth_required)]" : "";
  const statusCode = method === "post" ? ", status_code=201" : method === "delete" ? ", status_code=204" : "";
  const body = handlerBody.replace(/^async def handler/, `async def ${fnName(e)}`);
  return `@app.${method}(${JSON.stringify(pyPath(e.path))}${statusCode}${auth})\n${body}`;
}

// ── Litestar / Django adapters ───────────────────────────────────────────────
// The pattern bodies above are FastAPI handlers. For Litestar and Django the
// body is kept and only the signature is translated: each parameter is
// classified by its FastAPI annotation / default and re-expressed natively.

type NativeFw = "litestar" | "django";
type Param = { name: string; type: string; dflt?: string };

function splitHandler(code: string): { params: Param[]; body: string } {
  const m = code.match(/^async def handler\(([\s\S]*?)\):\n([\s\S]*)$/)!;
  const params = m[1].split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const p = s.match(/^(\w+): ([\w[\]]+)(?: = (.+))?$/)!;
    return { name: p[1], type: p[2], dflt: p[3] };
  });
  return { params, body: m[2] };
}

export type NativeRoute = { name: string; method: string; path: string; code: string; db: boolean; claims: boolean };

function nativeRoute(e: Endpoint, fw: NativeFw, config: StackConfig, entities: Entity[], mode: PyAuthMode): NativeRoute {
  // logicCode is written against FastAPI; keep it visible but don't run it.
  const code = e.logicCode
    ? `async def handler():\n    # Custom logicCode targets FastAPI — port it to ${fw}:\n${e.logicCode.split("\n").map((l) => `    # ${l}`).join("\n")}\n    raise HTTPException(status_code=501, detail="not_implemented")`
    : patternBody(e, config, entities, mode);
  const { params, body } = splitHandler(code);
  const pathArgs = pathParams(e.path);
  const method = e.method.toLowerCase();
  const name = fnName(e);
  const sig: string[] = fw === "django" ? ["request", ...pathArgs] : pathArgs.map((p) => `${p}: str`);
  const pre: string[] = [];
  let db = false;
  let claims = false;
  for (const p of params) {
    if (!p.dflt && pathArgs.includes(p.name)) continue;
    const q = p.dflt?.match(/^Query\(([^,]+?)(?:, (.*))?\)$/);
    if (q) {
      const alias = q[2]?.match(/alias="(\w+)"/)?.[1];
      const bounds = q[2]?.replace(/,? ?alias="\w+"/, "");
      if (fw === "litestar") sig.push(`${p.name}: ${p.type} = Parameter(${alias ? `query="${alias}", ` : ""}${bounds ? bounds + ", " : ""}default=${q[1]})`);
      else if (p.type === "int") pre.push(`${p.name} = _qint(request, "${alias ?? p.name}", ${q[1]}${bounds ? ", " + bounds : ""})`);
      else pre.push(`${p.name} = request.GET.get("${alias ?? p.name}", ${q[1]})`);
    } else if (p.dflt === "Depends(get_db)") {
      db = true;
      sig.push(fw === "litestar" ? `${p.name}: Session` : p.name);
    } else if (p.dflt === "Depends(auth_required)") {
      claims = true;
      sig.push(fw === "litestar" ? `${p.name}: dict` : p.name);
    } else if (p.type === "Request") {
      if (fw === "litestar") sig.push("request: Request");
    } else if (p.type === "UploadFile") {
      if (fw === "litestar") {
        sig.push("data: UploadFile = Body(media_type=RequestEncodingType.MULTI_PART)");
        pre.push(`${p.name} = data`);
      } else {
        pre.push(`${p.name} = request.FILES.get("file")`, `if ${p.name} is None:`, `    raise HTTPException(status_code=400, detail="multipart field 'file' is required")`);
      }
    } else if (fw === "litestar") {
      // Litestar always injects the parsed request body as `data`.
      sig.push(`data: ${p.type}`);
      pre.push(`${p.name} = data`);
    } else {
      pre.push(p.type === "dict" ? `${p.name} = _json_body(request)` : `${p.name} = _model_body(request, ${p.type})`);
    }
  }
  const prologue = pre.map((l) => `    ${l}\n`).join("");
  const protect = e.auth && mode !== "off" && !claims; // a claims parameter already verifies the token
  if (fw === "litestar") {
    const out = body
      .replace(/\bResponse\(status_code=204\)/g, "Response(content=None, status_code=204)")
      .replace(/\bJSONResponse\(/g, "Response(");
    const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1:str}");
    // Python needs parameters without defaults first.
    const ordered = [...sig.filter((s) => !s.includes(" = ")), ...sig.filter((s) => s.includes(" = "))];
    // Litestar's DELETE default (204) rejects handlers that may return a body;
    // crud_delete still answers 204 through its explicit Response.
    const status = method === "delete" ? ", status_code=200" : "";
    return { name, method, path, db, claims,
      code: `@${method}(${JSON.stringify(path)}${status}${protect ? ", guards=[auth_guard]" : ""})\nasync def ${name}(${ordered.join(", ")}) -> Any:\n${prologue}${out}` };
  }
  const out = body
    .replace(/await request\.body\(\)/g, "request.body")
    .replace(/await file\.read\(\)/g, "file.read()")
    .replace(/\bfile\.filename\b/g, "file.name")
    .replace(/\bResponse\(status_code=204\)/g, "HttpResponse(status=204)")
    .replace(/\bJSONResponse\(status_code=([^,]+), content=(.*)\)$/gm, "JsonResponse($2, status=$1)");
  const opts = [
    method === "post" ? "status=201" : method === "delete" ? "status=204" : "",
    protect ? "auth=True" : "",
    claims ? "claims=True" : "",
    db ? "db=True" : "",
  ].filter(Boolean).join(", ");
  const path = e.path.replace(/^\//, "").replace(/:([a-zA-Z0-9_]+)/g, "<str:$1>");
  return { name, method, path, db, claims,
    code: `@_endpoint(${opts})\nasync def ${name}(${sig.join(", ")}):\n${prologue}${out}` };
}

/** Every endpoint (plain or patterned) as a native Litestar / Django handler. Skips the app's own GET /health and repeated method+path pairs. */
export function pyNativeRoutes(fw: NativeFw, endpoints: Endpoint[], config: StackConfig, entities: Entity[], mode: PyAuthMode): NativeRoute[] {
  const seen = new Set(["GET /health"]);
  return endpoints
    .filter((e) => {
      const key = `${e.method} ${e.path.replace(/\/+$/, "") || "/"}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((e) => nativeRoute(e, fw, config, entities, mode));
}

/**
 * Module-level lines app/main.py needs for the pattern handlers: imports plus
 * the request models / helpers their signatures reference. Derived from the
 * emitted handler code so every referenced name is defined exactly when used.
 */
export function pyPatternImports(endpoints: Endpoint[], config: StackConfig, entities: Entity[] = [], mode: PyAuthMode = "off"): string[] {
  const patterned = endpoints.filter((e) => e.pattern);
  if (!patterned.length) return [];
  return importLines(patterned.map((e) => patternBody(e, config, entities, mode)).join("\n"), "fastapi", entities);
}

/** pyPatternImports for handlers rendered by pyNativeRoutes. */
export function pyNativeImports(routes: NativeRoute[], fw: NativeFw, entities: Entity[]): string[] {
  return routes.length ? importLines(routes.map((r) => r.code).join("\n"), fw, entities) : [];
}

const REQUEST_MODELS = ["Credentials", "RefreshRequest", "ChangePasswordRequest", "NotificationRequest"];

function importLines(code: string, fw: "fastapi" | NativeFw, entities: Entity[]): string[] {
  const uses = (re: RegExp) => re.test(code);
  // A request model is used as a FastAPI/Litestar annotation or a Django _model_body argument.
  const usesModel = (n: string) => new RegExp(`: ${n}\\b|_model_body\\(request, ${n}\\)`).test(code);
  const lines: string[] = [];
  if (fw === "fastapi") {
    lines.push(
      // Names the handler signatures use as defaults / annotations — evaluated
      // at import time, so they must exist in both FastAPI entrypoints.
      "from typing import Optional",
      "from fastapi import Query, Request, Response",
      "from fastapi.responses import JSONResponse",
    );
    if (uses(/\bget_db\b/)) lines.push("from sqlalchemy.orm import Session", "from .db import get_db");
  } else if (fw === "litestar") {
    lines.push("from typing import Any");
    const core = ["Request", "Response"].filter((n) => new RegExp(`\\b${n}\\b`).test(code));
    if (core.length) lines.push(`from litestar import ${core.join(", ")}`);
    if (uses(/\bHTTPException\(/)) lines.push("from litestar.exceptions import HTTPException");
    const params = ["Body", "Parameter"].filter((n) => code.includes(n + "("));
    if (params.length) lines.push(`from litestar.params import ${params.join(", ")}`);
    if (uses(/\bUploadFile\b/)) lines.push("from litestar.datastructures import UploadFile", "from litestar.enums import RequestEncodingType");
    if (uses(/: Session\b/)) lines.push("from sqlalchemy.orm import Session");
  } else {
    lines.push("import functools");
    if (uses(/_model_body\(/)) lines.push("from pydantic import ValidationError");
  }
  // NotificationRequest declares an Optional field.
  if (fw !== "fastapi" && (uses(/\bOptional\b/) || usesModel("NotificationRequest"))) lines.push("from typing import Optional");
  const models = entities.filter((en) => new RegExp(`\\b${en.name}\\b`).test(code)).map((en) => en.name);
  if (uses(/\bAuthCredential\b/)) models.push("AuthCredential");
  if (models.length) lines.push(`from .models import ${[...new Set(models)].join(", ")}`);
  if (uses(/\b_row\(/)) lines.push(fw === "fastapi" ? "from fastapi.encoders import jsonable_encoder" : "import json");
  if (uses(/\bredis_client\b/)) lines.push("from .cache import redis_client");
  if (uses(/\bjson\.loads\b|_json_body\(|_model_body\(/)) lines.push("import json");
  if (uses(/\bmath\./)) lines.push("import math");
  if (uses(/\btext\(/)) lines.push("from sqlalchemy import text");
  if (uses(/\bor_\(/)) lines.push("from sqlalchemy import or_");
  if (uses(/\bhmac_lib\b/)) lines.push("import hmac as hmac_lib", "import hashlib", "import os");
  if (fw === "fastapi" && uses(/\bUploadFile\b/)) lines.push("from fastapi import UploadFile");
  if (uses(/\buuid4\(/)) lines.push("from uuid import uuid4");
  if (uses(/\bdatetime\.utcnow\(/)) lines.push("from datetime import datetime");
  if (uses(/\bbcrypt\./)) lines.push("import bcrypt");
  if (uses(/\bjwt\./)) lines.push("import jwt");
  const authNames = ["create_access_token", "verify_token"].filter((n) => code.includes(n + "("));
  if (authNames.length) lines.push(`from .auth import ${authNames.join(", ")}`);
  if (uses(/\bBaseModel\b/) || REQUEST_MODELS.some(usesModel)) lines.push("from pydantic import BaseModel");
  if (uses(/\blogger\./)) lines.push("import logging", "", "logger = logging.getLogger(__name__)");

  // Request bodies + helpers, defined only when a handler references them.
  if (uses(/\b_row\(/)) lines.push(`

def _row(item) -> dict:
    """ORM row → JSON-safe dict of its columns (password hashes never leave the service)."""
    return ${fw === "fastapi"
      ? `jsonable_encoder({c.name: getattr(item, c.name) for c in item.__table__.columns if not c.name.startswith("password")})`
      : `json.loads(json.dumps({c.name: getattr(item, c.name) for c in item.__table__.columns if not c.name.startswith("password")}, default=str))`}`);
  if (uses(/\b_DUMMY_HASH\b/)) lines.push(`
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt())`);
  if (usesModel("Credentials")) lines.push(`

class Credentials(BaseModel):
    email: str
    password: str`);
  if (usesModel("RefreshRequest")) lines.push(`

class RefreshRequest(BaseModel):
    refresh_token: str`);
  if (usesModel("ChangePasswordRequest")) lines.push(`

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str`);
  if (usesModel("NotificationRequest")) lines.push(`

class NotificationRequest(BaseModel):
    recipient: str
    channel: str
    message: Optional[str] = None`);
  if (fw === "django") {
    // Django has no HTTPException; _endpoint in main.py turns this one into a JSON error.
    lines.push(`

class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str = ""):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail`);
    if (uses(/_qint\(/)) lines.push(`

def _qint(request, key: str, default: int, ge: int | None = None, le: int | None = None) -> int:
    raw = request.GET.get(key)
    try:
        value = default if raw is None else int(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{key} must be an integer")
    if (ge is not None and value < ge) or (le is not None and value > le):
        raise HTTPException(status_code=422, detail=f"{key} is out of range")
    return value`);
    if (uses(/_json_body\(|_model_body\(/)) lines.push(`

def _json_body(request) -> dict:
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON object expected")
    return data`);
    if (uses(/_model_body\(/)) lines.push(`

def _model_body(request, model):
    try:
        return model.model_validate(_json_body(request))
    except ValidationError:
        raise HTTPException(status_code=422, detail="invalid request body")`);
  }
  return [...new Set(lines)];
}

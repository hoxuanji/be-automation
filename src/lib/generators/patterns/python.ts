import type { Endpoint, Entity, StackConfig } from "../types";
import type { PatternId } from "./index";

// ── helpers ───────────────────────────────────────────────────────────────────

function inferTableName(path: string): string {
  const skip = new Set(["api", "v1", "v2", "v3", "v4"]);
  const parts = path.split("/").filter((p) => p && !p.startsWith(":") && !skip.has(p));
  return parts[parts.length - 1] || "items";
}

function pyPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

function pathParams(p: string): string[] {
  return (p.match(/:([a-zA-Z0-9_]+)/g) ?? []).map((m) => m.slice(1));
}

type PyFw = "fastapi" | "django" | "litestar";

// ── pattern bodies (FastAPI primary) ─────────────────────────────────────────

function crudList(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    q: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    query = db.query(${model})
    if q:
        query = query.filter(${model}.name.ilike(f"%{q}%"))
    total = query.count()
    items = query.order_by(${model}.created_at.desc()).offset((page - 1) * limit).limit(limit).all()
    pages = max(1, math.ceil(total / limit))
    return {"data": items, "meta": {"page": page, "limit": limit, "total": total, "pages": pages}}`;
}

function crudGet(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(item_id: str, db: Session = Depends(get_db)):
    item = db.query(${model}).filter(${model}.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    return item`;
}

function crudCreate(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(payload: dict, db: Session = Depends(get_db)):
    item = ${model}(**payload)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item`;
}

function crudUpdate(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(item_id: str, payload: dict, db: Session = Depends(get_db)):
    item = db.query(${model}).filter(${model}.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    for key, value in payload.items():
        if key != "id" and hasattr(item, key):
            setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item`;
}

function crudDelete(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(item_id: str, db: Session = Depends(get_db)):
    item = db.query(${model}).filter(${model}.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")
    db.delete(item)
    db.commit()
    return Response(status_code=204)`;
}

function authLogin(): string {
  return `async def handler(credentials: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == credentials.email).first()
    if not user:
        # Constant-time compare to prevent timing-based user enumeration
        pwd_context.verify(credentials.password, "$2b$12$invalidhash")
        raise HTTPException(status_code=401, detail="invalid_credentials")
    if not pwd_context.verify(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid_credentials")
    token = create_access_token({"sub": str(user.id)})
    return {"token": token, "token_type": "Bearer"}`;
}

function authRegister(): string {
  return `async def handler(payload: RegisterRequest, db: Session = Depends(get_db)):
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="password must be at least 8 characters")
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="email_already_registered")
    user = User(
        id=str(uuid4()),
        email=payload.email,
        name=getattr(payload, "name", None),
        password_hash=pwd_context.hash(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token({"sub": str(user.id)})
    return JSONResponse(status_code=201, content={"token": token, "token_type": "Bearer", "user": {"id": user.id, "email": user.email}})`;
}

function authMe(): string {
  return `async def handler(sub: str = Depends(get_current_user)):
    # Optionally fetch full user: user = db.query(User).filter(User.id == sub).first()
    return {"sub": sub}`;
}

function authLogout(): string {
  return `async def handler(sub: str = Depends(get_current_user)):
    # Stateless JWT — client discards the token.
    # For server-side revocation: add token to a Redis blocklist.
    return Response(status_code=204)`;
}

function authRefresh(): string {
  return `async def handler(payload: RefreshRequest):
    try:
        data = jwt.decode(payload.refresh_token, settings.jwt_secret, algorithms=["HS256"])
        sub = data.get("sub")
        if not sub:
            raise HTTPException(status_code=401, detail="invalid_refresh_token")
        token = create_access_token({"sub": sub})
        return {"token": token, "token_type": "Bearer"}
    except JWTError:
        raise HTTPException(status_code=401, detail="invalid_refresh_token")`;
}

function authChangePassword(): string {
  return `async def handler(
    payload: ChangePasswordRequest,
    sub: str = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="new password must be at least 8 characters")
    user = db.query(User).filter(User.id == sub).first()
    if not user:
        raise HTTPException(status_code=404, detail="user not found")
    if not pwd_context.verify(payload.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid_current_password")
    user.password_hash = pwd_context.hash(payload.new_password)
    db.commit()
    return Response(status_code=204)`;
}

function healthCheck(config: StackConfig): string {
  const hasDB = config.database !== "none" && config.database !== "";
  const hasCache = /redis|upstash|dragonfly/.test(config.cache);
  return `async def handler(db: Session = Depends(get_db)):
    checks: dict = {"status": "ok"}
    http_status = 200
    ${hasDB ? `try:
        db.execute(text("SELECT 1"))
        checks["db"] = "ok"
    except Exception:
        checks["db"] = "degraded"
        http_status = 503` : "# db check omitted"}
    ${hasCache ? `# TODO: add Redis ping check
    # try: redis_client.ping(); checks["cache"] = "ok"
    # except: checks["cache"] = "degraded"; http_status = 503` : ""}
    return JSONResponse(status_code=http_status, content=checks)`;
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

function paginatedSearch(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(
    q: Optional[str] = Query(None),
    cursor: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(${model})
    if q:
        query = query.filter(
            or_(${model}.name.ilike(f"%{q}%"), ${model}.description.ilike(f"%{q}%"))
        )
    if cursor:
        ref = db.query(${model}).filter(${model}.id == cursor).first()
        if ref:
            query = query.filter(${model}.created_at < ref.created_at)
    items = query.order_by(${model}.created_at.desc()).limit(limit + 1).all()
    has_more = len(items) > limit
    if has_more:
        items = items[:limit]
    next_cursor = str(items[-1].id) if has_more and items else None
    return {"data": items, "next_cursor": next_cursor, "has_more": has_more}`;
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
    # await broker.publish("notifications", payload.dict())
    logger.info("notification queued", extra={"channel": payload.channel, "recipient": payload.recipient})
    return {"queued": True, "channel": payload.channel}`;
}

function cacheRead(table: string): string {
  const model = table.replace(/s$/, "").charAt(0).toUpperCase() + table.replace(/s$/, "").slice(1);
  return `async def handler(item_id: str, db: Session = Depends(get_db)):
    cache_key = f"${table}:{item_id}"
    # Check Redis cache
    # cached = await redis_client.get(cache_key)
    # if cached:
    #     return json.loads(cached)

    # Cache miss — fetch from DB
    item = db.query(${model}).filter(${model}.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="not found")

    # Populate cache (TTL 5 minutes)
    # await redis_client.set(cache_key, json.dumps(item.__dict__), ex=300)
    return item`;
}

function customHandler(e: Endpoint): string {
  return `async def handler():
    # ${e.logic || e.summary || "TODO: implement handler logic"}
    return {"ok": True, "op": "${e.method} ${e.path}"}`;
}

// ── route builder ─────────────────────────────────────────────────────────────

export function pyPatternRoute(
  e: Endpoint,
  fw: PyFw,
  config: StackConfig,
  _entities: Entity[]
): string {
  const table = inferTableName(e.path);
  const pattern = e.pattern as PatternId | undefined;
  const pyPathStr = pyPath(e.path);
  const params = pathParams(e.path);
  const method = e.method.toLowerCase();
  const auth = e.auth ? ", dependencies=[Depends(auth_required)]" : "";

  let handlerBody: string;
  switch (pattern) {
    case "crud_list":    handlerBody = crudList(table); break;
    case "crud_get":     handlerBody = crudGet(table); break;
    case "crud_create":  handlerBody = crudCreate(table); break;
    case "crud_update":  handlerBody = crudUpdate(table); break;
    case "crud_delete":  handlerBody = crudDelete(table); break;
    case "auth_login":   handlerBody = authLogin(); break;
    case "auth_register":handlerBody = authRegister(); break;
    case "auth_me":      handlerBody = authMe(); break;
    case "auth_logout":  handlerBody = authLogout(); break;
    case "auth_refresh": handlerBody = authRefresh(); break;
    case "auth_change_password": handlerBody = authChangePassword(); break;
    case "health_check": handlerBody = healthCheck(config); break;
    case "webhook_receive": handlerBody = webhookReceive(); break;
    case "file_upload":  handlerBody = fileUpload(); break;
    case "paginated_search": handlerBody = paginatedSearch(table); break;
    case "aggregate_stats":  handlerBody = aggregateStats(table); break;
    case "send_notification": handlerBody = sendNotification(config); break;
    case "cache_read":   handlerBody = cacheRead(table); break;
    default:             handlerBody = customHandler(e); break;
  }

  if (fw === "fastapi") {
    // Replace generic `handler` function name with a unique name based on path
    const fnName = `${method}_${table.replace(/-/g, "_")}`;
    const statusCode = method === "post" ? ", status_code=201" : method === "delete" ? ", status_code=204" : "";
    const body = handlerBody.replace(/^async def handler/, `async def ${fnName}`);
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

/** Extra imports needed in app/main.py when patterns require them */
export function pyPatternImports(endpoints: Endpoint[]): string[] {
  const patterns = endpoints.map((e) => e.pattern ?? "");
  const imports: string[] = [];
  if (patterns.some((p) => p.startsWith("auth_"))) {
    imports.push(
      "from passlib.context import CryptContext",
      "from jose import jwt, JWTError",
      "from uuid import uuid4",
    );
  }
  if (patterns.some((p) => p === "health_check")) {
    imports.push("from sqlalchemy import text");
  }
  if (patterns.some((p) => p === "webhook_receive")) {
    imports.push("import hmac as hmac_lib", "import hashlib", "import os");
  }
  if (patterns.some((p) => p === "file_upload")) {
    imports.push("from fastapi import UploadFile", "from uuid import uuid4");
  }
  if (patterns.some((p) => p === "paginated_search")) {
    imports.push("from sqlalchemy import or_");
  }
  if (patterns.some((p) => p === "aggregate_stats")) {
    imports.push("from sqlalchemy import text");
  }
  if (patterns.some((p) => p === "send_notification")) {
    imports.push("import logging", "logger = logging.getLogger(__name__)");
  }
  if (patterns.some((p) => p?.startsWith("crud_"))) {
    imports.push("import math");
  }
  return [...new Set(imports)];
}

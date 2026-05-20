import type { Endpoint, Entity, StackConfig } from "../types";
import type { PatternId } from "./index";
import type { GeneratedFile } from "../types";

// ── helpers ──────────────────────────────────────────────────────────────────

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

function handlerMethodName(e: Endpoint): string {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p)));
  return "Handle" + cap(e.method.toLowerCase()) + parts.join("");
}

function inferTableName(path: string): string {
  const skip = new Set(["api", "v1", "v2", "v3", "v4"]);
  const parts = path.split("/").filter((p) => p && !p.startsWith(":") && !skip.has(p));
  return parts[parts.length - 1] || "items";
}

function isDbPattern(p?: string): boolean {
  return !!p && (
    p.startsWith("crud_") ||
    p === "paginated_search" ||
    p === "aggregate_stats" ||
    p === "cache_read"
  );
}

function isRedisPattern(p?: string): boolean {
  return p === "cache_read";
}

// ── per-framework body generators ────────────────────────────────────────────

type Fw = "gin" | "fiber" | "echo" | "chi";

interface FwCtx {
  queryStr: (key: string, def?: string) => string;
  queryInt: (key: string, def: number) => string;
  pathParam: (name: string) => string;
  getBody: () => string;          // lines that bind body into `var body map[string]any`
  getBodyTyped: (typ: string) => string; // bind into typed struct
  sendJSON: (status: string, expr: string) => string;
  sendNoContent: () => string;
  retErr: (code: string, msg: string) => string; // return error response
  retOK: (expr: string) => string;
  retCreated: (expr: string) => string;
  afterReturn: string; // "" for gin, "return nil" isn't needed — or "return" for void
  sig: (name: string) => string;
}

function fwCtx(fw: Fw): FwCtx {
  if (fw === "gin") return {
    queryStr: (k, d = "") => `c.DefaultQuery(${JSON.stringify(k)}, ${JSON.stringify(d)})`,
    queryInt: (k, d) => `func() int { v, _ := strconv.Atoi(c.DefaultQuery(${JSON.stringify(k)}, ${JSON.stringify(String(d))})); return v }()`,
    pathParam: (n) => `c.Param(${JSON.stringify(n)})`,
    getBody: () => `\tvar body map[string]any\n\tif err := c.ShouldBindJSON(&body); err != nil {\n\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})\n\t\treturn\n\t}`,
    getBodyTyped: (t) => `\tvar body ${t}\n\tif err := c.ShouldBindJSON(&body); err != nil {\n\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})\n\t\treturn\n\t}`,
    sendJSON: (s, e) => `c.JSON(${s}, ${e})`,
    sendNoContent: () => `c.Status(http.StatusNoContent)`,
    retErr: (code, msg) => `c.JSON(${code}, gin.H{"error": ${JSON.stringify(msg)}})\n\t\treturn`,
    retOK: (e) => `c.JSON(http.StatusOK, ${e})`,
    retCreated: (e) => `c.JSON(http.StatusCreated, ${e})`,
    afterReturn: "return",
    sig: (name) => `func (h *APIHandlers) ${name}(c *gin.Context)`,
  };

  if (fw === "fiber") return {
    queryStr: (k, d = "") => `c.Query(${JSON.stringify(k)}, ${JSON.stringify(d)})`,
    queryInt: (k, d) => `c.QueryInt(${JSON.stringify(k)}, ${String(d)})`,
    pathParam: (n) => `c.Params(${JSON.stringify(n)})`,
    getBody: () => `\tvar body map[string]any\n\tif err := c.BodyParser(&body); err != nil {\n\t\treturn c.Status(http.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})\n\t}`,
    getBodyTyped: (t) => `\tvar body ${t}\n\tif err := c.BodyParser(&body); err != nil {\n\t\treturn c.Status(http.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})\n\t}`,
    sendJSON: (s, e) => `return c.Status(${s}).JSON(${e})`,
    sendNoContent: () => `return c.SendStatus(http.StatusNoContent)`,
    retErr: (code, msg) => `return c.Status(${code}).JSON(fiber.Map{"error": ${JSON.stringify(msg)}})`,
    retOK: (e) => `return c.JSON(${e})`,
    retCreated: (e) => `return c.Status(http.StatusCreated).JSON(${e})`,
    afterReturn: "return nil",
    sig: (name) => `func (h *APIHandlers) ${name}(c *fiber.Ctx) error`,
  };

  if (fw === "echo") return {
    queryStr: (k, d = "") => `func() string { v := c.QueryParam(${JSON.stringify(k)}); if v == "" { return ${JSON.stringify(d)} }; return v }()`,
    queryInt: (k, d) => `func() int { v, _ := strconv.Atoi(c.QueryParam(${JSON.stringify(k)})); if v == 0 { return ${String(d)} }; return v }()`,
    pathParam: (n) => `c.Param(${JSON.stringify(n)})`,
    getBody: () => `\tvar body map[string]any\n\tif err := c.Bind(&body); err != nil {\n\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})\n\t}`,
    getBodyTyped: (t) => `\tvar body ${t}\n\tif err := c.Bind(&body); err != nil {\n\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})\n\t}`,
    sendJSON: (s, e) => `return c.JSON(${s}, ${e})`,
    sendNoContent: () => `return c.NoContent(http.StatusNoContent)`,
    retErr: (code, msg) => `return c.JSON(${code}, map[string]any{"error": ${JSON.stringify(msg)}})`,
    retOK: (e) => `return c.JSON(http.StatusOK, ${e})`,
    retCreated: (e) => `return c.JSON(http.StatusCreated, ${e})`,
    afterReturn: "return nil",
    sig: (name) => `func (h *APIHandlers) ${name}(c echo.Context) error`,
  };

  // chi (stdlib)
  return {
    queryStr: (k, d = "") => `func() string { v := r.URL.Query().Get(${JSON.stringify(k)}); if v == "" { return ${JSON.stringify(d)} }; return v }()`,
    queryInt: (k, d) => `func() int { v, _ := strconv.Atoi(r.URL.Query().Get(${JSON.stringify(k)})); if v == 0 { return ${String(d)} }; return v }()`,
    pathParam: (n) => `chi.URLParam(r, ${JSON.stringify(n)})`,
    getBody: () => `\tvar body map[string]any\n\tif err := json.NewDecoder(r.Body).Decode(&body); err != nil {\n\t\twriteJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})\n\t\treturn\n\t}`,
    getBodyTyped: (t) => `\tvar body ${t}\n\tif err := json.NewDecoder(r.Body).Decode(&body); err != nil {\n\t\twriteJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})\n\t\treturn\n\t}`,
    sendJSON: (s, e) => `writeJSON(w, ${s}, ${e})`,
    sendNoContent: () => `w.WriteHeader(http.StatusNoContent)`,
    retErr: (code, msg) => `writeJSON(w, ${code}, map[string]any{"error": ${JSON.stringify(msg)}})\n\t\treturn`,
    retOK: (e) => `writeJSON(w, http.StatusOK, ${e})`,
    retCreated: (e) => `writeJSON(w, http.StatusCreated, ${e})`,
    afterReturn: "return",
    sig: (name) => `func (h *APIHandlers) ${name}(w http.ResponseWriter, r *http.Request)`,
  };
}

// ── pattern bodies ────────────────────────────────────────────────────────────

function mapLit(fw: Fw, ...pairs: [string, string][]): string {
  if (fw === "gin") return `gin.H{${pairs.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")}}`;
  if (fw === "fiber") return `fiber.Map{${pairs.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")}}`;
  return `map[string]any{${pairs.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(", ")}}`;
}

function dbNilCheck(fw: Fw): string {
  const m = mapLit(fw, ["error", '"database_not_configured"']);
  if (fw === "gin") return `\tif h.db == nil {\n\t\tc.JSON(http.StatusServiceUnavailable, ${m})\n\t\treturn\n\t}`;
  if (fw === "fiber") return `\tif h.db == nil {\n\t\treturn c.Status(http.StatusServiceUnavailable).JSON(${m})\n\t}`;
  if (fw === "echo") return `\tif h.db == nil {\n\t\treturn c.JSON(http.StatusServiceUnavailable, ${m})\n\t}`;
  return `\tif h.db == nil {\n\t\twriteJSON(w, http.StatusServiceUnavailable, ${m})\n\t\treturn\n\t}`;
}

function redisNilCheck(fw: Fw): string {
  const m = mapLit(fw, ["error", '"cache_not_configured"']);
  if (fw === "gin") return `\tif h.rdb == nil {\n\t\tc.JSON(http.StatusServiceUnavailable, ${m})\n\t\treturn\n\t}`;
  if (fw === "fiber") return `\tif h.rdb == nil {\n\t\treturn c.Status(http.StatusServiceUnavailable).JSON(${m})\n\t}`;
  if (fw === "echo") return `\tif h.rdb == nil {\n\t\treturn c.JSON(http.StatusServiceUnavailable, ${m})\n\t}`;
  return `\tif h.rdb == nil {\n\t\twriteJSON(w, http.StatusServiceUnavailable, ${m})\n\t\treturn\n\t}`;
}

function crudList(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  const meta = mapLit(fw, ["page", "page"], ["limit", "limit"], ["total", "total"], ["pages", "pages"]);
  return `${dbNilCheck(fw)}
\tpage := ${x.queryInt("page", 1)}
\tlimit := ${x.queryInt("limit", 20)}
\tif page < 1 { page = 1 }
\tif limit < 1 || limit > 100 { limit = 20 }

\tq := h.db.Table(${JSON.stringify(table)})
\tif s := strings.TrimSpace(${x.queryStr("q")}); s != "" {
\t\tq = q.Where("name ILIKE ?", "%"+s+"%")
\t}

\tvar total int64
\tq.Count(&total)

\tvar rows []map[string]any
\tif err := q.Order("created_at DESC").Offset((page-1)*limit).Limit(limit).Scan(&rows).Error; err != nil {
\t\th.log.Error("list", "table", ${JSON.stringify(table)}, "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}

\tpages := (total + int64(limit) - 1) / int64(limit)
\tif pages < 1 { pages = 1 }
\t${x.retOK(mapLit(fw, ["data", "rows"], ["meta", meta]))}`;
}

function crudGet(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\tid := ${x.pathParam("id")}

\tvar row map[string]any
\tif err := h.db.Table(${JSON.stringify(table)}).Where("id = ?", id).First(&row).Error; err != nil {
\t\t${x.retErr("http.StatusNotFound", "not found")}
\t}
\t${x.retOK("row")}`;
}

function crudCreate(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
${x.getBody()}

\tif len(body) == 0 {
\t\t${x.retErr("http.StatusBadRequest", "empty request body")}
\t}

\tif err := h.db.Table(${JSON.stringify(table)}).Create(&body).Error; err != nil {
\t\th.log.Error("create", "table", ${JSON.stringify(table)}, "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\t${x.retCreated("body")}`;
}

function crudUpdate(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\tid := ${x.pathParam("id")}

\tvar existing map[string]any
\tif err := h.db.Table(${JSON.stringify(table)}).Where("id = ?", id).First(&existing).Error; err != nil {
\t\t${x.retErr("http.StatusNotFound", "not found")}
\t}

${x.getBody()}

\tdelete(body, "id")
\tif err := h.db.Table(${JSON.stringify(table)}).Where("id = ?", id).Updates(body).Error; err != nil {
\t\th.log.Error("update", "table", ${JSON.stringify(table)}, "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}

\tfor k, v := range body { existing[k] = v }
\t${x.retOK("existing")}`;
}

function crudDelete(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\tid := ${x.pathParam("id")}

\tresult := h.db.Table(${JSON.stringify(table)}).Where("id = ?", id).Delete(nil)
\tif result.Error != nil {
\t\th.log.Error("delete", "table", ${JSON.stringify(table)}, "err", result.Error)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\tif result.RowsAffected == 0 {
\t\t${x.retErr("http.StatusNotFound", "not found")}
\t}
\t${x.sendNoContent()}`;
}

// Simplified auth bodies — full version replaced by framework-aware helpers below
function _authLoginUnused(fw: Fw): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\ttype creds struct {
\t\tEmail    string \`json:"email"\`
\t\tPassword string \`json:"password"\`
\t}
\tvar req creds
\n\t// Fetch user record
\tvar user map[string]any
\tif err := h.db.Table("users").Where("email = ?", req.Email).First(&user).Error; err != nil {
\t\t// Constant-time compare prevents user enumeration
\t\t_ = bcrypt.CompareHashAndPassword([]byte("$2a$12$invalid"), []byte(req.Password))
\t\t${x.retErr("http.StatusUnauthorized", "invalid_credentials")}
\t}

\thash, _ := user["password_hash"].(string)
\tif err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)); err != nil {
\t\t${x.retErr("http.StatusUnauthorized", "invalid_credentials")}
\t}

\ttoken, err := issueJWT(user["id"], h.jwtSecret())
\tif err != nil {
\t\th.log.Error("jwt sign", "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\t${x.retOK(mapLit(fw, ["token", "token"], ["token_type", '"Bearer"']))}`;
}

function authLoginFw(fw: Fw): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\ttype loginReq struct {
\t\tEmail    string \`json:"email"\`
\t\tPassword string \`json:"password"\`
\t}
${x.getBodyTyped("loginReq")}

\tvar user struct {
\t\tID           string \`json:"id"\`
\t\tPasswordHash string \`json:"password_hash"\`
\t}
\tif err := h.db.Table("users").Where("email = ?", body.Email).First(&user).Error; err != nil {
\t\t_ = bcrypt.CompareHashAndPassword([]byte("$2a$12$invalid"), []byte(body.Password))
\t\t${x.retErr("http.StatusUnauthorized", "invalid_credentials")}
\t}
\tif err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.Password)); err != nil {
\t\t${x.retErr("http.StatusUnauthorized", "invalid_credentials")}
\t}
\ttoken, err := h.issueJWT(user.ID)
\tif err != nil {
\t\th.log.Error("jwt sign", "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\t${x.retOK(mapLit(fw, ["token", "token"], ["token_type", '"Bearer"']))}`;
}

function authRegisterFw(fw: Fw): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\ttype regReq struct {
\t\tEmail    string \`json:"email"\`
\t\tPassword string \`json:"password"\`
\t\tName     string \`json:"name"\`
\t}
${x.getBodyTyped("regReq")}

\tif body.Email == "" || body.Password == "" {
\t\t${x.retErr("http.StatusBadRequest", "email and password required")}
\t}
\tif len(body.Password) < 8 {
\t\t${x.retErr("http.StatusBadRequest", "password must be at least 8 characters")}
\t}

\tvar count int64
\th.db.Table("users").Where("email = ?", body.Email).Count(&count)
\tif count > 0 {
\t\t${x.retErr("http.StatusConflict", "email_already_registered")}
\t}

\thash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
\tif err != nil {
\t\th.log.Error("bcrypt", "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}

\tuser := map[string]any{
\t\t"id":            generateID(),
\t\t"email":         body.Email,
\t\t"name":          body.Name,
\t\t"password_hash": string(hash),
\t\t"created_at":    time.Now().UTC(),
\t}
\tif err := h.db.Table("users").Create(&user).Error; err != nil {
\t\th.log.Error("create user", "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}

\ttoken, err := h.issueJWT(user["id"].(string))
\tif err != nil {
\t\th.log.Error("jwt sign", "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\tdelete(user, "password_hash")
\t${x.retCreated(mapLit(fw, ["token", "token"], ["token_type", '"Bearer"'], ["user", "user"]))}`;
}

function authMeFw(fw: Fw): string {
  const x = fwCtx(fw);
  return `\tsub, ok := h.claimsFromContext(${fw === "gin" ? "c" : fw === "fiber" ? "c" : fw === "echo" ? "c" : "r"})
\tif !ok {
\t\t${x.retErr("http.StatusUnauthorized", "missing_or_invalid_token")}
\t}
\t${x.retOK(mapLit(fw, ["sub", "sub"]))}`;
}

function authLogout(fw: Fw): string {
  const x = fwCtx(fw);
  return `\t// Stateless JWT — client discards the token. Server-side revocation
\t// requires a token blocklist (Redis recommended). Add token to blocklist here.
\t${x.sendNoContent()}`;
}

function authRefreshFw(fw: Fw): string {
  const x = fwCtx(fw);
  return `\ttype refreshReq struct { RefreshToken string \`json:"refresh_token"\` }
${x.getBodyTyped("refreshReq")}
\tif body.RefreshToken == "" {
\t\t${x.retErr("http.StatusBadRequest", "refresh_token required")}
\t}
\tsub, err := h.verifyRefreshToken(body.RefreshToken)
\tif err != nil {
\t\t${x.retErr("http.StatusUnauthorized", "invalid_refresh_token")}
\t}
\taccess, err := h.issueJWT(sub)
\tif err != nil {
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\t${x.retOK(mapLit(fw, ["token", "access"], ["token_type", '"Bearer"']))}`;
}

function authChangePasswordFw(fw: Fw): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\ttype cpReq struct {
\t\tCurrentPassword string \`json:"current_password"\`
\t\tNewPassword      string \`json:"new_password"\`
\t}
${x.getBodyTyped("cpReq")}
\tif len(body.NewPassword) < 8 {
\t\t${x.retErr("http.StatusBadRequest", "new password must be at least 8 characters")}
\t}
\tsub, ok := h.claimsFromContext(${fw === "gin" ? "c" : fw === "fiber" ? "c" : fw === "echo" ? "c" : "r"})
\tif !ok {
\t\t${x.retErr("http.StatusUnauthorized", "missing_or_invalid_token")}
\t}
\tvar user struct{ PasswordHash string \`json:"password_hash"\` }
\tif err := h.db.Table("users").Where("id = ?", sub).First(&user).Error; err != nil {
\t\t${x.retErr("http.StatusNotFound", "user not found")}
\t}
\tif err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(body.CurrentPassword)); err != nil {
\t\t${x.retErr("http.StatusUnauthorized", "invalid_current_password")}
\t}
\thash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
\tif err != nil {
\t\t${x.retErr("http.StatusInternalServerError", "internal server error")}
\t}
\th.db.Table("users").Where("id = ?", sub).Update("password_hash", string(hash))
\t${x.sendNoContent()}`;
}

function healthCheck(fw: Fw, config: StackConfig): string {
  const x = fwCtx(fw);
  const hasDB = config.database !== "none" && config.database !== "";
  const hasCache = /redis|upstash|dragonfly/.test(config.cache);
  const checks = mapLit(fw,
    ["status", '"ok"'],
    ...(hasDB ? [["db", "dbStatus"] as [string, string]] : []),
    ...(hasCache ? [["cache", "cacheStatus"] as [string, string]] : []),
  );
  return `\tdbStatus := "ok"
\tif h.db != nil {
\t\tif sqlDB, err := h.db.DB(); err != nil || sqlDB.Ping() != nil {
\t\t\tdbStatus = "degraded"
\t\t}
\t}
\tcacheStatus := "ok"
\tif h.rdb != nil {
\t\tctx, cancel := context.WithTimeout(${fw === "gin" ? "c.Request.Context()" : fw === "fiber" ? "context.Background()" : fw === "echo" ? "c.Request().Context()" : "r.Context()"}, 500*time.Millisecond)
\t\tdefer cancel()
\t\tif err := h.rdb.Ping(ctx).Err(); err != nil {
\t\t\tcacheStatus = "degraded"
\t\t}
\t}
\tstatus := http.StatusOK
\tif dbStatus == "degraded" || cacheStatus == "degraded" { status = http.StatusServiceUnavailable }
\t${x.sendJSON("status", checks)}`;
}

function webhookReceive(fw: Fw): string {
  const x = fwCtx(fw);
  return `\tconst sigHeader = "X-Hub-Signature-256"
\tsecret := os.Getenv("WEBHOOK_SECRET")
\tif secret == "" {
\t\th.log.Warn("WEBHOOK_SECRET not set — accepting unsigned payloads")
\t}
${fw === "chi" ? `\tbody, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "payload too large")}
\t}` :
fw === "gin" ? `\trawBody, err := io.ReadAll(c.Request.Body)
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "cannot read body")}
\t}` :
fw === "fiber" ? `\trawBody := c.Body()` :
`\trawBody, err := io.ReadAll(r.Body)
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "cannot read body")}
\t}`}

\tif secret != "" {
\t\t${fw === "gin" ? "sig := c.GetHeader(sigHeader)" : fw === "fiber" ? "sig := string(c.Request().Header.Peek(sigHeader))" : fw === "echo" ? "sig := c.Request().Header.Get(sigHeader)" : "sig := r.Header.Get(sigHeader)"}
\t\tmac := hmac.New(sha256.New, []byte(secret))
\t\t${fw === "chi" ? "mac.Write(body)" : "mac.Write(rawBody)"}
\t\texpected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
\t\tif !hmac.Equal([]byte(sig), []byte(expected)) {
\t\t\t${x.retErr("http.StatusUnauthorized", "invalid_signature")}
\t\t}
\t}

\t// TODO: enqueue event for async processing
\th.log.Info("webhook received", "bytes", ${fw === "chi" ? "len(body)" : "len(rawBody)"})
\t${x.retOK(mapLit(fw, ["received", "true"]))}`;
}

function fileUpload(fw: Fw): string {
  const x = fwCtx(fw);
  const allowedMimes = `[]string{"image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"}`;
  return `\tconst maxSize = 10 << 20 // 10 MB
\tconst uploadDir = "uploads"

${fw === "gin" ? `\tc.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxSize)
\tfile, header, err := c.Request.FormFile("file")
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "file field required")}
\t}
\tdefer file.Close()
\tmimeType := header.Header.Get("Content-Type")` :
fw === "fiber" ? `\tfile, err := c.FormFile("file")
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "file field required")}
\t}
\tf, err := file.Open()
\tif err != nil {
\t\t${x.retErr("http.StatusInternalServerError", "cannot open upload")}
\t}
\tdefer f.Close()
\tmimeType := file.Header.Get("Content-Type")` :
fw === "echo" ? `\tform, err := c.MultipartForm()
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "multipart parse failed")}
\t}
\tfiles := form.File["file"]
\tif len(files) == 0 {
\t\t${x.retErr("http.StatusBadRequest", "file field required")}
\t}
\theader := files[0]
\tf, _ := header.Open(); defer f.Close()
\tmimeType := header.Header.Get("Content-Type")` :
`\tr.Body = http.MaxBytesReader(w, r.Body, maxSize)
\tif err := r.ParseMultipartForm(maxSize); err != nil {
\t\t${x.retErr("http.StatusBadRequest", "multipart parse failed")}
\t}
\tfile, header, err := r.FormFile("file")
\tif err != nil {
\t\t${x.retErr("http.StatusBadRequest", "file field required")}
\t}
\tdefer file.Close()
\tmimeType := header.Header.Get("Content-Type")`}

\tif mimeType == "" { mimeType, _ = mime.ExtensionsByType(filepath.Ext(header.Filename)); _ = mimeType }
\tallowed := ${allowedMimes}
\tvalidMime := false
\tfor _, m := range allowed { if m == mimeType { validMime = true; break } }
\tif !validMime {
\t\t${x.retErr("http.StatusUnsupportedMediaType", "unsupported file type")}
\t}

\t// TODO: Replace with cloud storage (S3, GCS, R2). Writing to disk is a placeholder.
\tdestName := fmt.Sprintf("%s-%s", generateID(), filepath.Base(header.Filename))
\tdestPath := filepath.Join(uploadDir, destName)
\t_ = os.MkdirAll(uploadDir, 0o750)
\t// ... stream file to destPath
\th.log.Info("file uploaded", "name", destName, "mime", mimeType)
\t${x.retCreated(mapLit(fw, ["id", "destName"], ["url", '"/uploads/"+destName'], ["mime", "mimeType"]))}`;
}

function paginatedSearch(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\tq := ${x.queryStr("q")}
\tcursor := ${x.queryStr("cursor")}
\tlimit := ${x.queryInt("limit", 20)}
\tif limit < 1 || limit > 100 { limit = 20 }

\tgq := h.db.Table(${JSON.stringify(table)})
\tif q != "" {
\t\tgq = gq.Where("name ILIKE ? OR description ILIKE ?", "%"+q+"%", "%"+q+"%")
\t}
\tif cursor != "" {
\t\tgq = gq.Where("created_at < (SELECT created_at FROM ${table} WHERE id = ?)", cursor)
\t}

\tvar rows []map[string]any
\tif err := gq.Order("created_at DESC").Limit(limit+1).Scan(&rows).Error; err != nil {
\t\t${x.retErr("http.StatusInternalServerError", "search failed")}
\t}

\thasMore := len(rows) > limit
\tif hasMore { rows = rows[:limit] }
\tnextCursor := ""
\tif hasMore && len(rows) > 0 {
\t\tif id, ok := rows[len(rows)-1]["id"].(string); ok { nextCursor = id }
\t}
\t${x.retOK(mapLit(fw, ["data", "rows"], ["next_cursor", "nextCursor"], ["has_more", "hasMore"]))}`;
}

function aggregateStats(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${dbNilCheck(fw)}
\tgroupBy := ${x.queryStr("group_by", "created_at::date")}
\tfrom := ${x.queryStr("from")}
\tto := ${x.queryStr("to")}

\tgq := h.db.Table(${JSON.stringify(table)}).
\t\tSelect("DATE_TRUNC('day', created_at) AS period, COUNT(*) AS count, SUM(amount) AS total").
\t\tGroup(groupBy).
\t\tOrder("period DESC")
\tif from != "" { gq = gq.Where("created_at >= ?", from) }
\tif to != "" { gq = gq.Where("created_at <= ?", to) }

\tvar rows []map[string]any
\tif err := gq.Scan(&rows).Error; err != nil {
\t\th.log.Error("aggregate stats", "table", ${JSON.stringify(table)}, "err", err)
\t\t${x.retErr("http.StatusInternalServerError", "stats query failed")}
\t}
\t${x.retOK(mapLit(fw, ["data", "rows"]))}`;
}

function sendNotification(fw: Fw, config: StackConfig): string {
  const x = fwCtx(fw);
  const queueHint = config.queue === "kafka"
    ? "Kafka producer — use confluent-kafka-go or segmentio/kafka-go"
    : config.queue === "rabbitmq"
    ? "RabbitMQ — use github.com/rabbitmq/amqp091-go"
    : config.queue === "nats"
    ? "NATS — use github.com/nats-io/nats.go"
    : "message queue — configure broker URL via env";
  return `\ttype notifReq struct {
\t\tRecipient string \`json:"recipient"\`
\t\tChannel   string \`json:"channel"\` // "email" | "sms" | "push"
\t\tTemplate  string \`json:"template"\`
\t\tPayload   map[string]any \`json:"payload"\`
\t}
${x.getBodyTyped("notifReq")}
\tif body.Recipient == "" || body.Channel == "" {
\t\t${x.retErr("http.StatusBadRequest", "recipient and channel required")}
\t}

\t// TODO: publish to ${queueHint}
\t// Example: broker.Publish("notifications", body)
\th.log.Info("notification queued", "channel", body.Channel, "recipient", body.Recipient)
\t${x.retOK(mapLit(fw, ["queued", "true"], ["channel", "body.Channel"]))}`;
}

function cacheRead(fw: Fw, table: string): string {
  const x = fwCtx(fw);
  return `${redisNilCheck(fw)}
\tid := ${x.pathParam("id")}
\tcacheKey := fmt.Sprintf(${JSON.stringify(table + ":%s")}, id)

\tctx${fw === "gin" ? " := c.Request.Context()" : fw === "fiber" ? " := context.Background()" : fw === "echo" ? " := c.Request().Context()" : " := r.Context()"}
\tval, err := h.rdb.Get(ctx, cacheKey).Result()
\tif err == nil {
\t\t// Cache hit — return parsed JSON
\t\tvar cached map[string]any
\t\tif jsonErr := json.Unmarshal([]byte(val), &cached); jsonErr == nil {
\t\t\t${x.retOK("cached")}
\t\t}
\t}

\t// Cache miss — fetch from DB
\tif h.db == nil {
\t\t${x.retErr("http.StatusServiceUnavailable", "database_not_configured")}
\t}
\tvar row map[string]any
\tif err := h.db.Table(${JSON.stringify(table)}).Where("id = ?", id).First(&row).Error; err != nil {
\t\t${x.retErr("http.StatusNotFound", "not found")}
\t}

\t// Populate cache (ignore errors — degraded cache is acceptable)
\tif data, jsonErr := json.Marshal(row); jsonErr == nil {
\t\t_ = h.rdb.Set(ctx, cacheKey, data, 5*time.Minute).Err()
\t}
\t${x.retOK("row")}`;
}

function customHandler(fw: Fw, e: Endpoint): string {
  if (e.logicCode) return e.logicCode;
  const x = fwCtx(fw);
  return `\t// ${e.logic || e.summary || "TODO: implement handler logic"}
\t// Pattern: custom — implement business logic here.
\t${x.retOK(mapLit(fw, ["ok", "true"], ["op", JSON.stringify(e.method + " " + e.path)]))}`;
}

function patternBody(pattern: string | undefined, fw: Fw, e: Endpoint, config: StackConfig, _entities: Entity[]): string {
  const table = inferTableName(e.path);
  switch (pattern as PatternId) {
    case "crud_list":    return crudList(fw, table);
    case "crud_get":     return crudGet(fw, table);
    case "crud_create":  return crudCreate(fw, table);
    case "crud_update":  return crudUpdate(fw, table);
    case "crud_delete":  return crudDelete(fw, table);
    case "auth_login":   return authLoginFw(fw);
    case "auth_register":return authRegisterFw(fw);
    case "auth_me":      return authMeFw(fw);
    case "auth_logout":  return authLogout(fw);
    case "auth_refresh": return authRefreshFw(fw);
    case "auth_change_password": return authChangePasswordFw(fw);
    case "health_check": return healthCheck(fw, config);
    case "webhook_receive": return webhookReceive(fw);
    case "file_upload":  return fileUpload(fw);
    case "paginated_search": return paginatedSearch(fw, table);
    case "aggregate_stats":  return aggregateStats(fw, table);
    case "send_notification": return sendNotification(fw, config);
    case "cache_read":   return cacheRead(fw, table);
    default:             return customHandler(fw, e);
  }
}

// ── imports ───────────────────────────────────────────────────────────────────

function buildImports(module: string, fw: Fw, usedPatterns: Set<string>, config: StackConfig): string {
  const std: string[] = ['"context"', '"encoding/json"', '"fmt"', '"log/slog"', '"net/http"', '"os"', '"strings"', '"sync"', '"time"'];
  const ext: string[] = [];

  const needsStrconv = [...usedPatterns].some(p => p?.startsWith("crud_") || p === "paginated_search" || p === "aggregate_stats");
  if (needsStrconv) std.push('"strconv"');

  const needsBcrypt = [...usedPatterns].some(p => p === "auth_login" || p === "auth_register" || p === "auth_change_password");
  if (needsBcrypt) ext.push('"golang.org/x/crypto/bcrypt"');

  const needsJwt = [...usedPatterns].some(p => p?.startsWith("auth_"));
  if (needsJwt) ext.push('"github.com/golang-jwt/jwt/v5"');

  const needsHmac = usedPatterns.has("webhook_receive");
  if (needsHmac) { std.push('"crypto/hmac"', '"crypto/sha256"', '"encoding/hex"', '"io"'); }

  const needsMime = usedPatterns.has("file_upload");
  if (needsMime) { std.push('"mime"', '"path/filepath"'); }

  const needsUUID = [...usedPatterns].some(p => p === "auth_register" || p === "file_upload");
  if (needsUUID) ext.push('"github.com/google/uuid"');

  const needsDb = [...usedPatterns].some(p => isDbPattern(p));
  if (needsDb) {
    ext.push('"gorm.io/gorm"', '"gorm.io/driver/postgres"');
    ext.push(`"${module}/internal/db"`);
  }

  const needsRedis = [...usedPatterns].some(p => isRedisPattern(p)) || config.cache === "redis" || config.cache === "upstash" || config.cache === "dragonfly";
  if (needsRedis) ext.push('"github.com/redis/go-redis/v9"');

  if (fw === "gin") ext.push('"github.com/gin-gonic/gin"');
  else if (fw === "fiber") ext.push('"github.com/gofiber/fiber/v2"');
  else if (fw === "echo") ext.push('"github.com/labstack/echo/v4"');
  else ext.push('"github.com/go-chi/chi/v5"');

  const stdBlock = [...new Set(std)].sort().map(i => `\t${i}`).join("\n");
  const extBlock = [...new Set(ext)].sort().map(i => `\t${i}`).join("\n");

  return `import (\n${stdBlock}\n\n${extBlock}\n)`;
}

// ── struct + helpers ──────────────────────────────────────────────────────────

function buildStruct(fw: Fw, _usedPatterns: Set<string>, _config: StackConfig): string {
  const chiHelper = fw === "chi" ? `
func writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}` : "";

  return `type APIHandlers struct {
\tlog    *slog.Logger
\tdb     *gorm.DB       // lazily initialized from DATABASE_URL
\trdb    *redis.Client  // lazily initialized from REDIS_URL
\tdbOnce sync.Once
\trOnce  sync.Once
}

func NewAPIHandlers(log *slog.Logger) *APIHandlers {
\treturn &APIHandlers{log: log}
}

func (h *APIHandlers) getDB() *gorm.DB {
\th.dbOnce.Do(func() {
\t\tdsn := os.Getenv("DATABASE_URL")
\t\tif dsn == "" { return }
\t\tgdb, err := db.OpenGorm(dsn)
\t\tif err != nil {
\t\t\th.log.Error("api_handlers: db open", "err", err)
\t\t\treturn
\t\t}
\t\th.db = gdb
\t})
\treturn h.db
}

func (h *APIHandlers) getRedis() *redis.Client {
\th.rOnce.Do(func() {
\t\turl := os.Getenv("REDIS_URL")
\t\tif url == "" { return }
\t\topt, err := redis.ParseURL(url)
\t\tif err != nil {
\t\t\th.log.Error("api_handlers: redis parse", "err", err)
\t\t\treturn
\t\t}
\t\th.rdb = redis.NewClient(opt)
\t})
\treturn h.rdb
}

func (h *APIHandlers) issueJWT(sub string) (string, error) {
\tsecret := os.Getenv("JWT_SECRET")
\tif secret == "" { return "", fmt.Errorf("JWT_SECRET not set") }
\tclaims := jwt.MapClaims{
\t\t"sub": sub,
\t\t"iat": time.Now().Unix(),
\t\t"exp": time.Now().Add(24 * time.Hour).Unix(),
\t}
\treturn jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

func (h *APIHandlers) verifyRefreshToken(token string) (string, error) {
\tsecret := os.Getenv("JWT_REFRESH_SECRET")
\tif secret == "" { secret = os.Getenv("JWT_SECRET") }
\tt, err := jwt.Parse(token, func(t *jwt.Token) (any, error) {
\t\tif _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok { return nil, fmt.Errorf("unexpected signing method") }
\t\treturn []byte(secret), nil
\t})
\tif err != nil || !t.Valid { return "", fmt.Errorf("invalid token") }
\tclaims, _ := t.Claims.(jwt.MapClaims)
\tsub, _ := claims["sub"].(string)
\treturn sub, nil
}

func (h *APIHandlers) claimsFromContext(${fw === "gin" ? "c *gin.Context" : fw === "fiber" ? "c *fiber.Ctx" : fw === "echo" ? "c echo.Context" : "r *http.Request"}) (string, bool) {
\t// Sub is set by the auth middleware. Adapt to your JWT middleware's convention.
\t${fw === "gin" ? `if sub, exists := c.Get("sub"); exists { if s, ok := sub.(string); ok { return s, true } }` :
    fw === "fiber" ? `if sub, ok := c.Locals("sub").(string); ok && sub != "" { return sub, true }` :
    fw === "echo" ? `if sub, ok := c.Get("sub").(string); ok && sub != "" { return sub, true }` :
    `if sub := r.Context().Value("sub"); sub != nil { if s, ok := sub.(string); ok { return s, true } }`}
\treturn "", false
}

func generateID() string {
\treturn uuid.New().String()
}
${chiHelper}`;
}

// ── public entry point ────────────────────────────────────────────────────────

export function goApiHandlersFile(
  module: string,
  fw: string,
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile {
  const framework = (["gin", "fiber", "echo", "chi"].includes(fw) ? fw : "gin") as Fw;
  const usedPatterns = new Set(endpoints.map((e) => e.pattern).filter(Boolean) as string[]);

  const methods = endpoints
    .map((e) => {
      const name = handlerMethodName(e);
      const body = patternBody(e.pattern, framework, e, config, entities);
      const sig = fwCtx(framework).sig(name);
      return `${sig} {\n${body}\n}`;
    })
    .join("\n\n");

  const imports = buildImports(module, framework, usedPatterns, config);
  const structCode = buildStruct(framework, usedPatterns, config);

  return {
    path: "internal/handlers/api.go",
    content: `package handlers\n\n${imports}\n\n${structCode}\n\n${methods}\n`,
  };
}

export { handlerMethodName as goHandlerMethodName };

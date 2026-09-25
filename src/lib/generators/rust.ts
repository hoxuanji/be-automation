import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab } from "./types";
import { needsAuth } from "./auth/providers";
import { rustFeatures, rustInfraDeps, rustTelemetry, rustCache, rustQueue, rustWorker } from "./rust-infra";
import type { RustFeatures } from "./rust-infra";

// SQL backend for the sqlx code paths. `null` means no SQL database was
// selected and handlers fall back to an in-memory store.
type RustSql = {
  mysql: boolean;
  pool: "PgPool" | "MySqlPool";
  // Positional placeholder: `$1` (Postgres) vs `?` (MySQL).
  ph: (i: number) => string;
};

function rustSql(db: string): RustSql | null {
  if (/mysql|planetscale/.test(db)) return { mysql: true, pool: "MySqlPool", ph: () => "?" };
  if (/postgres|neon|supabase|cockroach/.test(db)) return { mysql: false, pool: "PgPool", ph: (i) => `$${i}` };
  return null;
}

export function rustFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  const safe = safeName(config.name);
  const sql = rustSql(config.database);
  const withAuth = needsAuth(config, endpoints.some((e) => e.auth));
  const metrics = config.monitoring === "grafana";
  const feat = rustFeatures(config);
  // Cache-aside only makes sense in front of a real database.
  const cached = feat.cache && sql !== null;
  const files: GeneratedFile[] = [];

  files.push({ path: "Cargo.toml", content: cargoToml(safe, config.framework, sql, withAuth, metrics, feat) });
  files.push({ path: "Dockerfile", content: rustDockerfile(safe, feat) });
  files.push({ path: ".dockerignore", content: "target/\n.git/\n.env\n" });
  files.push({ path: "src/config.rs", content: rustConfig(sql) });
  files.push({ path: "src/db.rs", content: rustDb(sql) });
  files.push({ path: "src/main.rs", content: rustMain(config.framework, entities, endpoints, sql, withAuth, metrics, feat) });
  if (withAuth) {
    files.push({ path: "src/auth.rs", content: rustAuth(config.framework) });
  }
  if (feat.tracing) files.push({ path: "src/telemetry.rs", content: rustTelemetry(safe, feat) });
  if (feat.cache) files.push({ path: "src/cache.rs", content: rustCache() });
  if (feat.queue) {
    files.push({ path: "src/queue.rs", content: rustQueue(feat.queue, config.region || "us-east-1") });
    files.push({ path: "src/bin/worker.rs", content: rustWorker() });
  }

  if (entities.length > 0) {
    files.push({ path: "src/models/mod.rs", content: modFile(entities, "models") });
    files.push({ path: "src/handlers/mod.rs", content: modFile(entities, "handlers") });

    for (const entity of entities) {
      files.push({
        path: `src/models/${toSnake(entity.name)}.rs`,
        content: rustModel(entity, sql),
      });
      files.push({
        path: `src/handlers/${toSnake(entity.name)}.rs`,
        content: config.framework === "actix"
          ? actixHandler(entity, sql, cached)
          : axumHandler(entity, sql, cached),
      });
      files.push({
        path: `tests/${toSnake(entity.name)}_test.rs`,
        content: config.framework === "actix"
          ? actixTest(entity, sql)
          : axumTest(entity, sql),
      });
    }
  } else {
    // Provide empty mod files so main.rs compiles without entities
    files.push({ path: "src/models/mod.rs", content: "// No entities defined\n" });
    files.push({ path: "src/handlers/mod.rs", content: "// No entities defined\n" });
  }

  return files;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "app";
}

// MySQL stores UUIDs as CHAR(36) (see db/sql.ts), so they round-trip as String.
function rustFieldType(t: FieldType, sql: RustSql | null = null): string {
  switch (t) {
    case "uuid":    return sql?.mysql ? "String" : "uuid::Uuid";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "f64"; // migrations use DOUBLE PRECISION / DOUBLE (db/sql.ts)
    case "boolean": return "bool";
    case "date":    return "chrono::DateTime<chrono::Utc>";
    case "json":    return "serde_json::Value";
  }
}

function nonPkFields(entity: Entity): EntityField[] {
  return entity.fields.filter((f) => !f.primaryKey);
}

function pkField(entity: Entity): EntityField | undefined {
  return entity.fields.find((f) => f.primaryKey);
}

function modFile(entities: Entity[], _kind: string): string {
  return entities.map((e) => `pub mod ${toSnake(e.name)};`).join("\n") + "\n";
}

// ─── Cargo.toml ───────────────────────────────────────────────────────────────

function cargoToml(safeName: string, framework: string, sql: RustSql | null, withAuth: boolean, metrics: boolean, feat: RustFeatures): string {
  const sqlxDriver = sql?.mysql ? "mysql" : "postgres";
  const sqlx = `sqlx = { version = "0.8", features = ["runtime-tokio", "${sqlxDriver}", "uuid", "chrono", "json", "macros"] }`;
  // JWKS-based JWT verification (src/auth.rs). rustls keeps the distroless
  // runtime image free of an OpenSSL dependency.
  const authDeps = withAuth
    ? `jsonwebtoken = "9"
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
`
    : "";
  const infraDeps = rustInfraDeps(framework, feat);
  // src/bin/worker.rs makes this a two-binary package; keep `cargo run` pointing at the API.
  const defaultRun = feat.queue ? `default-run = "${safeName}"\n` : "";

  if (framework === "actix") {
    return `[package]
name = "${safeName}"
version = "0.1.0"
edition = "2021"
${defaultRun}
[dependencies]
actix-web = "4.9"
actix-rt = "2"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
${sqlx}
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
dotenvy = "0.15"
${authDeps}${metrics ? `actix-web-prom = "0.8"\n` : ""}${infraDeps}
[dev-dependencies]
actix-web = { version = "4", features = ["macros"] }
tokio = { version = "1", features = ["full"] }
`;
  }

  // axum (default)
  return `[package]
name = "${safeName}"
version = "0.1.0"
edition = "2021"
${defaultRun}
[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
${sqlx}
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tower-http = { version = "0.6", features = ["trace", "cors"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
dotenvy = "0.15"
${authDeps}${metrics ? `axum-prometheus = "0.7"\n` : ""}${infraDeps}
[dev-dependencies]
axum-test = "15"
tokio = { version = "1", features = ["full"] }
`;
}

// ─── Dockerfile ───────────────────────────────────────────────────────────────

function rustDockerfile(safeName: string, feat: RustFeatures): string {
  // Same image, different entrypoint: run the queue worker with `command: ["/worker"]`.
  const worker = feat.queue ? `COPY --from=build /src/target/release/worker /worker\n` : "";
  // No Cargo.lock ships in the zip and the crate has several bins (api, worker), so the
  // "stub main.rs" dependency-cache trick can't work — copy the tree and build once.
  // ponytail: add cargo-chef if image build time matters.
  return `# syntax=docker/dockerfile:1
# bookworm = the runtime's Debian 12, so the binary links against the same glibc.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/${safeName} /api
${worker}EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/api"]
`;
}

// ─── src/config.rs ────────────────────────────────────────────────────────────

function rustConfig(sql: RustSql | null): string {
  const defaultUrl = sql?.mysql ? "mysql://localhost/app" : "postgres://localhost/app";
  return `pub struct Config {
    pub database_url: String,
    pub port: String,
    pub log_level: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "${defaultUrl}".to_string()),
            port: std::env::var("PORT").unwrap_or_else(|_| "8080".to_string()),
            log_level: std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
        }
    }
}
`;
}

// ─── src/db.rs ────────────────────────────────────────────────────────────────

function rustDb(sql: RustSql | null): string {
  if (!sql) {
    // Simple in-memory store stub when no SQL database
    return `use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type Store = Arc<Mutex<HashMap<String, serde_json::Value>>>;

pub fn new_store() -> Store {
    Arc::new(Mutex::new(HashMap::new()))
}
`;
  }

  const opts = sql.mysql ? "sqlx::mysql::MySqlPoolOptions" : "sqlx::postgres::PgPoolOptions";
  const optsName = sql.mysql ? "MySqlPoolOptions" : "PgPoolOptions";
  return `use ${opts};
use std::time::Duration;

/// Connect to the database with retry/backoff. Kubernetes pods frequently start
/// before the database is ready; an unconditional \`.expect()\` turns the first
/// connection failure into a crash loop. We retry up to ~30 seconds with
/// exponential backoff before surfacing the last error.
pub async fn connect(database_url: &str) -> sqlx::${sql.pool} {
    let mut delay = Duration::from_millis(200);
    let mut last_err: Option<sqlx::Error> = None;
    for attempt in 1..=6 {
        match ${optsName}::new()
            .max_connections(20)
            .min_connections(2)
            .acquire_timeout(Duration::from_secs(10))
            .idle_timeout(Duration::from_secs(600))
            .connect(database_url)
            .await
        {
            Ok(pool) => return pool,
            Err(err) => {
                eprintln!("db: connect attempt {}/6 failed: {} — retrying in {:?}", attempt, err, delay);
                last_err = Some(err);
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, Duration::from_secs(5));
            }
        }
    }
    panic!("db: could not connect after retries: {:?}", last_err);
}
`;
}

// ─── src/auth.rs ──────────────────────────────────────────────────────────────

function rustAuth(framework: string): string {
  const middleware = framework === "actix"
    ? `/// actix-web middleware (wrap a scope with \`middleware::from_fn(require_auth)\`).
/// Verified claims are stored in the request extensions.
pub async fn require_auth(
    req: actix_web::dev::ServiceRequest,
    next: actix_web::middleware::Next<impl actix_web::body::MessageBody>,
) -> Result<actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>, actix_web::Error> {
    use actix_web::HttpMessage;
    let token = bearer(req.headers().get("authorization").and_then(|v| v.to_str().ok()))
        .ok_or_else(|| actix_web::error::ErrorUnauthorized("missing bearer token"))?;
    let claims = verify(&token).await.map_err(|e| {
        tracing::debug!("auth: {}", e);
        actix_web::error::ErrorUnauthorized("invalid token")
    })?;
    req.extensions_mut().insert(claims);
    next.call(req).await
}`
    : `/// axum middleware (\`route_layer(axum::middleware::from_fn(require_auth))\`).
/// Verified claims are available to handlers as \`Extension<Claims>\`.
pub async fn require_auth(
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, axum::http::StatusCode> {
    let header = req.headers().get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let token = bearer(header).ok_or(axum::http::StatusCode::UNAUTHORIZED)?;
    let claims = verify(&token).await.map_err(|e| {
        tracing::debug!("auth: {}", e);
        axum::http::StatusCode::UNAUTHORIZED
    })?;
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}`;

  return `//! JWT verification against the provider's JWKS (AUTH_JWKS_URL).
//! Validates signature, exp, iss (AUTH_ISSUER) and — when set — aud (AUTH_AUDIENCE).

use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use std::sync::OnceLock;
use tokio::sync::RwLock;

#[allow(dead_code)] // read by handlers via request extensions
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Claims {
    pub sub: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

static JWKS: OnceLock<RwLock<Option<JwkSet>>> = OnceLock::new();

fn bearer(header: Option<&str>) -> Option<String> {
    header?.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

async fn fetch_jwks() -> Result<JwkSet, String> {
    let url = std::env::var("AUTH_JWKS_URL").map_err(|_| "AUTH_JWKS_URL is not set".to_string())?;
    reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .json::<JwkSet>()
        .await
        .map_err(|e| e.to_string())
}

pub async fn verify(token: &str) -> Result<Claims, String> {
    let header = decode_header(token).map_err(|e| e.to_string())?;
    // Asymmetric algorithms only — never let a token pick HS256.
    if !matches!(
        header.alg,
        Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512 | Algorithm::PS256 | Algorithm::PS384
            | Algorithm::PS512 | Algorithm::ES256 | Algorithm::ES384
    ) {
        return Err(format!("unsupported alg {:?}", header.alg));
    }
    let kid = header.kid.ok_or("token has no kid")?;

    // ponytail: keys are cached until an unknown kid shows up (key rotation),
    // then refetched once. Add a TTL if your provider revokes keys early.
    let cache = JWKS.get_or_init(|| RwLock::new(None));
    let mut jwk = cache.read().await.as_ref().and_then(|set| set.find(&kid).cloned());
    if jwk.is_none() {
        let fresh = fetch_jwks().await?;
        jwk = fresh.find(&kid).cloned();
        *cache.write().await = Some(fresh);
    }
    let jwk = jwk.ok_or("no JWK matches the token kid")?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|e| e.to_string())?;

    let issuer = std::env::var("AUTH_ISSUER").map_err(|_| "AUTH_ISSUER is not set".to_string())?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[issuer]);
    match std::env::var("AUTH_AUDIENCE") {
        Ok(aud) if !aud.is_empty() => validation.set_audience(&[aud]),
        _ => validation.validate_aud = false,
    }
    decode::<Claims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| e.to_string())
}

${middleware}
`;
}

// ─── src/models/{snake}.rs ────────────────────────────────────────────────────

function rustModel(entity: Entity, sql: RustSql | null): string {
  const pascal = toPascal(entity.name);
  const fromRowDerive = sql ? ", sqlx::FromRow" : "";

  const structFields = entity.fields.map((f) => {
    const rustType = rustFieldType(f.type, sql);
    const fieldName = toSnake(f.name);
    return `    pub ${fieldName}: ${rustType},`;
  }).join("\n");

  const createFields = nonPkFields(entity).map((f) => {
    const rustType = rustFieldType(f.type, sql);
    const fieldName = toSnake(f.name);
    if (f.required) {
      return `    pub ${fieldName}: ${rustType},`;
    } else {
      return `    pub ${fieldName}: Option<${rustType}>,`;
    }
  }).join("\n");

  const updateFields = nonPkFields(entity).map((f) => {
    const rustType = rustFieldType(f.type, sql);
    const fieldName = toSnake(f.name);
    return `    pub ${fieldName}: Option<${rustType}>,`;
  }).join("\n");

  return `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize${fromRowDerive})]
pub struct ${pascal} {
${structFields}
}

#[derive(Debug, serde::Deserialize)]
pub struct Create${pascal} {
${createFields}
}

#[derive(Debug, serde::Deserialize)]
pub struct Update${pascal} {
${updateFields}
}
`;
}

// ─── src/handlers/{snake}.rs (Axum) ──────────────────────────────────────────

function axumHandler(entity: Entity, sql: RustSql | null, cached: boolean): string {
  const pascal = toPascal(entity.name);
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const pk = pkField(entity);
  const pkType = pk ? rustFieldType(pk.type, sql) : "uuid::Uuid";
  const pkParam = pk ? toSnake(pk.name) : "id";

  const nonPk = nonPkFields(entity);

  if (!sql) {
    // In-memory store fallback
    return axumHandlerInMemory(pascal, snake, plural, pkParam);
  }
  const { pool, ph } = sql;

  // Build INSERT columns/placeholders
  const insertCols = nonPk.map((f) => toSnake(f.name));
  const allCols = [pkParam, ...insertCols];
  const allColsSql = allCols.join(", ");
  const placeholders = allCols.map((_, i) => ph(i + 1)).join(", ");
  const fieldBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)})`).join("\n");

  // UPDATE SET with COALESCE. Postgres: $1 is the ID, $2+ are fields.
  // MySQL: positional `?`, so fields first and the ID last.
  const updateSets = nonPk.map((f, i) => {
    const col = toSnake(f.name);
    return `${col} = COALESCE(${ph(i + 2)}, ${col})`;
  }).join(", ");

  const idImport = pkType === "uuid::Uuid" || sql.mysql ? "\nuse uuid::Uuid;" : "";

  // MySQL has no RETURNING — write, then read the row back.
  const create = sql.mysql
    ? `    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders})")
        .bind(&id)
${fieldBinds}
        .execute(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let row = sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(row)))`
    : `    let row = sqlx::query_as::<_, ${pascal}>(
        "INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders}) RETURNING *",
    )
        .bind(Uuid::new_v4())
${fieldBinds}
        .fetch_one(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(row)))`;

  const update = sql.mysql
    ? `    sqlx::query("UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = ?")
${fieldBinds}
        .bind(&${pkParam})
        .execute(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ?")
        .bind(&${pkParam})
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)`
    : `    sqlx::query_as::<_, ${pascal}>(
        "UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = $1 RETURNING *",
    )
        .bind(${pkParam})
${fieldBinds}
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)`;

  return `use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::${pool};${idImport}
use crate::models::${snake}::{${pascal}, Create${pascal}, Update${pascal}};

pub fn router() -> axum::Router<${pool}> {
    axum::Router::new()
        .route("/${plural}", axum::routing::get(list).post(create))
        .route("/${plural}/:${pkParam}", axum::routing::get(get_by_id).put(update).delete(delete))
}

async fn list(State(pool): State<${pool}>) -> Result<Json<Vec<${pascal}>>, StatusCode> {
    sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} ORDER BY ${pkParam}")
        .fetch_all(&pool)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn get_by_id(
    State(pool): State<${pool}>,
    Path(${pkParam}): Path<${pkType}>,
) -> Result<Json<${pascal}>, StatusCode> {
${cached ? `    // Cache-aside: serve from Redis, else load from the database and populate.
    let cache_key = format!("${plural}:{}", ${pkParam});
    if let Some(hit) = crate::cache::get::<${pascal}>(&cache_key).await {
        return Ok(Json(hit));
    }
    let row = sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ${ph(1)}")
        .bind(${pkParam})
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    crate::cache::set(&cache_key, &row).await;
    Ok(Json(row))` : `    sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ${ph(1)}")
        .bind(${pkParam})
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)`}
}

async fn create(
    State(pool): State<${pool}>,
    Json(body): Json<Create${pascal}>,
) -> Result<(StatusCode, Json<${pascal}>), StatusCode> {
${create}
}

async fn update(
    State(pool): State<${pool}>,
    Path(${pkParam}): Path<${pkType}>,
    Json(body): Json<Update${pascal}>,
) -> Result<Json<${pascal}>, StatusCode> {
${cached ? `    let cache_key = format!("${plural}:{}", ${pkParam});
    let res = {
${update.replace(/^/gm, "    ")}
    };
    crate::cache::del(&cache_key).await;
    res` : update}
}

async fn delete(
    State(pool): State<${pool}>,
    Path(${pkParam}): Path<${pkType}>,
) -> StatusCode {
${cached ? `    let cache_key = format!("${plural}:{}", ${pkParam});
` : ""}    let result = sqlx::query("DELETE FROM ${plural} WHERE ${pkParam} = ${ph(1)}")
        .bind(${pkParam})
        .execute(&pool)
        .await;
${cached ? `    crate::cache::del(&cache_key).await;
` : ""}    match result {
        Ok(r) if r.rows_affected() > 0 => StatusCode::NO_CONTENT,
        Ok(_) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
`;
}

function axumHandlerInMemory(pascal: string, snake: string, plural: string, pkParam: string): string {
  return `use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use uuid::Uuid;
use crate::models::${snake}::{${pascal}, Create${pascal}, Update${pascal}};

pub type AppState = Arc<Mutex<HashMap<String, ${pascal}>>>;

pub fn router() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/${plural}", axum::routing::get(list).post(create))
        .route("/${plural}/:${pkParam}", axum::routing::get(get_by_id).put(update).delete(delete))
}

async fn list(State(store): State<AppState>) -> Json<Vec<${pascal}>> {
    let store = store.lock().unwrap();
    Json(store.values().cloned().collect())
}

async fn get_by_id(
    State(store): State<AppState>,
    Path(${pkParam}): Path<String>,
) -> Result<Json<${pascal}>, StatusCode> {
    let store = store.lock().unwrap();
    store
        .get(&${pkParam})
        .cloned()
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn create(
    State(store): State<AppState>,
    Json(body): Json<Create${pascal}>,
) -> Result<(StatusCode, Json<${pascal}>), StatusCode> {
    let id = Uuid::new_v4().to_string();
    let item_json = serde_json::to_value(&body).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut map = serde_json::Map::new();
    map.insert("${pkParam}".to_string(), serde_json::Value::String(id.clone()));
    if let serde_json::Value::Object(fields) = item_json {
        map.extend(fields);
    }
    let item: ${pascal} = serde_json::from_value(serde_json::Value::Object(map))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    store.lock().unwrap().insert(id, item.clone());
    Ok((StatusCode::CREATED, Json(item)))
}

async fn update(
    State(store): State<AppState>,
    Path(${pkParam}): Path<String>,
    Json(body): Json<Update${pascal}>,
) -> Result<Json<${pascal}>, StatusCode> {
    let mut st = store.lock().unwrap();
    let item = st.get_mut(&${pkParam}).ok_or(StatusCode::NOT_FOUND)?;
    let patch = serde_json::to_value(&body).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut current = serde_json::to_value(&*item).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let (serde_json::Value::Object(cur), serde_json::Value::Object(pat)) = (&mut current, patch) {
        for (k, v) in pat {
            if v != serde_json::Value::Null {
                cur.insert(k, v);
            }
        }
    }
    *item = serde_json::from_value(current).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(item.clone()))
}

async fn delete(
    State(store): State<AppState>,
    Path(${pkParam}): Path<String>,
) -> StatusCode {
    let removed = store.lock().unwrap().remove(&${pkParam});
    if removed.is_some() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}
`;
}

// ─── src/handlers/{snake}.rs (Actix) ─────────────────────────────────────────

function actixHandler(entity: Entity, sql: RustSql | null, cached: boolean): string {
  const pascal = toPascal(entity.name);
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const pk = pkField(entity);
  const pkType = pk ? rustFieldType(pk.type, sql) : "uuid::Uuid";
  const pkParam = pk ? toSnake(pk.name) : "id";

  const nonPk = nonPkFields(entity);

  if (!sql) {
    return actixHandlerInMemory(pascal, snake, plural, pkParam);
  }
  const { pool, ph } = sql;

  const insertCols = nonPk.map((f) => toSnake(f.name));
  const allCols = [pkParam, ...insertCols];
  const allColsSql = allCols.join(", ");
  const placeholders = allCols.map((_, i) => ph(i + 1)).join(", ");
  const fieldBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)}.clone())`).join("\n");

  const updateSets = nonPk.map((f, i) => {
    const col = toSnake(f.name);
    return `${col} = COALESCE(${ph(i + 2)}, ${col})`;
  }).join(", ");

  const idImport = pkType === "uuid::Uuid" || sql.mysql ? "\nuse uuid::Uuid;" : "";

  // MySQL has no RETURNING — write, then read the row back.
  const create = sql.mysql
    ? `    let id = Uuid::new_v4().to_string();
    let inserted = sqlx::query("INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders})")
        .bind(&id)
${fieldBinds}
        .execute(pool.get_ref())
        .await;
    if inserted.is_err() {
        return HttpResponse::InternalServerError().finish();
    }
    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ?")
        .bind(&id)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(row) => HttpResponse::Created().json(row),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }`
    : `    match sqlx::query_as::<_, ${pascal}>(
        "INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders}) RETURNING *",
    )
        .bind(Uuid::new_v4())
${fieldBinds}
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(row) => HttpResponse::Created().json(row),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }`;

  const update = sql.mysql
    ? `    let updated = sqlx::query("UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = ?")
${fieldBinds}
        .bind(&${pkParam})
        .execute(pool.get_ref())
        .await;
    if updated.is_err() {
        return HttpResponse::InternalServerError().finish();
    }
    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ?")
        .bind(&${pkParam})
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }`
    : `    match sqlx::query_as::<_, ${pascal}>(
        "UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = $1 RETURNING *",
    )
        .bind(${pkParam})
${fieldBinds}
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }`;

  return `use actix_web::{web, HttpResponse, Responder};
use sqlx::${pool};${idImport}
use crate::models::${snake}::{${pascal}, Create${pascal}, Update${pascal}};

pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/${plural}")
            .route("", web::get().to(list))
            .route("", web::post().to(create))
            .route("/{${pkParam}}", web::get().to(get_by_id))
            .route("/{${pkParam}}", web::put().to(update))
            .route("/{${pkParam}}", web::delete().to(delete)),
    );
}

async fn list(pool: web::Data<${pool}>) -> impl Responder {
    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} ORDER BY ${pkParam}")
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn get_by_id(
    pool: web::Data<${pool}>,
    path: web::Path<${pkType}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
${cached ? `    // Cache-aside: serve from Redis, else load from the database and populate.
    let cache_key = format!("${plural}:{}", ${pkParam});
    if let Some(hit) = crate::cache::get::<${pascal}>(&cache_key).await {
        return HttpResponse::Ok().json(hit);
    }
` : ""}    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = ${ph(1)}")
        .bind(${pkParam})
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => {${cached ? `
            crate::cache::set(&cache_key, &row).await;` : ""}
            HttpResponse::Ok().json(row)
        }
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn create(
    pool: web::Data<${pool}>,
    body: web::Json<Create${pascal}>,
) -> impl Responder {
${create}
}

async fn update(
    pool: web::Data<${pool}>,
    path: web::Path<${pkType}>,
    body: web::Json<Update${pascal}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
${cached ? `    let cache_key = format!("${plural}:{}", ${pkParam});
    let res = {
${update.replace(/^/gm, "    ")}
    };
    crate::cache::del(&cache_key).await;
    res` : update}
}

async fn delete(
    pool: web::Data<${pool}>,
    path: web::Path<${pkType}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
${cached ? `    let cache_key = format!("${plural}:{}", ${pkParam});
` : ""}    let result = sqlx::query("DELETE FROM ${plural} WHERE ${pkParam} = ${ph(1)}")
        .bind(${pkParam})
        .execute(pool.get_ref())
        .await;
${cached ? `    crate::cache::del(&cache_key).await;
` : ""}    match result {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::NoContent().finish(),
        Ok(_) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}
`;
}

function actixHandlerInMemory(pascal: string, snake: string, plural: string, pkParam: string): string {
  return `use actix_web::{web, HttpResponse, Responder};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use uuid::Uuid;
use crate::models::${snake}::{${pascal}, Create${pascal}, Update${pascal}};

pub type AppStore = Arc<Mutex<HashMap<String, ${pascal}>>>;

pub fn config(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/${plural}")
            .route("", web::get().to(list))
            .route("", web::post().to(create))
            .route("/{${pkParam}}", web::get().to(get_by_id))
            .route("/{${pkParam}}", web::put().to(update))
            .route("/{${pkParam}}", web::delete().to(delete)),
    );
}

async fn list(store: web::Data<AppStore>) -> impl Responder {
    let st = store.lock().unwrap();
    HttpResponse::Ok().json(st.values().cloned().collect::<Vec<_>>())
}

async fn get_by_id(
    store: web::Data<AppStore>,
    path: web::Path<String>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    let st = store.lock().unwrap();
    match st.get(&${pkParam}).cloned() {
        Some(item) => HttpResponse::Ok().json(item),
        None => HttpResponse::NotFound().finish(),
    }
}

async fn create(
    store: web::Data<AppStore>,
    body: web::Json<Create${pascal}>,
) -> impl Responder {
    let id = Uuid::new_v4().to_string();
    let item_json = match serde_json::to_value(&body.into_inner()) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    let mut map = serde_json::Map::new();
    map.insert("${pkParam}".to_string(), serde_json::Value::String(id.clone()));
    if let serde_json::Value::Object(fields) = item_json {
        map.extend(fields);
    }
    let item: ${pascal} = match serde_json::from_value(serde_json::Value::Object(map)) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    store.lock().unwrap().insert(id, item.clone());
    HttpResponse::Created().json(item)
}

async fn update(
    store: web::Data<AppStore>,
    path: web::Path<String>,
    body: web::Json<Update${pascal}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    let mut st = store.lock().unwrap();
    let item = match st.get_mut(&${pkParam}) {
        Some(v) => v,
        None => return HttpResponse::NotFound().finish(),
    };
    let patch = match serde_json::to_value(&body.into_inner()) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    let mut current = match serde_json::to_value(&*item) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    if let (serde_json::Value::Object(cur), serde_json::Value::Object(pat)) = (&mut current, patch) {
        for (k, v) in pat {
            if v != serde_json::Value::Null {
                cur.insert(k, v);
            }
        }
    }
    *item = match serde_json::from_value(current) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    HttpResponse::Ok().json(item.clone())
}

async fn delete(
    store: web::Data<AppStore>,
    path: web::Path<String>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    if store.lock().unwrap().remove(&${pkParam}).is_some() {
        HttpResponse::NoContent().finish()
    } else {
        HttpResponse::NotFound().finish()
    }
}
`;
}

// ─── src/main.rs ──────────────────────────────────────────────────────────────

// send_notification endpoints publish to the configured queue.
const publishes = (e: Endpoint, feat: RustFeatures) =>
  feat.queue !== null && e.pattern === "send_notification" && e.method === "POST";

function rustMain(
  framework: string,
  entities: Entity[],
  endpoints: Endpoint[],
  sql: RustSql | null,
  withAuth: boolean,
  metrics: boolean,
  feat: RustFeatures
): string {
  // Endpoint stubs only when there are no entities (the entity CRUD routes
  // already serve those paths — axum panics on overlapping routes). /health is
  // always registered by the template itself. Publishing endpoints are real
  // handlers, so they're kept unless they sit under an entity's path.
  const entityPaths = entities.map((e) => `/${toKebab(e.name)}s`);
  const underEntity = (p: string) => entityPaths.some((ep) => p === ep || p.startsWith(ep + "/"));
  const stubs = entities.length === 0
    ? endpoints.filter((e) => e.path !== "/health")
    : endpoints.filter((e) => publishes(e, feat) && !underEntity(e.path));
  const mods = [
    ...(withAuth ? ["auth"] : []),
    ...(feat.cache ? ["cache"] : []),
    "config", "db", "handlers", "models",
    ...(feat.queue ? ["queue"] : []),
    ...(feat.tracing ? ["telemetry"] : []),
  ].map((m) => `mod ${m};\n`).join("");
  if (framework === "actix") {
    return mods + actixMain(entities, stubs, sql, withAuth, metrics, feat);
  }
  return mods + axumMain(entities, stubs, sql, withAuth, metrics, feat);
}

function logInit(feat: RustFeatures): string {
  const init = feat.tracing
    ? `    dotenvy::dotenv().ok();
    // JSON logs + OTLP traces when OTEL_EXPORTER_OTLP_ENDPOINT is set (src/telemetry.rs).
    let otel = telemetry::init();
`
    : `    // JSON-formatted tracing output — parseable by Loki / Datadog / CloudWatch.
    // RUST_LOG=debug narrows verbosity; the env-filter feature handles parsing.
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    dotenvy::dotenv().ok();
`;
  const sentry = feat.sentry
    ? `    // Sentry: panics and server errors are reported when SENTRY_DSN is set; a no-op otherwise.
    let _sentry = sentry::init(sentry::ClientOptions {
        dsn: std::env::var("SENTRY_DSN").ok().and_then(|dsn| dsn.parse().ok()),
        release: sentry::release_name!(),
        ..Default::default()
    });
`
    : "";
  return init + sentry;
}

const otelShutdown = `    if let Some(provider) = otel {
        let _ = provider.shutdown(); // flush buffered spans
    }
`;

function axumMain(entities: Entity[], endpoints: Endpoint[], sql: RustSql | null, withAuth: boolean, metrics: boolean, feat: RustFeatures): string {
  const entityRoutes = entities.map((e) => `        .merge(handlers::${toSnake(e.name)}::router())`);

  const stub = (e: Endpoint) => {
    const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
    if (publishes(e, feat)) return `        .route("${path}", axum::routing::post(send_notification))`;
    const method = e.method.toLowerCase();
    return `        .route("${path}", axum::routing::${method}(|| async { axum::Json(serde_json::json!({"ok": true, "op": "${e.method} ${e.path}"})) }))`;
  };
  const publicRoutes = endpoints.filter((e) => !(withAuth && e.auth)).map(stub);
  const protectedRoutes = withAuth ? [...endpoints.filter((e) => e.auth).map(stub), ...entityRoutes] : [];
  const mainRoutes = withAuth ? publicRoutes : [...publicRoutes, ...entityRoutes];

  // route_layer panics on a router without routes, so only build it when needed.
  const protectedBlock = protectedRoutes.length > 0
    ? `    // Every route below requires a valid Bearer JWT (see src/auth.rs).
    let protected = Router::new()
${protectedRoutes.join("\n")}
        .route_layer(axum::middleware::from_fn(auth::require_auth));
`
    : "";

  const poolSetup = sql
    ? `    let pool = db::connect(&cfg.database_url).await;\n`
    : `    let store = db::new_store();\n`;

  const rateLimit = feat.rateLimit
    ? `    // Per-client rate limit: 10 req/s sustained, bursts of 20; over the limit → 429.
    // Keyed by X-Forwarded-For / X-Real-IP / Forwarded, falling back to the peer IP.
    // ponytail: buckets live in process memory, so each replica limits on its own —
    // move them to Redis if the limit must be global.
    let governor_conf = std::sync::Arc::new(
        tower_governor::governor::GovernorConfigBuilder::default()
            .key_extractor(tower_governor::key_extractor::SmartIpKeyExtractor)
            .per_millisecond(100)
            .burst_size(20)
            .finish()
            .expect("valid rate-limit config"),
    );
    let limiter = governor_conf.limiter().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        limiter.retain_recent(); // drop idle client buckets
    });
`
    : "";

  // Router::layer wraps everything added before it; the last layer runs first.
  const layers = [
    ...(feat.audit ? [`        .layer(axum::middleware::from_fn(audit))`] : []),
    ...(feat.rateLimit ? [`        .layer(tower_governor::GovernorLayer { config: governor_conf })`] : []),
    ...(feat.tracing ? [`        .layer(tower_http::trace::TraceLayer::new_for_http().make_span_with(tower_http::trace::DefaultMakeSpan::new().level(tracing::Level::INFO)))`] : []),
    ...(feat.sentry ? [
      `        .layer(sentry_tower::SentryHttpLayer::with_transaction())`,
      `        .layer(sentry_tower::NewSentryLayer::<axum::extract::Request>::new_from_top())`,
    ] : []),
  ];

  const tail = [
    ...mainRoutes,
    ...(protectedBlock ? [`        .merge(protected)`] : []),
    ...(metrics ? [`        .route("/metrics", axum::routing::get(|| async move { metric_handle.render() }))`, `        .layer(prometheus_layer)`] : []),
    ...layers,
    sql ? `        .with_state(pool);` : `        .with_state(store);`,
  ].join("\n");

  // The rate limiter and audit log need the client's socket address.
  const connectInfo = feat.rateLimit || feat.audit;
  const service = connectInfo ? "app.into_make_service_with_connect_info::<std::net::SocketAddr>()" : "app";

  const health = feat.cache
    ? `
// Liveness: GET /health. Readiness: GET /health?ready=1 also requires Redis to answer PING.
async fn health(uri: axum::http::Uri) -> (axum::http::StatusCode, &'static str) {
    let ready = uri.query().is_some_and(|q| q.split('&').any(|p| p == "ready=1"));
    if ready && !cache::ping().await {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "cache unavailable");
    }
    (axum::http::StatusCode::OK, "ok")
}
`
    : "";

  const audit = feat.audit
    ? `
// Audit log: one structured line per request with method, path, status and client IP.
async fn audit(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let ip = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|v| v.trim().to_owned())
        .unwrap_or_else(|| peer.ip().to_string());
    let res = next.run(req).await;
    tracing::info!(target: "audit", method = %method, path = %path, status = res.status().as_u16(), ip = %ip, "audit");
    res
}
`
    : "";

  const notify = endpoints.some((e) => publishes(e, feat))
    ? `
// send_notification: enqueue the JSON body; src/bin/worker.rs consumes it.
async fn send_notification(
    axum::Json(body): axum::Json<serde_json::Value>,
) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    match queue::publish(body.to_string().as_bytes()).await {
        Ok(()) => (axum::http::StatusCode::ACCEPTED, axum::Json(serde_json::json!({"queued": true}))),
        Err(e) => {
            tracing::error!("queue publish failed: {}", e);
            (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::json!({"queued": false})))
        }
    }
}
`
    : "";

  return `
use axum::Router;

#[tokio::main]
async fn main() {
${logInit(feat)}    let cfg = config::Config::from_env();
${poolSetup}${metrics ? `    // Prometheus: per-route request counters + latency histograms, scraped at /metrics.
    let (prometheus_layer, metric_handle) = axum_prometheus::PrometheusMetricLayer::pair();
` : ""}${rateLimit}${protectedBlock}
    let app = Router::new()
        .route("/health", axum::routing::get(${feat.cache ? "health" : `|| async { "ok" }`}))
${tail}

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("listening on {}", addr);
    axum::serve(listener, ${service})
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
${feat.tracing ? otelShutdown : ""}}
${health}${audit}${notify}
// Waits for SIGTERM (K8s rolling deploys) or SIGINT (Ctrl-C). Axum drains
// in-flight requests before exiting, bounded by the pod's terminationGracePeriodSeconds.
async fn shutdown_signal() {
    use tokio::signal;
    let ctrl_c = async {
        signal::ctrl_c().await.expect("install SIGINT handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("shutdown: SIGINT"),
        _ = terminate => tracing::info!("shutdown: SIGTERM"),
    }
}
`;
}

function actixMain(entities: Entity[], endpoints: Endpoint[], sql: RustSql | null, withAuth: boolean, metrics: boolean, feat: RustFeatures): string {
  const entityConfigs = entities.map((e) => `.configure(handlers::${toSnake(e.name)}::config)`);

  const stub = (e: Endpoint) => {
    const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
    if (publishes(e, feat)) return `.route("${path}", web::post().to(send_notification))`;
    const method = e.method.toLowerCase();
    return `.route("${path}", web::${method}().to(|| async { actix_web::HttpResponse::Ok().json(serde_json::json!({"ok": true, "op": "${e.method} ${e.path}"})) }))`;
  };
  const publicRoutes = endpoints.filter((e) => !(withAuth && e.auth)).map(stub);
  const protectedRoutes = withAuth ? [...endpoints.filter((e) => e.auth).map(stub), ...entityConfigs] : [];
  const mainRoutes = withAuth ? publicRoutes : [...publicRoutes, ...entityConfigs];

  // Registered last: an empty-prefix scope matches every remaining path.
  const protectedScope = protectedRoutes.length > 0
    ? [`            // Every route in this scope requires a valid Bearer JWT (see src/auth.rs).
            .service(
                web::scope("")
                    .wrap(actix_web::middleware::from_fn(auth::require_auth))
${protectedRoutes.map((r) => `                    ${r}`).join("\n")},
            )`]
    : [];

  const poolSetup = sql
    ? `    let pool = db::connect(&cfg.database_url).await;\n    let pool_data = actix_web::web::Data::new(pool);\n`
    : `    let store = db::new_store();\n    let store_data = actix_web::web::Data::new(store);\n`;

  const appData = sql ? `            .app_data(pool_data.clone())` : `            .app_data(store_data.clone())`;

  const rateLimit = feat.rateLimit
    ? `    // Per-client rate limit: 10 req/s sustained, bursts of 20; over the limit → 429.
    // ponytail: keyed by the peer IP and kept in process memory (per replica). Behind a
    // proxy every client shares the proxy's IP — implement actix_governor::KeyExtractor
    // over connection_info().realip_remote_addr() if you trust X-Forwarded-For.
    let governor_conf = actix_governor::GovernorConfigBuilder::default()
        .per_millisecond(100)
        .burst_size(20)
        .finish()
        .expect("valid rate-limit config");
`
    : "";

  // App::wrap: the last middleware registered runs first.
  const body = [
    ...(metrics ? [`            .wrap(prometheus.clone())`] : []),
    ...(feat.audit ? [`            .wrap(actix_web::middleware::from_fn(audit))`] : []),
    ...(feat.rateLimit ? [`            .wrap(actix_governor::Governor::new(&governor_conf))`] : []),
    ...(feat.tracing ? [`            .wrap(tracing_actix_web::TracingLogger::default())`] : []),
    ...(feat.sentry ? [`            .wrap(sentry_actix::Sentry::new())`] : []),
    appData,
    feat.cache
      ? `            .route("/health", web::get().to(health))`
      : `            .route("/health", web::get().to(|| async { actix_web::HttpResponse::Ok().body("ok") }))`,
    ...mainRoutes.map((r) => `            ${r}`),
    ...protectedScope,
  ].join("\n");

  const health = feat.cache
    ? `
// Liveness: GET /health. Readiness: GET /health?ready=1 also requires Redis to answer PING.
async fn health(req: actix_web::HttpRequest) -> actix_web::HttpResponse {
    let ready = req.query_string().split('&').any(|p| p == "ready=1");
    if ready && !cache::ping().await {
        return actix_web::HttpResponse::ServiceUnavailable().body("cache unavailable");
    }
    actix_web::HttpResponse::Ok().body("ok")
}
`
    : "";

  const audit = feat.audit
    ? `
// Audit log: one structured line per request with method, path, status and client IP.
// Errors (e.g. a 401 from the auth middleware) are logged with their status too.
async fn audit(
    req: actix_web::dev::ServiceRequest,
    next: actix_web::middleware::Next<impl actix_web::body::MessageBody>,
) -> Result<actix_web::dev::ServiceResponse<impl actix_web::body::MessageBody>, actix_web::Error> {
    let method = req.method().clone();
    let path = req.path().to_owned();
    let ip = req.connection_info().realip_remote_addr().unwrap_or("-").to_owned();
    let res = next.call(req).await;
    let status = match &res {
        Ok(r) => r.status(),
        Err(e) => e.as_response_error().status_code(),
    };
    tracing::info!(target: "audit", method = %method, path = %path, status = status.as_u16(), ip = %ip, "audit");
    res
}
`
    : "";

  const notify = endpoints.some((e) => publishes(e, feat))
    ? `
// send_notification: enqueue the JSON body; src/bin/worker.rs consumes it.
async fn send_notification(body: web::Json<serde_json::Value>) -> actix_web::HttpResponse {
    match queue::publish(body.into_inner().to_string().as_bytes()).await {
        Ok(()) => actix_web::HttpResponse::Accepted().json(serde_json::json!({"queued": true})),
        Err(e) => {
            tracing::error!("queue publish failed: {}", e);
            actix_web::HttpResponse::ServiceUnavailable().json(serde_json::json!({"queued": false}))
        }
    }
}
`
    : "";

  return `
use actix_web::{web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
${logInit(feat)}    let cfg = config::Config::from_env();
${poolSetup}${metrics ? `    // Prometheus: per-route request counters + latency histograms, served at /metrics.
    let prometheus = actix_web_prom::PrometheusMetricsBuilder::new("api")
        .endpoint("/metrics")
        .build()
        .expect("build prometheus metrics");
` : ""}${rateLimit}
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("listening on {}", addr);

    ${feat.tracing ? "let res = " : ""}HttpServer::new(move || {
        App::new()
${body}
    })
    .bind(&addr)?
    // Actix's HttpServer::run already installs SIGTERM/SIGINT handlers and
    // drains in-flight requests with a 30 s timeout — which matches the K8s
    // default terminationGracePeriodSeconds. Tune via \`.shutdown_timeout(...)\`
    // if your pod spec overrides the grace period.
    .run()
    .await${feat.tracing ? `;
${otelShutdown}    res` : ""}
}
${health}${audit}${notify}`;
}

// ─── tests/{snake}_test.rs ────────────────────────────────────────────────────

function axumTest(entity: Entity, sql: RustSql | null): string {
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const createFields = buildTestJson(entity, "test", 1);
  const updateFields = buildTestJson(entity, "updated", 2);

  return `#[cfg(test)]
mod tests {
    use axum_test::TestServer;
    use serde_json::json;

    async fn build_server() -> TestServer {
        let pool = sqlx::${sql?.pool ?? "PgPool"}::connect(
            &std::env::var("TEST_DATABASE_URL").unwrap_or_default(),
        )
        .await
        .expect("needs TEST_DATABASE_URL");
        let app = crate::handlers::${snake}::router().with_state(pool);
        TestServer::new(app).unwrap()
    }

    #[tokio::test]
    async fn test_list_${snake}s() {
        let server = build_server().await;
        let res = server.get("/${plural}").await;
        res.assert_status_ok();
    }

    #[tokio::test]
    async fn test_create_${snake}() {
        let server = build_server().await;
        let res = server
            .post("/${plural}")
            .json(&json!(${createFields}))
            .await;
        res.assert_status(axum::http::StatusCode::CREATED);
    }

    #[tokio::test]
    async fn test_get_${snake}_not_found() {
        let server = build_server().await;
        let res = server
            .get("/${plural}/00000000-0000-0000-0000-000000000000")
            .await;
        res.assert_status(axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_update_${snake}() {
        let server = build_server().await;
        // First create
        let create_res = server
            .post("/${plural}")
            .json(&json!(${createFields}))
            .await;
        create_res.assert_status(axum::http::StatusCode::CREATED);
        let created: serde_json::Value = create_res.json();
        let id = created["id"].as_str().unwrap_or_default();
        // Then update
        let update_url = format!("/${plural}/{}", id);
        let update_res = server
            .put(&update_url)
            .json(&json!(${updateFields}))
            .await;
        update_res.assert_status_ok();
    }
}
`;
}

function actixTest(entity: Entity, sql: RustSql | null): string {
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const createFields = buildTestJson(entity, "test", 1);
  const updateFields = buildTestJson(entity, "updated", 2);

  return `#[cfg(test)]
mod tests {
    use actix_web::{test, App};
    use serde_json::json;

    async fn build_app() -> impl actix_web::dev::Service<
        actix_http::Request,
        Response = actix_web::dev::ServiceResponse,
        Error = actix_web::Error,
    > {
        let pool = sqlx::${sql?.pool ?? "PgPool"}::connect(
            &std::env::var("TEST_DATABASE_URL").unwrap_or_default(),
        )
        .await
        .expect("needs TEST_DATABASE_URL");
        let pool_data = actix_web::web::Data::new(pool);
        test::init_service(
            App::new()
                .app_data(pool_data.clone())
                .configure(crate::handlers::${snake}::config),
        )
        .await
    }

    #[actix_rt::test]
    async fn test_list_${snake}s() {
        let app = build_app().await;
        let req = test::TestRequest::get().uri("/${plural}").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[actix_rt::test]
    async fn test_create_${snake}() {
        let app = build_app().await;
        let payload = json!(${createFields});
        let req = test::TestRequest::post()
            .uri("/${plural}")
            .set_json(&payload)
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), 201);
    }

    #[actix_rt::test]
    async fn test_get_${snake}_not_found() {
        let app = build_app().await;
        let req = test::TestRequest::get()
            .uri("/${plural}/00000000-0000-0000-0000-000000000000")
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), 404);
    }

    #[actix_rt::test]
    async fn test_update_${snake}() {
        let app = build_app().await;
        let payload = json!(${createFields});
        let create_req = test::TestRequest::post()
            .uri("/${plural}")
            .set_json(&payload)
            .to_request();
        let create_resp = test::call_service(&app, create_req).await;
        assert_eq!(create_resp.status(), 201);
        let body: serde_json::Value = test::read_body_json(create_resp).await;
        let id = body["id"].as_str().unwrap_or_default().to_string();
        let update_req = test::TestRequest::put()
            .uri(&format!("/${plural}/{}", id))
            .set_json(&json!(${updateFields}))
            .to_request();
        let update_resp = test::call_service(&app, update_req).await;
        assert!(update_resp.status().is_success());
    }
}
`;
}

// ─── Test JSON helpers ────────────────────────────────────────────────────────

function buildTestJson(entity: Entity, strVal: string, numVal: number): string {
  const fields = nonPkFields(entity).filter((f) => f.required);
  if (fields.length === 0) {
    return `{"name": "${strVal}"}`;
  }
  const pairs = fields.slice(0, 4).map((f) => {
    switch (f.type) {
      case "string":
      case "text":    return `"${toSnake(f.name)}": "${strVal}"`;
      case "number":  return `"${toSnake(f.name)}": ${numVal}`;
      case "boolean": return `"${toSnake(f.name)}": true`;
      case "uuid":    return `"${toSnake(f.name)}": "00000000-0000-0000-0000-00000000000${numVal}"`;
      case "date":    return `"${toSnake(f.name)}": "2024-01-01T00:00:00Z"`;
      case "json":    return `"${toSnake(f.name)}": {}`;
    }
  });
  return `{${pairs.join(", ")}}`;
}

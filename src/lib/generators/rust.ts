import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab } from "./types";

export function rustFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  const safe = safeName(config.name);
  const isPostgres = isPostgresDb(config.database);
  const files: GeneratedFile[] = [];

  files.push({ path: "Cargo.toml", content: cargoToml(safe, config.framework) });
  files.push({ path: "Dockerfile", content: rustDockerfile(safe) });
  files.push({ path: "src/config.rs", content: rustConfig() });
  files.push({ path: "src/db.rs", content: rustDb(isPostgres) });
  files.push({ path: "src/main.rs", content: rustMain(config.framework, entities, endpoints, isPostgres) });

  if (entities.length > 0) {
    files.push({ path: "src/models/mod.rs", content: modFile(entities, "models") });
    files.push({ path: "src/handlers/mod.rs", content: modFile(entities, "handlers") });

    for (const entity of entities) {
      files.push({
        path: `src/models/${toSnake(entity.name)}.rs`,
        content: rustModel(entity, isPostgres),
      });
      files.push({
        path: `src/handlers/${toSnake(entity.name)}.rs`,
        content: config.framework === "actix"
          ? actixHandler(entity, isPostgres)
          : axumHandler(entity, isPostgres),
      });
      files.push({
        path: `tests/${toSnake(entity.name)}_test.rs`,
        content: config.framework === "actix"
          ? actixTest(entity)
          : axumTest(entity),
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

function isPostgresDb(db: string): boolean {
  return /postgres|neon|supabase|cockroach|planetscale/.test(db);
}

function rustFieldType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "uuid::Uuid";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "i64";
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

function cargoToml(safeName: string, framework: string): string {
  if (framework === "actix") {
    return `[package]
name = "${safeName}"
version = "0.1.0"
edition = "2021"

[dependencies]
actix-web = "4"
actix-rt = "2"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "uuid", "chrono", "macros"] }
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
dotenvy = "0.15"

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

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "uuid", "chrono", "macros"] }
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
tower-http = { version = "0.6", features = ["trace", "cors"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
dotenvy = "0.15"

[dev-dependencies]
axum-test = "15"
tokio = { version = "1", features = ["full"] }
`;
}

// ─── Dockerfile ───────────────────────────────────────────────────────────────

function rustDockerfile(safeName: string): string {
  return `# syntax=docker/dockerfile:1
FROM rust:1.82-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -f target/release/${safeName}*
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM gcr.io/distroless/cc-debian12
COPY --from=build /src/target/release/${safeName} /api
EXPOSE 8080
ENTRYPOINT ["/api"]
`;
}

// ─── src/config.rs ────────────────────────────────────────────────────────────

function rustConfig(): string {
  return `pub struct Config {
    pub database_url: String,
    pub port: String,
    pub log_level: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://localhost/app".to_string()),
            port: std::env::var("PORT").unwrap_or_else(|_| "8080".to_string()),
            log_level: std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
        }
    }
}
`;
}

// ─── src/db.rs ────────────────────────────────────────────────────────────────

function rustDb(isPostgres: boolean): string {
  if (!isPostgres) {
    // Simple in-memory store stub when no postgres
    return `use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type Store = Arc<Mutex<HashMap<String, serde_json::Value>>>;

pub fn new_store() -> Store {
    Arc::new(Mutex::new(HashMap::new()))
}
`;
  }

  return `use sqlx::postgres::PgPoolOptions;

pub async fn connect(database_url: &str) -> sqlx::PgPool {
    PgPoolOptions::new()
        .max_connections(20)
        .connect(database_url)
        .await
        .expect("failed to connect to database")
}
`;
}

// ─── src/models/{snake}.rs ────────────────────────────────────────────────────

function rustModel(entity: Entity, isPostgres: boolean): string {
  const pascal = toPascal(entity.name);
  const fromRowDerive = isPostgres ? ", sqlx::FromRow" : "";

  const structFields = entity.fields.map((f) => {
    const rustType = rustFieldType(f.type);
    const fieldName = toSnake(f.name);
    return `    pub ${fieldName}: ${rustType},`;
  }).join("\n");

  const createFields = nonPkFields(entity).map((f) => {
    const rustType = rustFieldType(f.type);
    const fieldName = toSnake(f.name);
    if (f.required) {
      return `    pub ${fieldName}: ${rustType},`;
    } else {
      return `    pub ${fieldName}: Option<${rustType}>,`;
    }
  }).join("\n");

  const updateFields = nonPkFields(entity).map((f) => {
    const rustType = rustFieldType(f.type);
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

function axumHandler(entity: Entity, isPostgres: boolean): string {
  const pascal = toPascal(entity.name);
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const pk = pkField(entity);
  const pkType = pk ? rustFieldType(pk.type) : "uuid::Uuid";
  const pkParam = pk ? toSnake(pk.name) : "id";

  const nonPk = nonPkFields(entity);

  if (!isPostgres) {
    // In-memory store fallback
    return axumHandlerInMemory(pascal, snake, plural, pkParam);
  }

  // Build INSERT columns/placeholders
  const insertCols = nonPk.map((f) => toSnake(f.name));
  const allCols = [pkParam, ...insertCols];
  const allColsSql = allCols.join(", ");
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(", ");
  const insertBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)})`).join("\n");

  // Build UPDATE SET with COALESCE; $1 is the ID, $2+ are fields
  const updateSets = nonPk.map((f, i) => {
    const col = toSnake(f.name);
    return `${col} = COALESCE($${i + 2}, ${col})`;
  }).join(", ");
  const updateBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)})`).join("\n");

  const idImport = pkType === "uuid::Uuid" ? "\nuse uuid::Uuid;" : "";

  return `use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;${idImport}
use crate::models::${snake}::{${pascal}, Create${pascal}, Update${pascal}};

pub fn router() -> axum::Router<PgPool> {
    axum::Router::new()
        .route("/${plural}", axum::routing::get(list).post(create))
        .route("/${plural}/:${pkParam}", axum::routing::get(get_by_id).put(update).delete(delete))
}

async fn list(State(pool): State<PgPool>) -> Result<Json<Vec<${pascal}>>, StatusCode> {
    sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} ORDER BY ${pkParam}")
        .fetch_all(&pool)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn get_by_id(
    State(pool): State<PgPool>,
    Path(${pkParam}): Path<${pkType}>,
) -> Result<Json<${pascal}>, StatusCode> {
    sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = $1")
        .bind(${pkParam})
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn create(
    State(pool): State<PgPool>,
    Json(body): Json<Create${pascal}>,
) -> Result<(StatusCode, Json<${pascal}>), StatusCode> {
    let row = sqlx::query_as::<_, ${pascal}>(
        "INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders}) RETURNING *",
    )
        .bind(Uuid::new_v4())
${insertBinds}
        .fetch_one(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(row)))
}

async fn update(
    State(pool): State<PgPool>,
    Path(${pkParam}): Path<${pkType}>,
    Json(body): Json<Update${pascal}>,
) -> Result<Json<${pascal}>, StatusCode> {
    sqlx::query_as::<_, ${pascal}>(
        "UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = $1 RETURNING *",
    )
        .bind(${pkParam})
${updateBinds}
        .fetch_optional(&pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn delete(
    State(pool): State<PgPool>,
    Path(${pkParam}): Path<${pkType}>,
) -> StatusCode {
    let result = sqlx::query("DELETE FROM ${plural} WHERE ${pkParam} = $1")
        .bind(${pkParam})
        .execute(&pool)
        .await;
    match result {
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

function actixHandler(entity: Entity, isPostgres: boolean): string {
  const pascal = toPascal(entity.name);
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);
  const plural = `${kebab}s`;

  const pk = pkField(entity);
  const pkType = pk ? rustFieldType(pk.type) : "uuid::Uuid";
  const pkParam = pk ? toSnake(pk.name) : "id";

  const nonPk = nonPkFields(entity);

  if (!isPostgres) {
    return actixHandlerInMemory(pascal, snake, plural, pkParam);
  }

  const insertCols = nonPk.map((f) => toSnake(f.name));
  const allCols = [pkParam, ...insertCols];
  const allColsSql = allCols.join(", ");
  const placeholders = allCols.map((_, i) => `$${i + 1}`).join(", ");
  const insertBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)}.clone())`).join("\n");

  const updateSets = nonPk.map((f, i) => {
    const col = toSnake(f.name);
    return `${col} = COALESCE($${i + 2}, ${col})`;
  }).join(", ");
  const updateBinds = nonPk.map((f) => `        .bind(body.${toSnake(f.name)}.clone())`).join("\n");

  const idImport = pkType === "uuid::Uuid" ? "\nuse uuid::Uuid;" : "";

  return `use actix_web::{web, HttpResponse, Responder};
use sqlx::PgPool;${idImport}
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

async fn list(pool: web::Data<PgPool>) -> impl Responder {
    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} ORDER BY ${pkParam}")
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn get_by_id(
    pool: web::Data<PgPool>,
    path: web::Path<${pkType}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    match sqlx::query_as::<_, ${pascal}>("SELECT * FROM ${plural} WHERE ${pkParam} = $1")
        .bind(${pkParam})
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn create(
    pool: web::Data<PgPool>,
    body: web::Json<Create${pascal}>,
) -> impl Responder {
    match sqlx::query_as::<_, ${pascal}>(
        "INSERT INTO ${plural} (${allColsSql}) VALUES (${placeholders}) RETURNING *",
    )
        .bind(Uuid::new_v4())
${insertBinds}
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(row) => HttpResponse::Created().json(row),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn update(
    pool: web::Data<PgPool>,
    path: web::Path<${pkType}>,
    body: web::Json<Update${pascal}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    match sqlx::query_as::<_, ${pascal}>(
        "UPDATE ${plural} SET ${updateSets} WHERE ${pkParam} = $1 RETURNING *",
    )
        .bind(${pkParam})
${updateBinds}
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(row)) => HttpResponse::Ok().json(row),
        Ok(None) => HttpResponse::NotFound().finish(),
        Err(_) => HttpResponse::InternalServerError().finish(),
    }
}

async fn delete(
    pool: web::Data<PgPool>,
    path: web::Path<${pkType}>,
) -> impl Responder {
    let ${pkParam} = path.into_inner();
    match sqlx::query("DELETE FROM ${plural} WHERE ${pkParam} = $1")
        .bind(${pkParam})
        .execute(pool.get_ref())
        .await
    {
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

function rustMain(
  framework: string,
  entities: Entity[],
  endpoints: Endpoint[],
  isPostgres: boolean
): string {
  if (framework === "actix") {
    return actixMain(entities, endpoints, isPostgres);
  }
  return axumMain(entities, endpoints, isPostgres);
}

function axumMain(entities: Entity[], endpoints: Endpoint[], isPostgres: boolean): string {
  const entityRoutes = entities
    .map((e) => `        .merge(handlers::${toSnake(e.name)}::router())`)
    .join("\n");

  const endpointRoutes = endpoints
    .map((e) => {
      const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
      const method = e.method.toLowerCase();
      return `        .route("${path}", axum::routing::${method}(|| async { axum::Json(serde_json::json!({"ok": true, "op": "${e.method} ${e.path}"})) }))`;
    })
    .join("\n");

  const hasEntities = entities.length > 0;
  const handlersMod = hasEntities ? "mod handlers;\n" : "mod handlers;\n";
  const modelsMod = hasEntities ? "mod models;\n" : "mod models;\n";

  const poolSetup = isPostgres
    ? `    let pool = db::connect(&cfg.database_url).await;\n`
    : `    let store = db::new_store();\n`;

  const withState = isPostgres
    ? `        .with_state(pool)`
    : `        .with_state(store)`;

  return `mod config;
mod db;
${handlersMod}${modelsMod}
use axum::Router;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();
    let cfg = config::Config::from_env();
${poolSetup}
    let app = Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
${endpointRoutes}${endpointRoutes && entityRoutes ? "\n" : ""}${entityRoutes}
${withState};

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("listening on {}", addr);
    axum::serve(listener, app).await.unwrap();
}
`;
}

function actixMain(entities: Entity[], endpoints: Endpoint[], isPostgres: boolean): string {
  const entityConfigs = entities
    .map((e) => `            .configure(handlers::${toSnake(e.name)}::config)`)
    .join("\n");

  const endpointRoutes = endpoints
    .map((e) => {
      const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
      const method = e.method.toLowerCase();
      return `            .route("${path}", web::${method}().to(|| async { actix_web::HttpResponse::Ok().json(serde_json::json!({"ok": true, "op": "${e.method} ${e.path}"})) }))`;
    })
    .join("\n");

  const poolSetup = isPostgres
    ? `    let pool = db::connect(&cfg.database_url).await;\n    let pool_data = actix_web::web::Data::new(pool);\n`
    : `    let store = db::new_store();\n    let store_data = actix_web::web::Data::new(store);\n`;

  const appData = isPostgres ? `            .app_data(pool_data.clone())` : `            .app_data(store_data.clone())`;

  return `mod config;
mod db;
mod handlers;
mod models;

use actix_web::{web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();
    let cfg = config::Config::from_env();
${poolSetup}
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("listening on {}", addr);

    HttpServer::new(move || {
        App::new()
${appData}
            .route("/health", web::get().to(|| async { actix_web::HttpResponse::Ok().body("ok") }))
${endpointRoutes}${endpointRoutes && entityConfigs ? "\n" : ""}${entityConfigs}
    })
    .bind(&addr)?
    .run()
    .await
}
`;
}

// ─── tests/{snake}_test.rs ────────────────────────────────────────────────────

function axumTest(entity: Entity): string {
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
        let pool = sqlx::PgPool::connect(
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

function actixTest(entity: Entity): string {
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
        let pool = sqlx::PgPool::connect(
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

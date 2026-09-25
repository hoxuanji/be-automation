// Rust support files behind the builder flags: OTLP tracing, Redis cache,
// message queue + worker binary. rust.ts decides which ones to emit.
import type { StackConfig } from "./types";

export type RustQueue = "rabbitmq" | "kafka" | "nats" | "sqs" | "bullmq";

export type RustFeatures = {
  tracing: boolean;
  rateLimit: boolean;
  audit: boolean;
  sentry: boolean;
  datadog: boolean;
  cache: boolean;
  upstash: boolean;
  queue: RustQueue | null;
};

export function rustFeatures(config: StackConfig): RustFeatures {
  const q = config.queue === "redpanda" ? "kafka" : config.queue;
  return {
    // Datadog and OTel have no Rust-native agent SDK here: both ride on OTLP.
    tracing: config.tracing || config.monitoring === "otel" || config.monitoring === "datadog",
    rateLimit: config.rateLimit,
    audit: config.audit,
    sentry: config.monitoring === "sentry",
    datadog: config.monitoring === "datadog",
    cache: /^(redis|upstash|dragonfly)$/.test(config.cache),
    upstash: config.cache === "upstash",
    queue: (["rabbitmq", "kafka", "nats", "sqs", "bullmq"] as const).find((x) => x === q) ?? null,
  };
}

// ─── Cargo.toml ───────────────────────────────────────────────────────────────

export function rustInfraDeps(framework: string, f: RustFeatures): string {
  const actix = framework === "actix";
  const deps: string[] = [];
  if (f.tracing) {
    // Versions move in lockstep: tracing-opentelemetry 0.30 targets opentelemetry 0.29.
    deps.push(
      `opentelemetry = "0.29"`,
      `opentelemetry_sdk = "0.29"`,
      `opentelemetry-otlp = { version = "0.29", default-features = false, features = ["trace", "http-proto", "reqwest-blocking-client"] }`,
      `tracing-opentelemetry = "0.30"`,
    );
    if (actix) deps.push(`tracing-actix-web = "0.7"`);
  }
  if (f.rateLimit) deps.push(actix ? `actix-governor = "0.5"` : `tower_governor = "0.4"`);
  if (f.sentry) {
    deps.push(`sentry = { version = "0.34", default-features = false, features = ["backtrace", "contexts", "panic", "reqwest", "rustls"] }`);
    deps.push(actix ? `sentry-actix = "0.34"` : `sentry-tower = { version = "0.34", features = ["http", "axum-matched-path"] }`);
  }
  if (f.cache || f.queue === "bullmq") {
    const tls = f.upstash ? `, "tokio-rustls-comp", "tls-rustls-webpki-roots"` : "";
    deps.push(`redis = { version = "0.27", features = ["tokio-comp", "connection-manager"${tls}] }`);
  }
  switch (f.queue) {
    case "rabbitmq":
      deps.push(`lapin = "2"`, `futures-util = "0.3"`);
      break;
    case "kafka":
      // Pure-Rust client: no librdkafka / C toolchain, so it builds anywhere and runs
      // on distroless. No default features = no C-backed compression codecs.
      deps.push(`rskafka = { version = "0.6", default-features = false }`, `futures-util = "0.3"`);
      break;
    case "nats":
      deps.push(`async-nats = "0.38"`, `futures-util = "0.3"`);
      break;
    case "sqs":
      deps.push(`aws-config = "1"`, `aws-sdk-sqs = "1"`);
      break;
  }
  return deps.map((d) => d + "\n").join("");
}

// ─── src/telemetry.rs ─────────────────────────────────────────────────────────

export function rustTelemetry(safe: string, f: RustFeatures): string {
  const dd = f.datadog
    ? `//!
//! Datadog: there is no maintained Datadog tracer for Rust, so traces go over
//! OTLP to the Datadog Agent. Enable its OTLP receiver
//! (DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318) and point
//! OTEL_EXPORTER_OTLP_ENDPOINT at it, e.g. http://datadog-agent:4318.
`
    : "";
  return `//! JSON logs + OpenTelemetry tracing.
//!
//! When OTEL_EXPORTER_OTLP_ENDPOINT is set, spans are exported over OTLP/HTTP
//! (the SDK appends /v1/traces and reads OTEL_SERVICE_NAME itself). When it is
//! unset nothing is exported: only the JSON log layer is installed.
${dd}
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::trace::SdkTracerProvider;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Installs the global subscriber. Keep the returned provider and call
/// \`shutdown()\` on exit so buffered spans are flushed.
pub fn init() -> Option<SdkTracerProvider> {
    let provider = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|_| {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_http()
                .build()
                .expect("build OTLP span exporter");
            let provider = SdkTracerProvider::builder().with_batch_exporter(exporter).build();
            opentelemetry::global::set_tracer_provider(provider.clone());
            provider
        });
    let otel = provider
        .as_ref()
        .map(|p| tracing_opentelemetry::layer().with_tracer(p.tracer("${safe}")));
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .with(otel)
        .init();
    provider
}
`;
}

// ─── src/cache.rs ─────────────────────────────────────────────────────────────

export function rustCache(): string {
  return `//! Redis cache (REDIS_URL). Everything here is best-effort: when Redis is
//! unset or down, reads miss and writes are dropped, so requests fall through
//! to the database instead of failing.
#![allow(dead_code)]

use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use std::time::Duration;
use tokio::sync::OnceCell;

const OP_TIMEOUT: Duration = Duration::from_millis(250);

static CONN: OnceCell<ConnectionManager> = OnceCell::const_new();

// Connects on first use; a failed attempt is retried on the next call.
// ConnectionManager reconnects by itself once established.
async fn conn() -> Option<ConnectionManager> {
    let url = std::env::var("REDIS_URL").ok().filter(|u| !u.is_empty())?;
    CONN.get_or_try_init(|| async move {
        let client = redis::Client::open(url).map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(2), client.get_connection_manager())
            .await
            .map_err(|_| "connect timeout".to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| tracing::warn!("cache: {}", e))
    .ok()
    .cloned()
}

/// Readiness probe: true when Redis answers PING.
pub async fn ping() -> bool {
    let Some(mut c) = conn().await else { return false };
    let pong: Result<Result<String, redis::RedisError>, _> =
        tokio::time::timeout(OP_TIMEOUT, redis::cmd("PING").query_async(&mut c)).await;
    matches!(pong, Ok(Ok(_)))
}

pub async fn get<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let mut c = conn().await?;
    let raw: Option<String> = tokio::time::timeout(OP_TIMEOUT, c.get(key)).await.ok()?.ok()?;
    serde_json::from_str(&raw?).ok()
}

/// Entity reads are cached for 60 s; writes invalidate the key via \`del\`.
pub async fn set<T: serde::Serialize>(key: &str, value: &T) {
    let (Some(mut c), Ok(raw)) = (conn().await, serde_json::to_string(value)) else { return };
    let _ = tokio::time::timeout(OP_TIMEOUT, c.set_ex::<_, _, ()>(key, raw, 60)).await;
}

pub async fn del(key: &str) {
    let Some(mut c) = conn().await else { return };
    let _ = tokio::time::timeout(OP_TIMEOUT, c.del::<_, ()>(key)).await;
}
`;
}

// ─── src/queue.rs ─────────────────────────────────────────────────────────────

const QUEUE_BACKENDS: Record<RustQueue, (region: string) => string> = {
  rabbitmq: () => `//! Message queue: RabbitMQ (RABBITMQ_URL) via lapin. Durable queue, persistent
//! messages, publisher confirms; the worker acks after handling.

use futures_util::StreamExt;
use lapin::{options::*, types::FieldTable, BasicProperties, Channel, Connection, ConnectionProperties};
use std::sync::Arc;

#[derive(Clone)]
struct Client {
    _conn: Arc<Connection>, // keeps the AMQP connection open
    ch: Channel,
}

fn err(e: lapin::Error) -> String {
    e.to_string()
}

async fn connect() -> Result<Client, String> {
    let url = std::env::var("RABBITMQ_URL").unwrap_or_else(|_| "amqp://app:app@localhost:5672".to_string());
    let conn = Connection::connect(&url, ConnectionProperties::default()).await.map_err(err)?;
    let ch = conn.create_channel().await.map_err(err)?;
    ch.confirm_select(ConfirmSelectOptions::default()).await.map_err(err)?;
    ch.queue_declare(QUEUE, QueueDeclareOptions { durable: true, ..Default::default() }, FieldTable::default())
        .await
        .map_err(err)?;
    Ok(Client { _conn: Arc::new(conn), ch })
}

async fn send(c: &Client, payload: &[u8]) -> Result<(), String> {
    let confirm = c
        .ch
        .basic_publish("", QUEUE, BasicPublishOptions::default(), payload, BasicProperties::default().with_delivery_mode(2))
        .await
        .map_err(err)?
        .await
        .map_err(err)?;
    if confirm.is_nack() {
        return Err("broker nacked the message".to_string());
    }
    Ok(())
}

pub async fn consume<F: Fn(&[u8])>(handle: F, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let c = connect().await?;
    c.ch.basic_qos(16, BasicQosOptions::default()).await.map_err(err)?;
    let consumer = c
        .ch
        .basic_consume(QUEUE, "worker", BasicConsumeOptions::default(), FieldTable::default())
        .await
        .map_err(err)?;
    tokio::pin!(consumer, shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            next = consumer.next() => match next {
                Some(Ok(delivery)) => {
                    handle(&delivery.data);
                    delivery.ack(BasicAckOptions::default()).await.map_err(err)?;
                }
                Some(Err(e)) => return Err(err(e)),
                None => return Err("consumer cancelled by the broker".to_string()),
            },
        }
    }
}
`,
  kafka: () => `//! Message queue: Kafka / Redpanda (KAFKA_BROKERS, comma-separated) via rskafka,
//! a pure-Rust client (no librdkafka, so it builds anywhere and runs on distroless).
//! The single-partition topic is created on startup if missing.
//!
//! ponytail: rskafka has no consumer groups. The worker reads partition 0 from the
//! earliest offset and tracks its position in memory only, so run ONE worker
//! replica: a restart replays the topic's retained messages (at-least-once) and a
//! second replica would handle everything twice. Upgrade path: rdkafka against a
//! system librdkafka (with a runtime image that ships it), or a group-coordinating
//! client, once you need several consumers or committed offsets.

use futures_util::StreamExt;
use rskafka::client::consumer::{StartOffset, StreamConsumerBuilder};
use rskafka::client::partition::{Compression, PartitionClient, UnknownTopicHandling};
use rskafka::client::ClientBuilder;
use rskafka::record::Record;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

type Client = Arc<PartitionClient>;

fn err(e: rskafka::client::error::Error) -> String {
    e.to_string()
}

async fn open() -> Result<Client, String> {
    let brokers: Vec<String> = std::env::var("KAFKA_BROKERS")
        .unwrap_or_else(|_| "localhost:9092".to_string())
        .split(',')
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .collect();
    let client = ClientBuilder::new(brokers).build().await.map_err(err)?;
    // "Topic already exists" (or a broker that auto-creates) is fine: ignore the result.
    if let Ok(controller) = client.controller_client() {
        let _ = controller.create_topic(QUEUE, 1, 1, 5_000).await;
    }
    let partition = client.partition_client(QUEUE, 0, UnknownTopicHandling::Retry).await.map_err(err)?;
    Ok(Arc::new(partition))
}

// rskafka retries unreachable brokers indefinitely; bound it so a publish from a
// request handler fails (503) instead of hanging.
async fn connect() -> Result<Client, String> {
    tokio::time::timeout(Duration::from_secs(10), open())
        .await
        .map_err(|_| "kafka: timed out connecting to KAFKA_BROKERS".to_string())?
}

async fn send(p: &Client, payload: &[u8]) -> Result<(), String> {
    let record = Record {
        key: None,
        value: Some(payload.to_vec()),
        headers: BTreeMap::new(),
        timestamp: chrono::Utc::now(),
    };
    p.produce(vec![record], Compression::NoCompression).await.map(|_| ()).map_err(err)
}

pub async fn consume<F: Fn(&[u8])>(handle: F, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let partition = connect().await?;
    let mut next: Option<i64> = None; // in-memory position (see the limitation above)
    tokio::pin!(shutdown);
    loop {
        let start = next.map_or(StartOffset::Earliest, StartOffset::At);
        let mut stream = StreamConsumerBuilder::new(Arc::clone(&partition), start).with_max_wait_ms(500).build();
        loop {
            tokio::select! {
                _ = &mut shutdown => return Ok(()),
                item = stream.next() => match item {
                    Some(Ok((r, _high_watermark))) => {
                        if let Some(value) = &r.record.value {
                            handle(value);
                        }
                        next = Some(r.offset + 1);
                    }
                    // Broker blip: rebuild the stream and resume after the last handled offset.
                    Some(Err(e)) => {
                        tracing::warn!("kafka fetch failed, retrying: {}", e);
                        break;
                    }
                    None => return Err("kafka consumer stream ended".to_string()),
                },
            }
        }
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}
`,
  nats: () => `//! Message queue: NATS JetStream (NATS_URL) via async-nats. Messages land in
//! the NOTIFICATIONS stream; the worker is the durable pull consumer "worker"
//! and acks after handling.

use async_nats::jetstream::{self, consumer::pull, stream};
use futures_util::StreamExt;

type Client = jetstream::Context;
const STREAM: &str = "NOTIFICATIONS";

async fn connect() -> Result<Client, String> {
    let url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://localhost:4222".to_string());
    let nc = async_nats::connect(url.as_str()).await.map_err(|e| e.to_string())?;
    let js = jetstream::new(nc);
    js.get_or_create_stream(stream::Config {
        name: STREAM.to_string(),
        subjects: vec![QUEUE.to_string()],
        ..Default::default()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(js)
}

async fn send(js: &Client, payload: &[u8]) -> Result<(), String> {
    js.publish(QUEUE, payload.to_vec().into())
        .await
        .map_err(|e| e.to_string())?
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn consume<F: Fn(&[u8])>(handle: F, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let js = connect().await?;
    let stream = js.get_stream(STREAM).await.map_err(|e| e.to_string())?;
    let consumer = stream
        .get_or_create_consumer("worker", pull::Config { durable_name: Some("worker".to_string()), ..Default::default() })
        .await
        .map_err(|e| e.to_string())?;
    let messages = consumer.messages().await.map_err(|e| e.to_string())?;
    tokio::pin!(messages, shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            next = messages.next() => match next {
                Some(Ok(m)) => {
                    handle(&m.message.payload);
                    m.ack().await.map_err(|e| e.to_string())?;
                }
                Some(Err(e)) => return Err(e.to_string()),
                None => return Err("JetStream consumer closed".to_string()),
            },
        }
    }
}
`,
  sqs: (region) => `//! Message queue: AWS SQS via aws-sdk-sqs. Credentials and region come from
//! the standard AWS chain (region falls back to ${region}). AWS_ENDPOINT_URL_SQS
//! overrides the endpoint (ElasticMQ locally — it accepts any credentials, but
//! the SDK still needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY set).
//! The queue is created if missing (CreateQueue is idempotent); the worker
//! deletes a message after handling it.

use aws_config::meta::region::RegionProviderChain;

#[derive(Clone)]
struct Client {
    sqs: aws_sdk_sqs::Client,
    url: String,
}

fn err<E: std::error::Error + 'static>(e: E) -> String {
    aws_sdk_sqs::error::DisplayErrorContext(e).to_string()
}

async fn connect() -> Result<Client, String> {
    let region = RegionProviderChain::default_provider().or_else("${region}");
    let shared = aws_config::defaults(aws_config::BehaviorVersion::latest()).region(region).load().await;
    let mut conf = aws_sdk_sqs::config::Builder::from(&shared);
    if let Ok(endpoint) = std::env::var("AWS_ENDPOINT_URL_SQS") {
        conf = conf.endpoint_url(endpoint);
    }
    let sqs = aws_sdk_sqs::Client::from_conf(conf.build());
    let created = sqs.create_queue().queue_name(QUEUE).send().await.map_err(err)?;
    let url = created.queue_url().unwrap_or_default().to_string();
    Ok(Client { sqs, url })
}

async fn send(c: &Client, payload: &[u8]) -> Result<(), String> {
    c.sqs
        .send_message()
        .queue_url(&c.url)
        .message_body(String::from_utf8_lossy(payload))
        .send()
        .await
        .map_err(err)?;
    Ok(())
}

pub async fn consume<F: Fn(&[u8])>(handle: F, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let c = connect().await?;
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            out = c.sqs.receive_message().queue_url(&c.url).wait_time_seconds(10).max_number_of_messages(10).send() => {
                for m in out.map_err(err)?.messages() {
                    handle(m.body().unwrap_or_default().as_bytes());
                    if let Some(receipt) = m.receipt_handle() {
                        c.sqs.delete_message().queue_url(&c.url).receipt_handle(receipt).send().await.map_err(err)?;
                    }
                }
            }
        }
    }
}
`,
  bullmq: () => `//! Message queue: Redis list (REDIS_URL).
//!
//! Limitation: BullMQ jobs are written by BullMQ's own Lua scripts into a
//! version-specific key layout (bull:<queue>:wait / :id / :meta / marker).
//! Re-implementing that from Rust is brittle, so this service does NOT speak
//! BullMQ's format: it LPUSHes raw JSON onto \`queue:notifications\` and the
//! Rust worker (src/bin/worker.rs) RPOPs it. A Node BullMQ worker will not see
//! these jobs — if one must, publish through a small Node producer instead.

use redis::AsyncCommands;
use std::time::Duration;

type Client = redis::aio::ConnectionManager;
const KEY: &str = "queue:notifications";

async fn connect() -> Result<Client, String> {
    let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let client = redis::Client::open(url).map_err(|e| e.to_string())?;
    client.get_connection_manager().await.map_err(|e| e.to_string())
}

async fn send(c: &Client, payload: &[u8]) -> Result<(), String> {
    let mut c = c.clone();
    c.lpush::<_, _, ()>(KEY, payload).await.map_err(|e| e.to_string())
}

pub async fn consume<F: Fn(&[u8])>(handle: F, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    let mut c = connect().await?;
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            popped = c.rpop::<_, Option<Vec<u8>>>(KEY, None) => match popped.map_err(|e| e.to_string())? {
                Some(payload) => handle(&payload),
                // ponytail: polling adds up to 500 ms latency; switch to BRPOP on a
                // dedicated connection if that matters.
                None => tokio::time::sleep(Duration::from_millis(500)).await,
            },
        }
    }
}
`,
};

export function rustQueue(q: RustQueue, region: string): string {
  return `// The API binary only publishes and the worker only consumes.
#![allow(dead_code)]
${QUEUE_BACKENDS[q](region)}
// ─── Shared by every backend ─────────────────────────────────────────────────

use std::future::Future;

/// Queue / topic / subject name.
pub const QUEUE: &str = "notifications";

static CLIENT: tokio::sync::Mutex<Option<Client>> = tokio::sync::Mutex::const_new(None);

/// Publish one message. The connection opens on first use and is re-opened
/// after a failed publish.
pub async fn publish(payload: &[u8]) -> Result<(), String> {
    let client = {
        let mut slot = CLIENT.lock().await;
        match slot.as_ref() {
            Some(c) => c.clone(),
            None => {
                let c = connect().await?;
                *slot = Some(c.clone());
                c
            }
        }
    };
    let res = send(&client, payload).await;
    if res.is_err() {
        *CLIENT.lock().await = None;
    }
    res
}
`;
}

// ─── src/bin/worker.rs ────────────────────────────────────────────────────────

export function rustWorker(): string {
  return `//! Queue worker: consumes \`notifications\` until SIGTERM / SIGINT, then exits
//! after the in-flight message. Run with \`cargo run --bin worker\`.

#[path = "../queue.rs"]
mod queue;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    tracing::info!("worker: consuming {}", queue::QUEUE);
    if let Err(e) = queue::consume(handle, shutdown_signal()).await {
        tracing::error!("worker: {}", e);
        std::process::exit(1);
    }
    tracing::info!("worker: stopped");
}

/// Replace with the real work (send the email, push notification, …).
/// Panicking crashes the worker; the message is redelivered where the broker supports it.
fn handle(payload: &[u8]) {
    tracing::info!(bytes = payload.len(), body = %String::from_utf8_lossy(payload), "worker: message");
}

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

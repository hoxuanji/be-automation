import type { GeneratedFile, StackConfig } from "../types";
import { safeName } from "../types";

// Message-queue wiring for TypeScript REST repos: src/queue.ts (publish /
// subscribe / ping / close over a real client) + src/worker.ts (consumer
// entrypoint). Env names match what common.ts emits in .env / compose.

export type TsQueueKind = "kafka" | "rabbitmq" | "nats" | "sqs" | "bullmq";

export function tsQueueKind(config: StackConfig): TsQueueKind | null {
  const q = config.queue === "redpanda" ? "kafka" : config.queue; // Redpanda speaks the Kafka protocol.
  return (["kafka", "rabbitmq", "nats", "sqs", "bullmq"] as const).find((k) => k === q) ?? null;
}

export function tsQueueDeps(config: StackConfig): Record<string, string> {
  switch (tsQueueKind(config)) {
    case "kafka": return { kafkajs: "^2.2.4" };
    case "rabbitmq": return { amqplib: "^2.0.1" }; // ships its own types since 2.0
    case "nats": return { "@nats-io/transport-node": "^3.4.0", "@nats-io/jetstream": "^3.4.0" }; // successors of the deprecated `nats` package
    case "sqs": return { "@aws-sdk/client-sqs": "^3.1140.0" };
    // ponytail: BullMQ 5.x line (still maintained). 6.x moved Redis clients to pluggable peer adapters — upgrade deliberately.
    case "bullmq": return { bullmq: "^5.81.5" };
    default: return {};
  }
}

export const tsQueueScripts = (config: StackConfig): Record<string, string> =>
  tsQueueKind(config) ? { worker: "node dist/worker.js", "dev:worker": "tsx watch src/worker.ts" } : {};

/** Import line for main.ts / app.controller.ts ("" when no queue is configured). */
export const tsQueueImport = (config: StackConfig) =>
  tsQueueKind(config) ? `import { closeQueue, publish, queuePing, TOPICS } from "./queue";\n` : "";

export function tsQueueFiles(config: StackConfig): GeneratedFile[] {
  const kind = tsQueueKind(config);
  if (!kind) return [];
  return [
    { path: "src/queue.ts", content: HEADER(LABELS[kind]) + CLIENTS[kind](safeName(config.name), config.region) + FOOTER },
    { path: "src/worker.ts", content: WORKER },
  ];
}

const LABELS: Record<TsQueueKind, string> = {
  kafka: "Kafka (kafkajs)",
  rabbitmq: "RabbitMQ (amqplib)",
  nats: "NATS JetStream (@nats-io/transport-node + @nats-io/jetstream)",
  sqs: "AWS SQS (@aws-sdk/client-sqs)",
  bullmq: "BullMQ (Redis)",
};

const HEADER = (label: string) => `// Message queue — ${label}.
// publish() connects lazily on first use; subscribe() is used by the worker
// (src/worker.ts, \`npm run worker\`). Delivery is at-least-once, so handlers
// must be idempotent. queuePing() backs GET /health?ready=1.

export const TOPICS = { notifications: "notifications", webhooks: "webhooks" } as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];
export type Handler = (message: unknown) => Promise<void>;

const logErr = (msg: string, err: unknown) =>
  console.error(JSON.stringify({ level: "error", msg, err: String(err) }));

`;

// Client libraries retry internally (kafkajs for ~30 s, BullMQ until Redis is
// back), so bound what an HTTP request or a readiness probe waits for.
const FOOTER = `
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(\`\${what} timed out after \${ms} ms\`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// A publish that times out may still land, so consumers must be idempotent.
export const publish = (topic: Topic, message: unknown) => withTimeout(send(topic, message), 5_000, "queue publish");
export const queuePing = () => withTimeout(ping(), 2_000, "queue ping");
`;

const CLIENTS: Record<TsQueueKind, (name: string, region: string) => string> = {
  kafka: (name) => `import { Kafka, type Consumer, type Producer } from "kafkajs";

const kafka = new Kafka({
  clientId: ${JSON.stringify(name)},
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim()),
});

let producer: Promise<Producer> | undefined;
const consumers: Consumer[] = [];
const ensured = new Set<string>();

// Brokers may have topic auto-creation off; createTopics is a no-op when it exists.
async function ensureTopic(topic: string) {
  if (ensured.has(topic)) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic }] });
  } finally {
    await admin.disconnect();
  }
  ensured.add(topic);
}

function getProducer(): Promise<Producer> {
  producer ??= (async () => {
    const p = kafka.producer();
    await p.connect();
    return p;
  })().catch((err) => {
    producer = undefined; // retry the connect on the next publish
    throw err;
  });
  return producer;
}

async function send(topic: Topic, message: unknown): Promise<void> {
  await ensureTopic(topic);
  const p = await getProducer();
  await p.send({ topic, messages: [{ value: JSON.stringify(message) }] });
}

export async function subscribe(topic: Topic, handler: Handler): Promise<void> {
  await ensureTopic(topic);
  const consumer = kafka.consumer({ groupId: \`${name}-\${topic}\` });
  consumers.push(consumer);
  await consumer.connect();
  await consumer.subscribe({ topics: [topic] });
  // A thrown handler error leaves the offset uncommitted, so kafkajs retries it.
  await consumer.run({
    eachMessage: async ({ message }) => handler(JSON.parse(message.value?.toString() ?? "null")),
  });
}

async function ping(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.describeCluster();
  } finally {
    await admin.disconnect();
  }
}

export async function closeQueue(): Promise<void> {
  await Promise.all(consumers.map((c) => c.disconnect()));
  await (await producer?.catch(() => undefined))?.disconnect();
}
`,

  rabbitmq: () => `import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";

let conn: Promise<ChannelModel> | undefined;
let channel: Promise<ConfirmChannel> | undefined;
let closing = false;

// Cached handles are dropped on close/failure, so the next call reconnects.
function getConnection(): Promise<ChannelModel> {
  conn ??= connect(process.env.RABBITMQ_URL ?? "amqp://app:app@localhost:5672").then(
    (c) => {
      c.on("error", (err) => logErr("rabbitmq connection error", err));
      c.on("close", () => { conn = channel = undefined; });
      return c;
    },
    (err) => { conn = undefined; throw err; },
  );
  return conn;
}

// Confirm channel: publish() resolves only after the broker has the message.
function getChannel(): Promise<ConfirmChannel> {
  channel ??= getConnection()
    .then((c) => c.createConfirmChannel())
    .then(
      (ch) => {
        ch.on("error", (err) => logErr("rabbitmq channel error", err));
        ch.on("close", () => { channel = undefined; });
        return ch;
      },
      (err) => { channel = undefined; throw err; },
    );
  return channel;
}

async function send(topic: Topic, message: unknown): Promise<void> {
  const ch = await getChannel();
  await ch.assertQueue(topic, { durable: true });
  ch.sendToQueue(topic, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: "application/json" });
  await ch.waitForConfirms();
}

export async function subscribe(topic: Topic, handler: Handler): Promise<void> {
  const ch = await getChannel();
  await ch.assertQueue(topic, { durable: true });
  await ch.prefetch(10);
  // amqplib doesn't re-attach consumers after a reconnect: exit and let the
  // supervisor (compose restart policy / K8s) start a fresh worker.
  ch.on("close", () => {
    if (!closing) { logErr("rabbitmq channel closed", "exiting worker"); process.exit(1); }
  });
  await ch.consume(topic, (msg) => {
    if (!msg) return; // consumer cancelled by the broker
    Promise.resolve()
      .then(() => handler(JSON.parse(msg.content.toString())))
      .then(
        () => ch.ack(msg),
        (err) => {
          logErr(\`\${topic} handler failed\`, err);
          // ponytail: retry once, then drop. Add a dead-letter exchange to keep failures.
          ch.nack(msg, false, !msg.fields.redelivered);
        },
      );
  });
}

// A dropped connection clears the cache, so this reconnects (or throws).
async function ping(): Promise<void> {
  await getChannel();
}

export async function closeQueue(): Promise<void> {
  closing = true;
  const c = await conn?.catch(() => undefined);
  await c?.close();
}
`,

  nats: (name) => `import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";

// Not imported by name: transport-node re-exports the type from a subpath export
// ("@nats-io/nats-core/internal") that moduleResolution "node" can't resolve.
type NatsConnection = Awaited<ReturnType<typeof connect>>;

let nc: Promise<NatsConnection> | undefined;
const ensured = new Set<string>();

function getConnection(): Promise<NatsConnection> {
  nc ??= connect({
    servers: process.env.NATS_URL ?? "nats://localhost:4222",
    name: ${JSON.stringify(name)},
    maxReconnectAttempts: -1, // keep reconnecting; readiness reports the outage
  }).then(
    (c) => {
      void c.closed().then(() => { nc = undefined; });
      return c;
    },
    (err) => { nc = undefined; throw err; },
  );
  return nc;
}

// One JetStream stream per topic, so messages survive while no worker is up.
const streamName = (topic: string) => topic.replace(/[^A-Za-z0-9_-]/g, "_").toUpperCase();

async function ensureStream(c: NatsConnection, topic: string) {
  if (ensured.has(topic)) return;
  const jsm = await jetstreamManager(c);
  await jsm.streams.info(streamName(topic)).catch(() => jsm.streams.add({ name: streamName(topic), subjects: [topic] }));
  ensured.add(topic);
}

async function send(topic: Topic, message: unknown): Promise<void> {
  const c = await getConnection();
  await ensureStream(c, topic);
  await jetstream(c).publish(topic, JSON.stringify(message));
}

export async function subscribe(topic: Topic, handler: Handler): Promise<void> {
  const c = await getConnection();
  await ensureStream(c, topic);
  const durable = \`${name}-\${topic}\`;
  const jsm = await jetstreamManager(c);
  await jsm.consumers.add(streamName(topic), { durable_name: durable, ack_policy: AckPolicy.Explicit, max_deliver: 5 });
  const consumer = await jetstream(c).consumers.get(streamName(topic), durable);
  const messages = await consumer.consume();
  void (async () => {
    for await (const m of messages) {
      try {
        await handler(m.json());
        m.ack();
      } catch (err) {
        logErr(\`\${topic} handler failed\`, err);
        m.nak(); // redelivered up to max_deliver times
      }
    }
  })();
}

async function ping(): Promise<void> {
  const c = await getConnection();
  if (c.isClosed()) throw new Error("nats connection closed");
  await c.flush(); // round-trip to the server
}

export async function closeQueue(): Promise<void> {
  const c = await nc?.catch(() => undefined);
  if (c && !c.isClosed()) await c.drain();
}
`,

  sqs: (_name, region) => `import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

// Credentials come from the default AWS chain. AWS_ENDPOINT_URL_SQS (set for
// local ElasticMQ / LocalStack) is read by the SDK automatically.
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? ${JSON.stringify(region)} });
const urls = new Map<string, Promise<string>>();
const abort = new AbortController();

// CreateQueue is idempotent and returns the queue URL.
function queueUrl(topic: string): Promise<string> {
  let url = urls.get(topic);
  if (!url) {
    url = sqs.send(new CreateQueueCommand({ QueueName: topic })).then((r) => r.QueueUrl!);
    url.catch(() => urls.delete(topic));
    urls.set(topic, url);
  }
  return url;
}

async function send(topic: Topic, message: unknown): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: await queueUrl(topic), MessageBody: JSON.stringify(message) }));
}

export async function subscribe(topic: Topic, handler: Handler): Promise<void> {
  const QueueUrl = await queueUrl(topic);
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 20, MaxNumberOfMessages: 10 }),
          { abortSignal: abort.signal },
        );
        for (const m of Messages) {
          try {
            await handler(JSON.parse(m.Body ?? "null"));
            await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
          } catch (err) {
            // Not deleted: SQS redelivers after the visibility timeout (configure a redrive policy for a DLQ).
            logErr(\`\${topic} handler failed\`, err);
          }
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        logErr(\`\${topic} receive failed\`, err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  })();
}

async function ping(): Promise<void> {
  await sqs.send(new ListQueuesCommand({ MaxResults: 1 }));
}

export async function closeQueue(): Promise<void> {
  abort.abort();
  sqs.destroy();
}
`,

  bullmq: () => `import { Queue, Worker } from "bullmq";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
// Producers fail fast when Redis is down; workers block on Redis and so need
// maxRetriesPerRequest: null.
const queues = new Map<string, Queue>();
const workers: Worker[] = [];

function getQueue(topic: string): Queue {
  let q = queues.get(topic);
  if (!q) {
    q = new Queue(topic, { connection: { url, enableOfflineQueue: false } });
    q.on("error", (err) => logErr(\`queue \${topic} error\`, err));
    queues.set(topic, q);
  }
  return q;
}

async function send(topic: Topic, message: unknown): Promise<void> {
  await getQueue(topic).add(topic, message, {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

export async function subscribe(topic: Topic, handler: Handler): Promise<void> {
  const worker = new Worker(topic, async (job) => handler(job.data), { connection: { url, maxRetriesPerRequest: null } });
  worker.on("failed", (_job, err) => logErr(\`\${topic} handler failed\`, err));
  worker.on("error", (err) => logErr(\`worker \${topic} error\`, err));
  workers.push(worker);
  await worker.waitUntilReady();
}

async function ping(): Promise<void> {
  // Any Redis round-trip will do; with the offline queue off it fails fast.
  await getQueue(TOPICS.notifications).getJobCounts("waiting");
}

export async function closeQueue(): Promise<void> {
  await Promise.all([...workers, ...queues.values()].map((x) => x.close()));
}
`,
};

const WORKER = `import { closeQueue, subscribe, TOPICS } from "./queue";

// Consumer process — \`npm run worker\` locally, \`node dist/worker.js\` in the image.
// Throwing from a handler hands the message back to the broker for redelivery.
async function main() {
  await subscribe(TOPICS.notifications, async (message) => {
    // Deliver through your email / SMS / push provider here.
    const { channel } = (message ?? {}) as { channel?: string };
    console.log(JSON.stringify({ level: "info", msg: "notification received", channel }));
  });
  await subscribe(TOPICS.webhooks, async (message) => {
    // Process the verified webhook event here.
    const { receivedAt } = (message ?? {}) as { receivedAt?: string };
    console.log(JSON.stringify({ level: "info", msg: "webhook event received", receivedAt }));
  });
  console.log(JSON.stringify({ level: "info", msg: "worker started", topics: Object.values(TOPICS) }));
}

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", msg: "worker shutdown", signal }));
  try {
    await closeQueue();
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "worker shutdown failed", err: String(err) }));
    process.exit(1);
  }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "worker failed to start", err: String(err) }));
  process.exit(1);
});
`;

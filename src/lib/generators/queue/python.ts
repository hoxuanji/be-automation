import type { StackConfig } from "../types";
import { safeName } from "../types";

// Python message-broker wiring: app/queue.py (publish / consume / ping) and
// app/worker.py (`python -m app.worker`). Every backend exposes the same five
// coroutines, so main.py and the pattern handlers stay broker-agnostic.

export type PyQueue = "kafka" | "rabbitmq" | "nats" | "sqs" | "bullmq";

export function pyQueue(config: StackConfig): PyQueue | undefined {
  if (config.queue === "kafka" || config.queue === "redpanda") return "kafka";
  if (["rabbitmq", "nats", "sqs", "bullmq"].includes(config.queue)) return config.queue as PyQueue;
  return undefined;
}

export function pyQueueDeps(q: PyQueue | undefined): string[] {
  switch (q) {
    case "kafka":    return [`aiokafka = "^0.14.0"`];
    case "rabbitmq": return [`aio-pika = "^10.0.0"`];
    case "nats":     return [`nats-py = "^2.16.0"`];
    case "sqs":      return [`aiobotocore = "^3.9.0"`];
    // bullmq pins redis exactly; the redis line in pyproject must agree (see pyproject()).
    case "bullmq":   return [`bullmq = "~3.2.7"`];
    default:         return [];
  }
}

const HEADER = (label: string, env: string, json = true) => `"""Message broker client (${label}).

Request handlers call \`publish()\`; \`python -m app.worker\` runs \`consume()\`.
connect() runs at app startup (and in the worker), close() on shutdown, and
ping() backs the readiness probe (GET /health?ready=1). Reads ${env}.
"""
from __future__ import annotations

import asyncio
${json ? "import json\n" : ""}import logging
import os
from collections.abc import Awaitable, Callable
`;

const COMMON = `
log = logging.getLogger(__name__)

# Topics / queues this service publishes to; app.worker consumes all of them.
TOPICS = ("notifications", "webhooks")

Handler = Callable[[str, dict], Awaitable[None]]


async def _with_retry(connect_once, attempts: int = 6, delay: float = 0.5, timeout: float = 10.0):
    """Retry the initial connection with backoff — brokers often boot after the app.
    Each attempt is capped at \`timeout\` seconds (some clients retry internally forever)."""
    for attempt in range(1, attempts + 1):
        try:
            return await asyncio.wait_for(connect_once(), timeout)
        except Exception as exc:
            if attempt == attempts:
                raise
            log.warning("queue: connect attempt %d/%d failed (%s); retrying in %.1fs",
                        attempt, attempts, exc.__class__.__name__, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)


def _require(client):
    if client is None:
        raise RuntimeError("queue is not connected — call connect() first")
    return client
`;

function kafka(group: string): string {
  return `${HEADER("Kafka / Redpanda via aiokafka", "KAFKA_BROKERS")}
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.admin import AIOKafkaAdminClient, NewTopic
${COMMON}

BROKERS = os.environ.get("KAFKA_BROKERS", "localhost:9092")
GROUP_ID = ${JSON.stringify(group)}

_producer: AIOKafkaProducer | None = None


async def _ensure_topics() -> None:
    # Redpanda / Kafka without auto.create.topics would reject unknown topics.
    admin = AIOKafkaAdminClient(bootstrap_servers=BROKERS)
    await admin.start()
    try:
        existing = set(await admin.list_topics())
        missing = [NewTopic(t, num_partitions=1, replication_factor=1) for t in TOPICS if t not in existing]
        if missing:
            await admin.create_topics(missing)
    finally:
        await admin.close()


async def connect() -> None:
    global _producer

    async def once() -> AIOKafkaProducer:
        await _ensure_topics()
        producer = AIOKafkaProducer(
            bootstrap_servers=BROKERS,
            value_serializer=lambda v: json.dumps(v).encode(),
            acks="all",
            enable_idempotence=True,
        )
        try:
            await producer.start()
        except BaseException:  # incl. the per-attempt timeout's cancellation
            await producer.stop()
            raise
        return producer

    _producer = await _with_retry(once)


async def close() -> None:
    global _producer
    if _producer is not None:
        await _producer.stop()
        _producer = None


async def ping() -> bool:
    if _producer is None:
        return False
    try:
        await _producer.client.fetch_all_metadata()
        return True
    except Exception:
        return False


async def publish(topic: str, payload: dict) -> None:
    await _require(_producer).send_and_wait(topic, payload)


async def consume(handler: Handler) -> None:
    """Run until cancelled. Offsets are committed after the handler succeeds (at-least-once)."""
    consumer = AIOKafkaConsumer(
        *TOPICS,
        bootstrap_servers=BROKERS,
        group_id=GROUP_ID,
        enable_auto_commit=False,
        auto_offset_reset="earliest",
        value_deserializer=lambda b: json.loads(b),
    )
    await consumer.start()
    try:
        async for msg in consumer:
            try:
                await handler(msg.topic, msg.value)
            except Exception:
                # ponytail: poison messages are logged and skipped; add a dead-letter topic if they must be kept.
                log.exception("queue: handler failed", extra={"topic": msg.topic, "offset": msg.offset})
            await consumer.commit()
    finally:
        await consumer.stop()
`;
}

function rabbitmq(): string {
  return `${HEADER("RabbitMQ via aio-pika", "RABBITMQ_URL")}
import aio_pika
${COMMON}

URL = os.environ.get("RABBITMQ_URL", "amqp://app:app@localhost:5672")

_connection: aio_pika.abc.AbstractRobustConnection | None = None
_channel: aio_pika.abc.AbstractChannel | None = None


async def connect() -> None:
    global _connection, _channel
    # connect_robust reconnects on its own once the first connection succeeds.
    _connection = await _with_retry(lambda: aio_pika.connect_robust(URL))
    _channel = await _connection.channel(publisher_confirms=True)
    for topic in TOPICS:
        await _channel.declare_queue(topic, durable=True)


async def close() -> None:
    global _connection, _channel
    if _connection is not None:
        await _connection.close()
    _connection = _channel = None


async def ping() -> bool:
    return _connection is not None and not _connection.is_closed


async def publish(topic: str, payload: dict) -> None:
    message = aio_pika.Message(
        json.dumps(payload).encode(),
        content_type="application/json",
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
    )
    await _require(_channel).default_exchange.publish(message, routing_key=topic)


async def consume(handler: Handler) -> None:
    """Run until cancelled. A message is acked when the handler returns and
    rejected (dead-lettered if the queue has a DLX) when it raises."""
    channel = await _require(_connection).channel()
    await channel.set_qos(prefetch_count=10)
    try:
        for topic in TOPICS:
            queue = await channel.declare_queue(topic, durable=True)

            async def on_message(message: aio_pika.abc.AbstractIncomingMessage, topic: str = topic) -> None:
                async with message.process(requeue=False):
                    await handler(topic, json.loads(message.body))

            await queue.consume(on_message)
        await asyncio.Future()  # park until cancelled
    finally:
        await channel.close()
`;
}

function nats(group: string): string {
  return `${HEADER("NATS JetStream via nats-py", "NATS_URL")}
import nats
from nats.aio.client import Client
from nats.js import JetStreamContext
${COMMON}

URL = os.environ.get("NATS_URL", "nats://localhost:4222")
STREAM = "EVENTS"
DURABLE = ${JSON.stringify(group)}

_nc: Client | None = None
_js: JetStreamContext | None = None


async def connect() -> None:
    global _nc, _js
    _nc = await _with_retry(lambda: nats.connect(URL, max_reconnect_attempts=-1))
    _js = _nc.jetstream()
    # Idempotent: re-adding a stream with the same config is a no-op.
    await _js.add_stream(name=STREAM, subjects=list(TOPICS))


async def close() -> None:
    global _nc, _js
    if _nc is not None:
        await _nc.drain()
    _nc = _js = None


async def ping() -> bool:
    return _nc is not None and _nc.is_connected


async def publish(topic: str, payload: dict) -> None:
    # JetStream publish waits for the stream's ack, so the message is persisted.
    await _require(_js).publish(topic, json.dumps(payload).encode())


async def _consume_topic(topic: str, handler: Handler) -> None:
    sub = await _require(_js).pull_subscribe(topic, durable=f"{DURABLE}-{topic}", stream=STREAM)
    while True:
        try:
            msgs = await sub.fetch(10, timeout=5)
        except nats.errors.TimeoutError:
            continue
        for msg in msgs:
            try:
                await handler(topic, json.loads(msg.data))
                await msg.ack()
            except Exception:
                log.exception("queue: handler failed", extra={"topic": topic})
                await msg.nak()


async def consume(handler: Handler) -> None:
    """Run until cancelled. Acked on success, nak'd (redelivered) on failure."""
    await asyncio.gather(*(_consume_topic(t, handler) for t in TOPICS))
`;
}

function sqs(): string {
  return `${HEADER("AWS SQS via aiobotocore", "AWS_REGION + AWS credentials; botocore also reads AWS_ENDPOINT_URL_SQS (ElasticMQ / LocalStack)")}
from contextlib import AsyncExitStack

from aiobotocore.session import get_session
${COMMON}

_stack: AsyncExitStack | None = None
_client = None
_urls: dict[str, str] = {}


async def _queue_url(client, name: str) -> str:
    try:
        return (await client.get_queue_url(QueueName=name))["QueueUrl"]
    except client.exceptions.QueueDoesNotExist:
        # ponytail: creates missing queues (local dev); provision them with IaC and drop this in production.
        return (await client.create_queue(QueueName=name))["QueueUrl"]


async def connect() -> None:
    global _stack, _client
    stack = AsyncExitStack()
    # AWS_ENDPOINT_URL_SQS, when set, points the client at ElasticMQ / LocalStack.
    client = await stack.enter_async_context(
        get_session().create_client("sqs", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    )

    async def once() -> None:
        for topic in TOPICS:
            _urls[topic] = await _queue_url(client, topic)

    try:
        await _with_retry(once)
    except Exception:
        await stack.aclose()
        raise
    _stack, _client = stack, client


async def close() -> None:
    global _stack, _client
    if _stack is not None:
        await _stack.aclose()
    _stack = _client = None


async def ping() -> bool:
    if _client is None:
        return False
    try:
        await _client.get_queue_attributes(QueueUrl=_urls[TOPICS[0]], AttributeNames=["QueueArn"])
        return True
    except Exception:
        return False


async def publish(topic: str, payload: dict) -> None:
    await _require(_client).send_message(QueueUrl=_urls[topic], MessageBody=json.dumps(payload))


async def _consume_topic(topic: str, handler: Handler) -> None:
    client = _require(_client)
    while True:
        resp = await client.receive_message(QueueUrl=_urls[topic], MaxNumberOfMessages=10, WaitTimeSeconds=10)
        for msg in resp.get("Messages", []):
            try:
                await handler(topic, json.loads(msg["Body"]))
            except Exception:
                # Not deleted → redelivered after the visibility timeout (then to the DLQ, if configured).
                log.exception("queue: handler failed", extra={"topic": topic})
                continue
            await client.delete_message(QueueUrl=_urls[topic], ReceiptHandle=msg["ReceiptHandle"])


async def consume(handler: Handler) -> None:
    """Run until cancelled (long-polls every queue)."""
    await asyncio.gather(*(_consume_topic(t, handler) for t in TOPICS))
`;
}

function bullmq(): string {
  return `${HEADER("BullMQ (Redis) via the bullmq package", "REDIS_URL", false)}
from bullmq import Queue, Worker
${COMMON}

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

_queues: dict[str, Queue] = {}


async def connect() -> None:
    async def once() -> None:
        queues = {t: Queue(t, {"connection": REDIS_URL}) for t in TOPICS}
        try:
            await queues[TOPICS[0]].getJobCounts("waiting")  # round-trip: fail fast if Redis is down
        except BaseException:  # incl. the per-attempt timeout's cancellation
            for q in queues.values():
                await q.close()
            raise
        _queues.update(queues)

    await _with_retry(once)


async def close() -> None:
    for q in _queues.values():
        await q.close()
    _queues.clear()


async def ping() -> bool:
    if not _queues:
        return False
    try:
        await _queues[TOPICS[0]].getJobCounts("waiting")
        return True
    except Exception:
        return False


async def publish(topic: str, payload: dict) -> None:
    # Completed jobs are dropped; failed ones are kept for inspection / retry.
    await _require(_queues.get(topic)).add(topic, payload, {"removeOnComplete": True})


async def consume(handler: Handler) -> None:
    """Run until cancelled. A job fails (and is retried per its attempts) when the handler raises."""
    def processor(topic: str):
        async def process(job, _token):
            await handler(topic, job.data)
        return process

    workers = [Worker(t, processor(t), {"connection": REDIS_URL}) for t in TOPICS]
    try:
        await asyncio.Future()  # park until cancelled
    finally:
        # close() waits for in-flight jobs to finish.
        for w in workers:
            await w.close()
`;
}

export function pyQueueModule(q: PyQueue, config: StackConfig): string {
  const group = safeName(config.name);
  switch (q) {
    case "kafka":    return kafka(group);
    case "rabbitmq": return rabbitmq();
    case "nats":     return nats(group);
    case "sqs":      return sqs();
    case "bullmq":   return bullmq();
  }
}

export function pyWorkerModule(): string {
  return `"""Queue consumer — run with \`python -m app.worker\`.

SIGTERM / SIGINT cancel the consumer; each backend acks only after
handle() returns, so a message interrupted mid-handler is redelivered.
"""
from __future__ import annotations

import asyncio
import logging
import signal

from . import queue as broker
from .logging_config import configure_logging

log = logging.getLogger("app.worker")


async def handle(topic: str, payload: dict) -> None:
    """Process one message. Raise to signal failure (the broker redelivers / dead-letters)."""
    # Replace with real work: send the notification, process the webhook event, …
    log.info("message received", extra={"topic": topic, "payload": payload})


async def main() -> None:
    configure_logging()
    await broker.connect()
    task = asyncio.create_task(broker.consume(handle))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    log.info("worker started", extra={"topics": list(broker.TOPICS)})
    try:
        await task
    except asyncio.CancelledError:
        log.info("worker stopping")
    finally:
        await broker.close()


if __name__ == "__main__":
    asyncio.run(main())
`;
}

// Kotlin runtime wiring for the builder flags: tracing, rate limiting, audit,
// Sentry / Datadog, Redis cache-aside and queues. kotlin.ts calls into this for
// both Ktor and spring-kt. Every client is injectable (Ktor: module() params;
// Spring: @Profile("!test") beans) so `gradle test` runs with no services.
import type { GeneratedFile, StackConfig } from "./types";

export type KtQueue = "kafka" | "rabbitmq" | "nats" | "sqs" | "bullmq";

export type KtInfra = {
  redis: boolean; // Redis-protocol cache (redis / upstash / dragonfly)
  queue: KtQueue | null;
  tracing: boolean;
  rateLimit: boolean;
  audit: boolean;
  sentry: boolean;
  datadog: boolean;
  region: string;
};

const QUEUES: KtQueue[] = ["kafka", "rabbitmq", "nats", "sqs", "bullmq"];

export function ktInfra(c: StackConfig): KtInfra {
  const q = c.queue === "redpanda" ? "kafka" : c.queue; // Redpanda speaks the Kafka protocol
  return {
    redis: /^(redis|upstash|dragonfly)$/.test(c.cache),
    queue: (QUEUES as string[]).includes(q) ? (q as KtQueue) : null,
    tracing: c.tracing,
    rateLimit: c.rateLimit,
    audit: c.audit,
    sentry: c.monitoring === "sentry",
    datadog: c.monitoring === "datadog",
    region: c.region || "us-east-1",
  };
}

const lines = (xs: (string | false)[]) => xs.filter(Boolean).join("\n");
const imports = (xs: string[]) => [...new Set(xs)].sort().map((x) => `import ${x}`).join("\n");

// ─── Ktor ─────────────────────────────────────────────────────────────────────

export function ktorInfraDeps(i: KtInfra): string {
  const d: string[] = [];
  if (i.tracing) d.push(
    "    // OpenTelemetry server spans, exported via OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set.",
    `    implementation("io.opentelemetry.instrumentation:opentelemetry-ktor-2.0:2.8.0-alpha")`,
    `    implementation("io.opentelemetry:opentelemetry-sdk:1.42.1")`,
    `    implementation("io.opentelemetry:opentelemetry-exporter-otlp:1.42.1")`,
  );
  if (i.rateLimit) d.push(`    implementation("io.ktor:ktor-server-rate-limit:\$ktor_version")`);
  if (i.sentry) d.push(`    implementation("io.sentry:sentry:7.14.0")`);
  if (i.datadog) d.push(
    "    // Datadog metrics pushed with DD_API_KEY (APM traces need the dd-java-agent; see SETUP_MONITORING.md).",
    `    implementation("io.ktor:ktor-server-metrics-micrometer:\$ktor_version")`,
    `    implementation("io.micrometer:micrometer-registry-datadog:1.12.5")`,
  );
  if (i.redis || i.queue === "bullmq") d.push(`    implementation("io.lettuce:lettuce-core:6.4.0.RELEASE")`);
  const q: Record<KtQueue, string> = {
    kafka: "org.apache.kafka:kafka-clients:3.8.0",
    rabbitmq: "com.rabbitmq:amqp-client:5.21.0",
    nats: "io.nats:jnats:2.20.2",
    sqs: "software.amazon.awssdk:sqs:2.28.16",
    bullmq: "",
  };
  if (i.queue && q[i.queue]) d.push(`    implementation("${q[i.queue]}")`);
  return d.length ? d.join("\n") + "\n" : "";
}

/** Extra `worker` task for the standalone consumer. */
export function ktorWorkerTask(i: KtInfra): string {
  return i.queue
    ? `
// Standalone queue consumer (Worker.kt). In the fat jar: java -cp app.jar Worker
tasks.register<JavaExec>("worker") {
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("Worker")
}
`
    : "";
}

export const ktorHasObservability = (i: KtInfra) => i.tracing || i.rateLimit || i.audit || i.sentry || i.datadog;

/** module() parameters; production defaults, tests pass fakes (TestSupport.kt). */
export function ktorModuleParams(i: KtInfra): string[] {
  return [i.redis && "cache: Cache = RedisCache()", i.queue && "queue: JobQueue = connectQueue()"].filter(Boolean) as string[];
}

/** Lines at the top of module(), before routing. */
export function ktorModuleInstalls(i: KtInfra): string[] {
  return [
    i.tracing && "    configureTracing()",
    i.sentry && "    configureSentry()",
    i.datadog && "    configureDatadog()",
    i.rateLimit && "    configureRateLimit()",
    i.audit && "    configureAudit()",
  ].filter(Boolean) as string[];
}

/** Lines at the end of module(): in-process consumer + client shutdown. */
export function ktorModuleTail(i: KtInfra): string {
  const close = [i.redis && "cache.close()", i.queue && "queue.close()"].filter(Boolean).join("; ");
  return lines([
    !!i.queue && "    launchConsumer(queue) // in-process consumer; Worker.kt runs the same loop standalone",
    close && `    environment.monitor.subscribe(ApplicationStopped) { ${close} }`,
  ]);
}

/** /health (liveness) and /health?ready=1 (readiness: every dependency answers). */
export function ktorHealthRoute(i: KtInfra): string {
  const checks = ['"db" to dbReady()', i.redis && '"cache" to cache.ping()', i.queue && '"queue" to queue.ping()'].filter(Boolean).join(", ");
  return `        get("/health") {
            if (call.request.queryParameters["ready"] == null) return@get call.respond(mapOf("ok" to true))
            val checks = mapOf(${checks})
            val ok = checks.values.all { it }
            call.respond(if (ok) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable, checks + ("ok" to ok))
        }`;
}

export function ktorInfraFiles(i: KtInfra, appName: string, withAuth: boolean): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (ktorHasObservability(i)) files.push({ path: "src/main/kotlin/Observability.kt", content: ktorObservability(i, appName, withAuth) });
  if (i.redis) files.push({ path: "src/main/kotlin/Cache.kt", content: ktorCache() });
  if (i.queue) {
    files.push({ path: "src/main/kotlin/Queue.kt", content: ktorQueue(i) });
    files.push({ path: "src/main/kotlin/Worker.kt", content: ktorWorker() });
  }
  return files;
}

function ktorObservability(i: KtInfra, appName: string, withAuth: boolean): string {
  const imp: string[] = ["io.ktor.server.application.*"];
  const parts: string[] = [];
  if (i.tracing) {
    imp.push(
      "io.opentelemetry.api.common.AttributeKey", "io.opentelemetry.api.common.Attributes",
      "io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator", "io.opentelemetry.context.propagation.ContextPropagators",
      "io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter", "io.opentelemetry.instrumentation.ktor.v2_0.server.KtorServerTracing",
      "io.opentelemetry.sdk.OpenTelemetrySdk", "io.opentelemetry.sdk.resources.Resource",
      "io.opentelemetry.sdk.trace.SdkTracerProvider", "io.opentelemetry.sdk.trace.export.BatchSpanProcessor",
    );
    parts.push(`/** Server spans for every request, exported to OTEL_EXPORTER_OTLP_ENDPOINT (OTLP/HTTP). No-op when unset. */
fun Application.configureTracing() {
    val endpoint = System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")?.takeIf { it.isNotBlank() } ?: return
    val serviceName = System.getenv("OTEL_SERVICE_NAME") ?: "${appName}"
    val tracerProvider = SdkTracerProvider.builder()
        .setResource(Resource.getDefault().merge(Resource.create(Attributes.of(AttributeKey.stringKey("service.name"), serviceName))))
        .addSpanProcessor(BatchSpanProcessor.builder(OtlpHttpSpanExporter.builder().setEndpoint(endpoint.trimEnd('/') + "/v1/traces").build()).build())
        .build()
    val openTelemetry = OpenTelemetrySdk.builder()
        .setTracerProvider(tracerProvider)
        .setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance()))
        .build()
    install(KtorServerTracing) { setOpenTelemetry(openTelemetry) }
    environment.monitor.subscribe(ApplicationStopped) { tracerProvider.close() }
}`);
  }
  if (i.sentry) {
    imp.push("io.sentry.Sentry");
    parts.push(`/** Reports unhandled exceptions to Sentry. No-op when SENTRY_DSN is unset. */
fun Application.configureSentry() {
    val dsn = System.getenv("SENTRY_DSN")?.takeIf { it.isNotBlank() } ?: return
    Sentry.init { it.dsn = dsn }
    intercept(ApplicationCallPipeline.Monitoring) {
        try {
            proceed()
        } catch (e: Throwable) {
            Sentry.captureException(e)
            throw e
        }
    }
    environment.monitor.subscribe(ApplicationStopped) { Sentry.close() }
}`);
  }
  if (i.datadog) {
    imp.push("io.ktor.server.metrics.micrometer.*", "io.micrometer.core.instrument.Clock", "io.micrometer.datadog.DatadogConfig", "io.micrometer.datadog.DatadogMeterRegistry");
    parts.push(`/** Request metrics pushed to Datadog with DD_API_KEY. No-op when unset. */
fun Application.configureDatadog() {
    val apiKey = System.getenv("DD_API_KEY")?.takeIf { it.isNotBlank() } ?: return
    val config = object : DatadogConfig {
        override fun apiKey() = apiKey
        override fun get(key: String): String? = null
    }
    val datadog = DatadogMeterRegistry(config, Clock.SYSTEM)
    install(MicrometerMetrics) { registry = datadog }
    environment.monitor.subscribe(ApplicationStopped) { datadog.close() }
}`);
  }
  if (i.rateLimit) {
    imp.push("io.ktor.server.plugins.*", "io.ktor.server.plugins.ratelimit.*", "kotlin.time.Duration.Companion.seconds");
    parts.push(`/** 60 requests / minute per client IP; excess requests get 429 with Retry-After. */
fun Application.configureRateLimit() {
    install(RateLimit) {
        global {
            // ponytail: in-memory, per replica. Behind a proxy install XForwardedHeaders so this is the client IP.
            rateLimiter(limit = 60, refillPeriod = 60.seconds)
            requestKey { call -> call.request.origin.remoteHost }
        }
    }
}`);
  }
  if (i.audit) {
    imp.push("io.ktor.http.*", "io.ktor.server.plugins.*", "io.ktor.server.request.*", "org.slf4j.LoggerFactory");
    if (withAuth) imp.push("io.ktor.server.auth.*", "io.ktor.server.auth.jwt.*");
    parts.push(`private val auditLog = LoggerFactory.getLogger("audit")
private val mutating = setOf(HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete)

/** One "audit" log line per mutating request: who, what, outcome. */
fun Application.configureAudit() {
    intercept(ApplicationCallPipeline.Monitoring) {
        try {
            proceed()
        } finally {
            if (call.request.httpMethod in mutating) {
                auditLog.info(
                    "audit method={} path={} status={} subject={} ip={}",
                    call.request.httpMethod.value, call.request.path(), call.response.status()?.value,
                    ${withAuth ? "call.principal<JWTPrincipal>()?.subject" : "null"}, call.request.origin.remoteHost,
                )
            }
        }
    }
}`);
  }
  return `${imports(imp)}\n\n${parts.join("\n\n")}\n`;
}

function ktorCache(): string {
  return `import io.lettuce.core.RedisClient
import io.lettuce.core.api.StatefulRedisConnection
import org.slf4j.LoggerFactory

/** Key/value cache for cache-aside reads. Tests inject an in-memory fake (TestSupport.kt). */
interface Cache : AutoCloseable {
    fun get(key: String): String?
    fun set(key: String, value: String, ttlSeconds: Long = 60)
    fun delete(key: String)
    fun ping(): Boolean
}

/** Redis at REDIS_URL (Dragonfly too; Upstash via rediss://). Connects on first use. */
class RedisCache(url: String = System.getenv("REDIS_URL") ?: "redis://localhost:6379") : Cache {
    private val client = RedisClient.create(url)
    private val connection: StatefulRedisConnection<String, String> by lazy { client.connect() }
    private val log = LoggerFactory.getLogger(RedisCache::class.java)

    // The cache is an optimisation: when Redis is down, reads fall through to the database.
    private fun <T> safely(op: String, block: () -> T): T? =
        try { block() } catch (e: Exception) { log.warn("redis {} failed: {}", op, e.message); null }

    override fun get(key: String): String? = safely("GET") { connection.sync().get(key) }
    override fun set(key: String, value: String, ttlSeconds: Long) { safely("SETEX") { connection.sync().setex(key, ttlSeconds, value) } }
    override fun delete(key: String) { safely("DEL") { connection.sync().del(key) } }
    override fun ping(): Boolean = safely("PING") { connection.sync().ping() } == "PONG"
    override fun close() = client.shutdown()
}
`;
}

function ktorQueueImpl(i: KtInfra): { imports: string[]; body: string; ctor: string } {
  switch (i.queue!) {
    case "kafka":
      return {
        ctor: "KafkaQueue()",
        imports: [
          "org.apache.kafka.clients.admin.AdminClient", "org.apache.kafka.clients.admin.AdminClientConfig", "org.apache.kafka.clients.admin.NewTopic",
          "org.apache.kafka.clients.consumer.ConsumerConfig", "org.apache.kafka.clients.consumer.KafkaConsumer",
          "org.apache.kafka.clients.producer.KafkaProducer", "org.apache.kafka.clients.producer.ProducerConfig", "org.apache.kafka.clients.producer.ProducerRecord",
          "org.apache.kafka.common.serialization.StringDeserializer", "org.apache.kafka.common.serialization.StringSerializer",
          "java.time.Duration", "java.util.concurrent.TimeUnit",
        ],
        body: `/** Kafka / Redpanda at KAFKA_BROKERS. Clients connect on first use. */
class KafkaQueue(private val brokers: String = System.getenv("KAFKA_BROKERS") ?: "localhost:9092") : JobQueue {
    private val log = LoggerFactory.getLogger(KafkaQueue::class.java)
    private val admin = mapOf<String, Any>(
        AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG to brokers,
        AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG to 2_000,
        AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG to 2_000,
    )
    // Brokers may not auto-create topics (Redpanda doesn't by default); "already exists" is fine.
    private val topic by lazy {
        runCatching { AdminClient.create(admin).use { it.createTopics(listOf(NewTopic(JOBS, 1, 1.toShort()))).all().get(5, TimeUnit.SECONDS) } }
        JOBS
    }
    private val producerLazy = lazy {
        KafkaProducer<String, String>(mapOf<String, Any>(
            ProducerConfig.BOOTSTRAP_SERVERS_CONFIG to brokers,
            ProducerConfig.MAX_BLOCK_MS_CONFIG to 5_000,
            ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG to StringSerializer::class.java,
            ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG to StringSerializer::class.java,
        ))
    }
    private val producer by producerLazy

    override fun publish(message: String) {
        producer.send(ProducerRecord(topic, message)) { _, e -> if (e != null) log.warn("publish failed: {}", e.message) }
    }

    override suspend fun consume(handle: (String) -> Unit) {
        withContext(Dispatchers.IO) {
            KafkaConsumer<String, String>(mapOf<String, Any>(
                ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG to brokers,
                ConsumerConfig.GROUP_ID_CONFIG to "workers",
                ConsumerConfig.AUTO_OFFSET_RESET_CONFIG to "earliest",
                ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
                ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG to StringDeserializer::class.java,
            )).use { consumer ->
                consumer.subscribe(listOf(topic))
                while (isActive) for (record in consumer.poll(Duration.ofSeconds(1))) handle(record.value())
            }
        }
    }

    override fun ping(): Boolean =
        runCatching { AdminClient.create(admin).use { it.describeCluster().nodes().get(2, TimeUnit.SECONDS) } }.isSuccess

    override fun close() { if (producerLazy.isInitialized()) producer.close() }
}`,
      };
    case "rabbitmq":
      return {
        ctor: "RabbitQueue()",
        imports: ["com.rabbitmq.client.CancelCallback", "com.rabbitmq.client.Channel", "com.rabbitmq.client.ConnectionFactory", "com.rabbitmq.client.DeliverCallback", "com.rabbitmq.client.MessageProperties"],
        body: `/** RabbitMQ at RABBITMQ_URL: durable queue "jobs", persistent messages, manual acks. Connects on first use. */
class RabbitQueue(url: String = System.getenv("RABBITMQ_URL") ?: "amqp://guest:guest@localhost:5672") : JobQueue {
    private val factory = ConnectionFactory().apply { setUri(url) } // automatic recovery is on by default
    private val connectionLazy = lazy { factory.newConnection() }
    private val connection by connectionLazy
    private val publishChannel by lazy { connection.createChannel().also(::declare) }

    private fun declare(ch: Channel) { ch.queueDeclare(JOBS, true, false, false, null) }

    override fun publish(message: String) = synchronized(this) { // channels are not thread-safe
        publishChannel.basicPublish("", JOBS, MessageProperties.PERSISTENT_TEXT_PLAIN, message.toByteArray())
    }

    override suspend fun consume(handle: (String) -> Unit) {
        val ch = withContext(Dispatchers.IO) { connection.createChannel().also(::declare) }
        try {
            ch.basicConsume(JOBS, false, DeliverCallback { _, d ->
                try {
                    handle(String(d.body))
                    ch.basicAck(d.envelope.deliveryTag, false)
                } catch (e: Exception) {
                    ch.basicNack(d.envelope.deliveryTag, false, false) // ponytail: dropped; add a dead-letter policy to keep them
                }
            }, CancelCallback { })
            awaitCancellation()
        } finally {
            runCatching { ch.close() }
        }
    }

    override fun ping(): Boolean = runCatching { connection.isOpen }.getOrDefault(false)

    override fun close() { if (connectionLazy.isInitialized()) connection.close() }
}`,
      };
    case "nats":
      return {
        ctor: "NatsQueue()",
        imports: ["io.nats.client.Connection", "io.nats.client.Nats"],
        body: `/**
 * NATS at NATS_URL: core pub/sub on subject "jobs" with queue group "workers", so the
 * API and Worker share the load. ponytail: at-most-once; switch to JetStream for durability.
 */
class NatsQueue(private val url: String = System.getenv("NATS_URL") ?: "nats://localhost:4222") : JobQueue {
    private val connectionLazy = lazy { Nats.connect(url) }
    private val nc by connectionLazy

    override fun publish(message: String) = nc.publish(JOBS, message.toByteArray())

    override suspend fun consume(handle: (String) -> Unit) {
        val dispatcher = withContext(Dispatchers.IO) { nc.createDispatcher { msg -> handle(String(msg.data)) } }
        try {
            dispatcher.subscribe(JOBS, "workers")
            awaitCancellation()
        } finally {
            runCatching { nc.closeDispatcher(dispatcher) }
        }
    }

    override fun ping(): Boolean = runCatching { nc.status == Connection.Status.CONNECTED }.getOrDefault(false)

    override fun close() { if (connectionLazy.isInitialized()) nc.close() }
}`,
      };
    case "sqs":
      return {
        ctor: "SqsQueue()",
        imports: ["software.amazon.awssdk.regions.Region", "software.amazon.awssdk.services.sqs.SqsClient", "software.amazon.awssdk.services.sqs.model.QueueDoesNotExistException", "java.net.URI"],
        body: `/** SQS queue "jobs". AWS_ENDPOINT_URL_SQS points at ElasticMQ locally; unset it in AWS. */
class SqsQueue : JobQueue {
    private val clientLazy = lazy {
        SqsClient.builder()
            .region(Region.of(System.getenv("AWS_REGION") ?: "${i.region}"))
            .apply { System.getenv("AWS_ENDPOINT_URL_SQS")?.takeIf { it.isNotBlank() }?.let { endpointOverride(URI(it)) } }
            .build()
    }
    private val sqs by clientLazy
    // Created when missing (local ElasticMQ); in AWS provision it with your IaC instead.
    private val queueUrl by lazy {
        try {
            sqs.getQueueUrl { it.queueName(JOBS) }.queueUrl()
        } catch (e: QueueDoesNotExistException) {
            sqs.createQueue { it.queueName(JOBS) }.queueUrl()
        }
    }

    override fun publish(message: String) {
        sqs.sendMessage { it.queueUrl(queueUrl).messageBody(message) }
    }

    override suspend fun consume(handle: (String) -> Unit) {
        withContext(Dispatchers.IO) {
            while (isActive) {
                val batch = sqs.receiveMessage { it.queueUrl(queueUrl).maxNumberOfMessages(10).waitTimeSeconds(10) }.messages()
                for (m in batch) {
                    handle(m.body())
                    sqs.deleteMessage { it.queueUrl(queueUrl).receiptHandle(m.receiptHandle()) }
                }
            }
        }
    }

    override fun ping(): Boolean = runCatching { sqs.getQueueUrl { it.queueName(JOBS) } }.isSuccess

    override fun close() { if (clientLazy.isInitialized()) sqs.close() }
}`,
      };
    case "bullmq":
      return {
        ctor: "RedisListQueue()",
        imports: ["io.lettuce.core.RedisClient"],
        body: `/**
 * BullMQ is a Node.js library with no JVM client, so this is a plain Redis list
 * ("jobs": LPUSH / BRPOP) at REDIS_URL. It is NOT wire-compatible with BullMQ workers.
 */
class RedisListQueue(url: String = System.getenv("REDIS_URL") ?: "redis://localhost:6379") : JobQueue {
    private val client = RedisClient.create(url)
    private val connection by lazy { client.connect() }

    override fun publish(message: String) { connection.sync().lpush(JOBS, message) }

    override suspend fun consume(handle: (String) -> Unit) {
        withContext(Dispatchers.IO) {
            client.connect().use { c -> while (isActive) c.sync().brpop(5, JOBS)?.let { handle(it.value) } }
        }
    }

    override fun ping(): Boolean = runCatching { connection.sync().ping() == "PONG" }.getOrDefault(false)

    override fun close() = client.shutdown()
}`,
      };
  }
}

function ktorQueue(i: KtInfra): string {
  const impl = ktorQueueImpl(i);
  return `${imports(["kotlinx.coroutines.*", "org.slf4j.LoggerFactory", ...impl.imports])}

/** Topic / queue / subject name. */
const val JOBS = "jobs"

/** Message queue seen by the app. Tests inject an in-memory fake (TestSupport.kt). */
interface JobQueue : AutoCloseable {
    fun publish(message: String)
    /** Hands each message to [handle] until the calling coroutine is cancelled. */
    suspend fun consume(handle: (String) -> Unit)
    fun ping(): Boolean
}

fun connectQueue(): JobQueue = ${impl.ctor}

/** Replace with real work. Runs in the API process (module()) and in Worker.kt. */
fun handleJob(message: String) {
    LoggerFactory.getLogger("jobs").info("consumed topic={} body={}", JOBS, message.take(200))
}

/** Keeps a consumer running; after a broker error it reconnects every 5s. */
fun CoroutineScope.launchConsumer(queue: JobQueue): Job = launch(Dispatchers.IO) {
    val log = LoggerFactory.getLogger("jobs")
    while (isActive) {
        try {
            queue.consume(::handleJob)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("consumer stopped: {} (retrying in 5s)", e.message)
        }
        delay(5_000)
    }
}

${impl.body}
`;
}

function ktorWorker(): string {
  return `import kotlinx.coroutines.runBlocking

/** Standalone consumer: \`./gradlew worker\`, or \`java -cp app.jar Worker\` from the fat jar. */
object Worker {
    @JvmStatic
    fun main(args: Array<String>) = runBlocking {
        val queue = connectQueue()
        Runtime.getRuntime().addShutdownHook(Thread { queue.close() })
        launchConsumer(queue).join()
    }
}
`;
}

/** Fakes appended to TestSupport.kt; testModule() passes them to module(). */
export function ktorTestFakes(i: KtInfra): { imports: string; body: string; args: string[] } {
  const imp: string[] = [];
  const body: string[] = [];
  if (i.redis) {
    imp.push("java.util.concurrent.ConcurrentHashMap");
    body.push(`/** In-memory cache: lets tests observe cache-aside without Redis. */
object TestCache : Cache {
    private val entries = ConcurrentHashMap<String, String>()
    override fun get(key: String): String? = entries[key]
    override fun set(key: String, value: String, ttlSeconds: Long) { entries[key] = value }
    override fun delete(key: String) { entries.remove(key) }
    override fun ping() = true
    override fun close() {}
}`);
  }
  if (i.queue) {
    imp.push("java.util.concurrent.CopyOnWriteArrayList", "kotlinx.coroutines.channels.Channel");
    body.push(`/** In-memory queue: records what the app publishes and feeds the in-process consumer. */
object TestQueue : JobQueue {
    val published = CopyOnWriteArrayList<String>()
    private val channel = Channel<String>(Channel.UNLIMITED)
    override fun publish(message: String) { published += message; channel.trySend(message) }
    override suspend fun consume(handle: (String) -> Unit) { for (m in channel) handle(m) }
    override fun ping() = true
    override fun close() {}
}`);
  }
  return {
    imports: imp.map((x) => `import ${x}\n`).join(""),
    body: body.length ? "\n" + body.join("\n\n") + "\n" : "",
    args: [i.redis && "cache = TestCache", i.queue && "queue = TestQueue"].filter(Boolean) as string[],
  };
}

// ─── Spring (spring-kt) ───────────────────────────────────────────────────────

export function springKtInfraDeps(i: KtInfra, hasActuator: boolean): string {
  const d: string[] = [];
  if ((i.tracing || i.datadog) && !hasActuator) d.push(`    implementation("org.springframework.boot:spring-boot-starter-actuator")`);
  if (i.tracing) d.push(
    "    // Micrometer Tracing → OpenTelemetry; spans export via OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set.",
    `    implementation("io.micrometer:micrometer-tracing-bridge-otel")`,
    `    implementation("io.opentelemetry:opentelemetry-exporter-otlp")`,
  );
  if (i.rateLimit) d.push(`    implementation("com.bucket4j:bucket4j-core:8.10.1")`);
  if (i.sentry) d.push(`    implementation("io.sentry:sentry-spring-boot-starter-jakarta:7.14.0")`);
  if (i.datadog) d.push(`    implementation("io.micrometer:micrometer-registry-datadog")`);
  if (i.redis || i.queue === "bullmq") d.push(`    implementation("org.springframework.boot:spring-boot-starter-data-redis")`);
  if (i.redis) d.push(`    implementation("org.springframework.boot:spring-boot-starter-cache")`);
  const q: Record<KtQueue, string> = {
    kafka: "org.springframework.kafka:spring-kafka",
    rabbitmq: "org.springframework.boot:spring-boot-starter-amqp",
    nats: "io.nats:jnats:2.20.2",
    sqs: "io.awspring.cloud:spring-cloud-aws-starter-sqs:3.2.0",
    bullmq: "",
  };
  if (i.queue && q[i.queue]) d.push(`    implementation("${q[i.queue]}")`);
  return d.length ? d.join("\n") + "\n" : "";
}

export function springKtInfraProps(i: KtInfra): string {
  const p: string[] = [];
  if (i.tracing) p.push("# Tracing: every request is sampled; TracingConfig exports when OTEL_EXPORTER_OTLP_ENDPOINT is set.", "management.tracing.sampling.probability=1.0");
  if (i.rateLimit) p.push("# Per-client-IP limit enforced by RateLimitFilter.", "rate-limit.requests-per-minute=60");
  if (i.sentry) p.push("# Empty DSN disables the SDK.", "sentry.dsn=${SENTRY_DSN:}");
  if (i.datadog) p.push("management.datadog.metrics.export.api-key=${DD_API_KEY:}");
  if (i.redis || i.queue === "bullmq") p.push("spring.data.redis.url=${REDIS_URL:redis://localhost:6379}");
  if (i.redis) p.push("spring.cache.type=redis", "spring.cache.redis.time-to-live=60s");
  if (i.queue === "kafka") p.push("spring.kafka.bootstrap-servers=${KAFKA_BROKERS:localhost:9092}", "spring.kafka.consumer.auto-offset-reset=earliest");
  if (i.queue === "rabbitmq") p.push("spring.rabbitmq.addresses=${RABBITMQ_URL:amqp://guest:guest@localhost:5672}");
  if (i.queue === "nats") p.push("nats.url=${NATS_URL:nats://localhost:4222}");
  if (i.queue === "sqs") p.push(
    `spring.cloud.aws.region.static=\${AWS_REGION:${i.region}}`,
    "# ElasticMQ locally; the regional AWS endpoint when AWS_ENDPOINT_URL_SQS is unset.",
    `spring.cloud.aws.sqs.endpoint=\${AWS_ENDPOINT_URL_SQS:https://sqs.\${AWS_REGION:${i.region}}.amazonaws.com}`,
  );
  return p.length ? "\n" + p.join("\n") + "\n" : "";
}

/** Test profile: no broker / Redis connections, in-memory cache, limits out of the way. */
export function springKtInfraTestProps(i: KtInfra): string {
  const p: string[] = [];
  if (i.redis || i.queue === "bullmq") p.push("spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration");
  if (i.redis) p.push("spring.cache.type=simple");
  if (i.queue === "sqs") p.push("spring.cloud.aws.sqs.enabled=false");
  if (i.datadog) p.push("management.datadog.metrics.export.enabled=false");
  if (i.rateLimit) p.push("rate-limit.requests-per-minute=100000");
  return p.length ? p.join("\n") + "\n" : "";
}

export function springKtInfraFiles(i: KtInfra, pkg: string, dir: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const obs = springKtObservability(i, pkg);
  if (obs) files.push({ path: `${dir}/Observability.kt`, content: obs });
  if (i.redis) files.push({ path: `${dir}/CacheConfig.kt`, content: `package ${pkg}

import org.springframework.cache.annotation.EnableCaching
import org.springframework.context.annotation.Configuration

/** Redis-backed @Cacheable (see the *Repository interfaces); in-memory in the test profile. */
@Configuration
@EnableCaching
class CacheConfig
` });
  if (i.queue) files.push({ path: `${dir}/Queue.kt`, content: springKtQueue(i, pkg) });
  files.push({ path: `${dir}/HealthController.kt`, content: springKtHealth(i, pkg) });
  return files;
}

function springKtObservability(i: KtInfra, pkg: string): string {
  const imp: string[] = [];
  const parts: string[] = [];
  if (i.tracing) {
    imp.push("io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter", "io.opentelemetry.sdk.trace.export.SpanExporter",
      "org.springframework.beans.factory.annotation.Value", "org.springframework.boot.autoconfigure.condition.ConditionalOnExpression",
      "org.springframework.context.annotation.Bean", "org.springframework.context.annotation.Configuration");
    parts.push(`/** OTLP/HTTP span exporter, only when OTEL_EXPORTER_OTLP_ENDPOINT is set (otherwise spans stay local). */
@Configuration
@ConditionalOnExpression("'\\\${OTEL_EXPORTER_OTLP_ENDPOINT:}' != ''")
class TracingConfig {
    @Bean
    fun otlpSpanExporter(@Value("\\\${OTEL_EXPORTER_OTLP_ENDPOINT}") endpoint: String): SpanExporter =
        OtlpHttpSpanExporter.builder().setEndpoint(endpoint.trimEnd('/') + "/v1/traces").build()
}`);
  }
  if (i.rateLimit || i.audit) {
    imp.push("jakarta.servlet.FilterChain", "jakarta.servlet.http.HttpServletRequest", "jakarta.servlet.http.HttpServletResponse",
      "org.springframework.stereotype.Component", "org.springframework.web.filter.OncePerRequestFilter");
  }
  if (i.rateLimit) {
    imp.push("io.github.bucket4j.Bucket", "java.time.Duration", "java.util.concurrent.ConcurrentHashMap",
      "org.springframework.beans.factory.annotation.Value", "org.springframework.core.Ordered", "org.springframework.core.annotation.Order");
    parts.push(`/** Token bucket per client IP (rate-limit.requests-per-minute); 429 when empty. Runs before security. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
class RateLimitFilter(@Value("\\\${rate-limit.requests-per-minute:60}") private val perMinute: Long) : OncePerRequestFilter() {
    // ponytail: in-memory, per replica, one bucket per IP forever. Use bucket4j-redis for shared, expiring buckets.
    private val buckets = ConcurrentHashMap<String, Bucket>()

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        val bucket = buckets.computeIfAbsent(request.remoteAddr) {
            Bucket.builder().addLimit { it.capacity(perMinute).refillGreedy(perMinute, Duration.ofMinutes(1)) }.build()
        }
        if (bucket.tryConsume(1)) {
            chain.doFilter(request, response)
        } else {
            response.status = 429
            response.setHeader("Retry-After", "60")
        }
    }
}`);
  }
  if (i.audit) {
    imp.push("org.slf4j.LoggerFactory");
    parts.push(`/** One "audit" log line per mutating request. Runs after Spring Security, so the principal is known. */
@Component
class AuditFilter : OncePerRequestFilter() {
    private val log = LoggerFactory.getLogger("audit")
    private val mutating = setOf("POST", "PUT", "PATCH", "DELETE")

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        try {
            chain.doFilter(request, response)
        } finally {
            if (request.method in mutating) {
                log.info(
                    "audit method={} path={} status={} subject={} ip={}",
                    request.method, request.requestURI, response.status, request.userPrincipal?.name, request.remoteAddr,
                )
            }
        }
    }
}`);
  }
  if (parts.length === 0) return "";
  return `package ${pkg}\n\n${imports(imp)}\n\n${parts.join("\n\n")}\n`;
}

function springKtQueueImpl(i: KtInfra): { imports: string[]; body: string } {
  const common = ["org.springframework.context.annotation.Profile", "org.springframework.stereotype.Component"];
  switch (i.queue!) {
    case "kafka":
      return {
        imports: [...common, "org.apache.kafka.clients.admin.AdminClient", "org.apache.kafka.clients.admin.AdminClientConfig", "org.apache.kafka.clients.admin.NewTopic",
          "org.springframework.context.annotation.Bean", "org.springframework.kafka.annotation.KafkaListener", "org.springframework.kafka.config.TopicBuilder",
          "org.springframework.kafka.core.KafkaAdmin", "org.springframework.kafka.core.KafkaTemplate", "java.util.concurrent.TimeUnit"],
        body: `/** Kafka / Redpanda (spring.kafka.bootstrap-servers ← KAFKA_BROKERS). */
@Component
@Profile("!test")
class KafkaJobs(private val kafka: KafkaTemplate<String, String>, private val admin: KafkaAdmin) : JobPublisher {
    /** KafkaAdmin creates the topic at startup (brokers may not auto-create). */
    @Bean
    fun jobsTopic(): NewTopic = TopicBuilder.name(JOBS).partitions(1).replicas(1).build()

    override fun publish(message: String) { kafka.send(JOBS, message) }

    @KafkaListener(topics = [JOBS], groupId = "workers")
    fun consume(message: String) = handleJob(message)

    override fun ping(): Boolean = runCatching {
        val props = admin.configurationProperties + mapOf(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG to 2_000, AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG to 2_000)
        AdminClient.create(props).use { it.describeCluster().nodes().get(2, TimeUnit.SECONDS) }
    }.isSuccess
}`,
      };
    case "rabbitmq":
      return {
        imports: [...common, "org.springframework.amqp.core.Queue", "org.springframework.amqp.rabbit.annotation.RabbitListener",
          "org.springframework.amqp.rabbit.core.RabbitTemplate", "org.springframework.context.annotation.Bean"],
        body: `/** RabbitMQ (spring.rabbitmq.addresses ← RABBITMQ_URL): durable queue "jobs". */
@Component
@Profile("!test")
class RabbitJobs(private val rabbit: RabbitTemplate) : JobPublisher {
    @Bean
    fun jobsQueue() = Queue(JOBS, true)

    override fun publish(message: String) = rabbit.convertAndSend(JOBS, message) // default exchange → queue "jobs"

    @RabbitListener(queues = [JOBS])
    fun consume(message: String) = handleJob(message)

    override fun ping(): Boolean = runCatching { rabbit.execute { it.isOpen } == true }.getOrDefault(false)
}`,
      };
    case "nats":
      return {
        imports: [...common, "io.nats.client.Connection", "io.nats.client.Nats", "org.springframework.beans.factory.DisposableBean", "org.springframework.beans.factory.annotation.Value"],
        body: `/**
 * NATS (nats.url ← NATS_URL): subject "jobs", queue group "workers" so replicas share the load.
 * ponytail: core NATS is at-most-once; switch to JetStream for durability.
 */
@Component
@Profile("!test")
class NatsJobs(@Value("\\\${nats.url}") url: String) : JobPublisher, DisposableBean {
    private val nc: Connection = Nats.connect(url)

    init {
        nc.createDispatcher { handleJob(String(it.data)) }.subscribe(JOBS, "workers")
    }

    override fun publish(message: String) = nc.publish(JOBS, message.toByteArray())

    override fun ping(): Boolean = nc.status == Connection.Status.CONNECTED

    override fun destroy() = nc.close()
}`,
      };
    case "sqs":
      return {
        imports: [...common, "io.awspring.cloud.sqs.annotation.SqsListener", "io.awspring.cloud.sqs.operations.SqsTemplate",
          "software.amazon.awssdk.services.sqs.SqsAsyncClient", "java.util.concurrent.TimeUnit"],
        body: `/** SQS queue "jobs" (created on first use; AWS_ENDPOINT_URL_SQS → ElasticMQ locally). */
@Component
@Profile("!test")
class SqsJobs(private val sqs: SqsTemplate, private val client: SqsAsyncClient) : JobPublisher {
    override fun publish(message: String) { sqs.send(JOBS, message) }

    @SqsListener(JOBS)
    fun consume(message: String) = handleJob(message)

    override fun ping(): Boolean = runCatching { client.getQueueUrl { it.queueName(JOBS) }.get(2, TimeUnit.SECONDS) }.isSuccess
}`,
      };
    case "bullmq":
      return {
        imports: [...common, "org.slf4j.LoggerFactory", "org.springframework.boot.context.event.ApplicationReadyEvent",
          "org.springframework.context.event.EventListener", "org.springframework.data.redis.core.StringRedisTemplate",
          "jakarta.annotation.PreDestroy", "java.time.Duration"],
        body: `/**
 * BullMQ is a Node.js library with no JVM client, so this is a plain Redis list
 * ("jobs": LPUSH / BRPOP) at REDIS_URL. It is NOT wire-compatible with BullMQ workers.
 */
@Component
@Profile("!test")
class RedisListJobs(private val redis: StringRedisTemplate) : JobPublisher {
    private val log = LoggerFactory.getLogger(RedisListJobs::class.java)
    private val consumer = Thread {
        while (!Thread.currentThread().isInterrupted) {
            try {
                redis.opsForList().rightPop(JOBS, Duration.ofSeconds(5))?.let(::handleJob)
            } catch (e: Exception) {
                if (Thread.currentThread().isInterrupted) break
                log.warn("consumer error: {} (retrying in 5s)", e.message)
                try { Thread.sleep(5_000) } catch (_: InterruptedException) { break }
            }
        }
    }.apply { isDaemon = true; name = "jobs-consumer" }

    @EventListener(ApplicationReadyEvent::class)
    fun start() = consumer.start()

    @PreDestroy
    fun stop() = consumer.interrupt()

    override fun publish(message: String) { redis.opsForList().leftPush(JOBS, message) }

    override fun ping(): Boolean = runCatching { redis.connectionFactory!!.connection.use { it.ping() == "PONG" } }.getOrDefault(false)
}`,
      };
  }
}

function springKtQueue(i: KtInfra, pkg: string): string {
  const impl = springKtQueueImpl(i);
  return `package ${pkg}

${imports(impl.imports.concat(["org.slf4j.LoggerFactory"]))}

/** Topic / queue / subject name. */
const val JOBS = "jobs"

/** What controllers publish to. The test profile swaps in an in-memory fake (src/test). */
interface JobPublisher {
    fun publish(message: String)
    fun ping(): Boolean
}

/** Replace with real work. */
fun handleJob(message: String) {
    LoggerFactory.getLogger("jobs").info("consumed topic={} body={}", JOBS, message.take(200))
}

${impl.body}
`;
}

function springKtHealth(i: KtInfra, pkg: string): string {
  const deps = [
    "private val dataSource: DataSource",
    i.redis && "private val redis: RedisConnectionFactory?, // null in the test profile (Redis auto-config excluded)",
    i.queue && "private val jobs: JobPublisher",
  ].filter(Boolean).map((d) => `    ${d}`).join(",\n");
  const imp = ["javax.sql.DataSource", "org.springframework.http.ResponseEntity", "org.springframework.web.bind.annotation.GetMapping",
    "org.springframework.web.bind.annotation.RequestParam", "org.springframework.web.bind.annotation.RestController"];
  if (i.redis) imp.push("org.springframework.data.redis.connection.RedisConnectionFactory");
  const checks = [
    `"db" to check { dataSource.connection.use { it.isValid(2) } }`,
    i.queue && `"queue" to jobs.ping()`,
  ].filter(Boolean).join(", ");
  return `package ${pkg}

${imports(imp)}

/** /health is liveness; /health?ready=1 is readiness and checks every dependency (503 if one is down). */
@RestController
class HealthController(
${deps},
) {
    @GetMapping("/health")
    fun health(@RequestParam(required = false) ready: String?): ResponseEntity<Map<String, Boolean>> {
        if (ready == null) return ResponseEntity.ok(mapOf("ok" to true))
        val checks = mutableMapOf(${checks})${i.redis ? `
        redis?.let { r -> checks["cache"] = check { r.connection.use { it.ping() == "PONG" } } }` : ""}
        val ok = checks.values.all { it }
        return ResponseEntity.status(if (ok) 200 else 503).body(checks + ("ok" to ok))
    }

    private fun check(block: () -> Boolean) = runCatching(block).getOrDefault(false)
}
`;
}

/** Test-source files: in-memory publisher + liveness/readiness test. */
export function springKtInfraTestFiles(i: KtInfra, pkg: string, dir: string, withAuth: boolean): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  if (i.queue) files.push({ path: `${dir}/InMemoryJobPublisher.kt`, content: `package ${pkg}

import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.util.concurrent.CopyOnWriteArrayList

/** Stands in for the broker in the test profile: records messages and runs the handler inline. */
@Component
@Profile("test")
class InMemoryJobPublisher : JobPublisher {
    val published = CopyOnWriteArrayList<String>()
    override fun publish(message: String) { published += message; handleJob(message) }
    override fun ping() = true
}
` });
  files.push({ path: `${dir}/HealthTest.kt`, content: `package ${pkg}

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
${withAuth ? "import org.springframework.boot.test.mock.mockito.MockBean\nimport org.springframework.security.oauth2.jwt.JwtDecoder\n" : ""}import org.springframework.test.context.ActiveProfiles
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** Kubernetes probes hit these: liveness must not touch dependencies, readiness must check them. */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class HealthTest {
    @Autowired
    lateinit var mvc: MockMvc
${withAuth ? `
    @MockBean
    lateinit var jwtDecoder: JwtDecoder
` : ""}
    @Test
    fun \`liveness is public and ok\`() {
        mvc.perform(get("/health")).andExpect(status().isOk).andExpect(jsonPath("\\$.ok").value(true))
    }

    @Test
    fun \`readiness reports each dependency\`() {
        mvc.perform(get("/health").param("ready", "1"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("\\$.db").value(true))${i.queue ? `
            .andExpect(jsonPath("\\$.queue").value(true))` : ""}
    }
}
` });
  return files;
}

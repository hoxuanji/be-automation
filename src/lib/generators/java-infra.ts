// Cross-cutting infrastructure for generated Java repos (Spring Boot + Quarkus):
// tracing, rate limiting, audit logging, Sentry / Datadog, Redis cache and the
// selected message queue. java.ts owns the app skeleton; this file owns the
// dependencies, properties and classes each toggle adds on top of it.
//
// Every broker/cache/exporter is switched off (or swapped for an in-memory
// stand-in) in the test profile so `mvn test` runs with no external services.
import type { GeneratedFile, StackConfig } from "./types";

const PKG = "dev.helios.app";
const SRC = "src/main/java/dev/helios/app";

export type JavaQueue = "kafka" | "rabbitmq" | "nats" | "sqs" | "redis" | null;

/** Which transport the generated publisher/consumer pair speaks. */
export function javaQueue(queue: string): JavaQueue {
  if (queue === "kafka" || queue === "redpanda") return "kafka";
  if (queue === "rabbitmq" || queue === "nats" || queue === "sqs") return queue;
  // BullMQ is a Node library; the JVM side gets plain Redis pub/sub instead (see publisher javadoc).
  if (queue === "bullmq") return "redis";
  return null;
}

export const javaRedisCache = (cache: string) => cache === "redis" || cache === "upstash" || cache === "dragonfly";

export type JavaInfra = {
  /** <dependency> blocks for pom.xml. */
  deps: string;
  /** Extra imported BOMs for <dependencyManagement> (Quarkus only). */
  boms: string;
  /** Lines appended to src/main/resources/application.properties. */
  props: string;
  /** Test-profile overrides (Spring: application-test.properties; Quarkus: %test.* lines already in props). */
  testProps: string;
  files: GeneratedFile[];
  /** Entity reads go through Redis. */
  cache: boolean;
  /** A NotificationPublisher bean exists. */
  publisher: boolean;
};

function dep(groupId: string, artifactId: string, version?: string, scope?: string): string {
  return `    <dependency>
      <groupId>${groupId}</groupId>
      <artifactId>${artifactId}</artifactId>${version ? `\n      <version>${version}</version>` : ""}${scope ? `\n      <scope>${scope}</scope>` : ""}
    </dependency>
`;
}

const BUCKET4J = () => dep("com.bucket4j", "bucket4j_jdk17-core", "8.14.0");
const JNATS = () => dep("io.nats", "jnats", "2.20.5");

// ponytail: same per-instance bucket as the Go generator (GO_IP_LIMITER): N replicas
// give a client N x the budget. Move to bucket4j-redis when one global limit matters.
const RATE_LIMIT_CONSTANTS = `    // ponytail: per-instance, in-memory token bucket keyed by client IP. With N
    // replicas a client effectively gets N x the budget and state resets on
    // restart — switch to bucket4j's Redis/JCache backends for one global limit.
    private static final int RATE_LIMIT_RPS = 10;   // sustained requests per second per client IP
    private static final int RATE_LIMIT_BURST = 20; // short bursts allowed above the sustained rate
    // ponytail: the table is dropped wholesale when full; an LRU would keep hot clients.
    private static final int MAX_TRACKED_IPS = 100_000;

    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

    private boolean allow(String ip) {
        if (buckets.size() >= MAX_TRACKED_IPS) buckets.clear();
        return buckets.computeIfAbsent(ip, k -> Bucket.builder()
            .addLimit(limit -> limit.capacity(RATE_LIMIT_BURST).refillGreedy(RATE_LIMIT_RPS, Duration.ofSeconds(1)))
            .build())
            .tryConsume(1);
    }`;

// ─── Spring Boot ──────────────────────────────────────────────────────────────

export function springInfra(config: StackConfig): JavaInfra {
  const queue = javaQueue(config.queue);
  const cache = javaRedisCache(config.cache);
  const redis = cache || queue === "redis";
  const deps: string[] = [];
  const props: string[] = [];
  const testProps: string[] = [];
  const files: GeneratedFile[] = [];

  if (config.tracing) {
    deps.push(dep("io.micrometer", "micrometer-tracing-bridge-otel"), dep("io.opentelemetry", "opentelemetry-exporter-otlp"));
    props.push(`# ─── Tracing ─────────────────────────────────────────────────────────────────
# Micrometer Tracing → OpenTelemetry → OTLP/HTTP. Spans carry spring.application.name.
management.tracing.sampling.probability=1.0
management.otlp.tracing.endpoint=\${OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4318}/v1/traces`);
    testProps.push("management.tracing.enabled=false");
  }

  if (config.monitoring === "sentry") {
    deps.push(dep("io.sentry", "sentry-spring-boot-starter-jakarta", "7.14.0"));
    props.push(`# ─── Sentry ──────────────────────────────────────────────────────────────────
# Unhandled exceptions and ERROR logs are reported. An empty DSN disables the SDK.
sentry.dsn=\${SENTRY_DSN:}
sentry.in-app-includes=${PKG}`);
  } else if (config.monitoring === "datadog") {
    deps.push(dep("io.micrometer", "micrometer-registry-datadog"));
    props.push(`# ─── Datadog ─────────────────────────────────────────────────────────────────
# Micrometer ships metrics straight to the Datadog API (no agent needed for metrics).
# For APM traces, turn on tracing and point OTEL_EXPORTER_OTLP_ENDPOINT at the
# Datadog Agent's OTLP receiver (http://<agent>:4318).
management.datadog.metrics.export.api-key=\${DD_API_KEY:}
management.datadog.metrics.export.step=30s`);
    testProps.push("management.datadog.metrics.export.enabled=false");
  }

  if (config.rateLimit) {
    deps.push(BUCKET4J());
    files.push({ path: `${SRC}/infra/RateLimitFilter.java`, content: springRateLimitFilter() });
  }
  if (config.audit) {
    files.push({ path: `${SRC}/infra/AuditFilter.java`, content: springAuditFilter() });
  }

  if (redis) {
    deps.push(dep("org.springframework.boot", "spring-boot-starter-data-redis"));
    props.push(`# ─── Redis ───────────────────────────────────────────────────────────────────
# redis:// or rediss:// (TLS, e.g. Upstash). Dragonfly speaks the same protocol.
spring.data.redis.url=\${REDIS_URL:redis://localhost:6379}`);
  }
  if (cache) {
    deps.push(dep("org.springframework.boot", "spring-boot-starter-cache"));
    props.push(`# Entity reads (get-by-id) are cached in Redis; writes evict. See CacheConfig.java.
spring.cache.type=redis
spring.cache.redis.time-to-live=60s`);
    testProps.push("spring.cache.type=simple");
    files.push({ path: `${SRC}/infra/CacheConfig.java`, content: springCacheConfig() });
  }

  if (queue) {
    props.push(`# ─── Queue ───────────────────────────────────────────────────────────────────
# NotificationConsumer only runs when this is true (the test profile turns it off).
queue.consumer.enabled=true`);
    testProps.push("queue.consumer.enabled=false");
    files.push(...springQueueFiles(queue));
  }
  switch (queue) {
    case "kafka":
      deps.push(dep("org.springframework.kafka", "spring-kafka"));
      props.push(`spring.kafka.bootstrap-servers=\${KAFKA_BROKERS:localhost:9092}
spring.kafka.consumer.auto-offset-reset=earliest`);
      // KafkaAdmin would otherwise try to create the topic against a broker that isn't there.
      testProps.push("spring.kafka.admin.auto-create=false");
      break;
    case "rabbitmq":
      deps.push(dep("org.springframework.boot", "spring-boot-starter-amqp"));
      props.push("spring.rabbitmq.addresses=${RABBITMQ_URL:amqp://guest:guest@localhost:5672}");
      break;
    case "nats":
      deps.push(JNATS());
      props.push("nats.url=${NATS_URL:nats://localhost:4222}");
      break;
    case "sqs":
      deps.push(dep("io.awspring.cloud", "spring-cloud-aws-starter-sqs", "3.2.1"));
      props.push(`spring.cloud.aws.region.static=\${AWS_REGION:us-east-1}
# Local ElasticMQ; leave AWS_ENDPOINT_URL_SQS unset in production to use real SQS.
spring.cloud.aws.sqs.endpoint=\${AWS_ENDPOINT_URL_SQS:}`);
      break;
  }

  return {
    deps: deps.join(""),
    boms: "",
    props: props.length ? `\n${props.join("\n\n")}\n` : "",
    testProps: testProps.length ? `\n# Brokers, Redis and exporters are not available in unit tests.\n${testProps.join("\n")}\n` : "",
    files,
    cache,
    publisher: queue !== null,
  };
}

function springRateLimitFilter(): string {
  return `package ${PKG}.infra;

import io.github.bucket4j.Bucket;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Per-client-IP token bucket (bucket4j). Runs before Spring Security so
 * unauthenticated floods are throttled too. Behind a load balancer set
 * server.forward-headers-strategy=native so getRemoteAddr() is the real client.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RateLimitFilter extends OncePerRequestFilter {

${RATE_LIMIT_CONSTANTS}

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (allow(request.getRemoteAddr())) {
            chain.doFilter(request, response);
            return;
        }
        response.setStatus(429);
        response.setHeader("Retry-After", "1");
        response.setContentType("application/json");
        response.getWriter().write("{\\"error\\":\\"rate_limited\\"}");
    }
}
`;
}

function springAuditFilter(): string {
  return `package ${PKG}.infra;

import static net.logstash.logback.argument.StructuredArguments.kv;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.Principal;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * One structured "audit" log line per mutating request (who, what, result).
 * Registered after Spring Security, so the authenticated principal is known.
 */
@Component
public class AuditFilter extends OncePerRequestFilter {

    private static final Logger AUDIT = LoggerFactory.getLogger("audit");
    private static final Set<String> MUTATING = Set.of("POST", "PUT", "PATCH", "DELETE");

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !MUTATING.contains(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long start = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            Principal user = request.getUserPrincipal();
            AUDIT.info("audit",
                kv("method", request.getMethod()),
                kv("path", request.getRequestURI()),
                kv("status", response.getStatus()),
                kv("ip", request.getRemoteAddr()),
                kv("user", user == null ? null : user.getName()),
                kv("duration_ms", (System.nanoTime() - start) / 1_000_000));
        }
    }
}
`;
}

function springCacheConfig(): string {
  return `package ${PKG}.infra;

import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Configuration;

/**
 * Turns on Spring's cache abstraction. Services mark get-by-id with @Cacheable
 * and update/delete with @CacheEvict; spring.cache.type=redis stores entries in
 * Redis (TTL: spring.cache.redis.time-to-live). Entities are Serializable for this.
 */
@Configuration
@EnableCaching
public class CacheConfig {}
`;
}

const CONSUMER_GATE = `@ConditionalOnProperty(name = "queue.consumer.enabled", havingValue = "true", matchIfMissing = true)`;

function springQueueFiles(queue: Exclude<JavaQueue, null>): GeneratedFile[] {
  const pub = (imports: string, doc: string, field: string, body: string, extra = "") => `package ${PKG}.messaging;

${imports}
import org.springframework.stereotype.Component;

/**
 * ${doc}
 */
@Component
public class NotificationPublisher {

    /** Topic / queue / subject shared with NotificationConsumer. */
    public static final String DESTINATION = "notifications";

    ${field}

    public void publish(String payload) {
        ${body}
    }
${extra}}
`;
  const consumer = (imports: string, annotation: string, extra = "") => `package ${PKG}.messaging;

${imports}
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Handles messages published by NotificationPublisher. Replace the log line with real work. */
@Component
${CONSUMER_GATE}
public class NotificationConsumer {

    private static final Logger log = LoggerFactory.getLogger(NotificationConsumer.class);
${extra}
${annotation ? `    ${annotation}\n` : ""}    public void onMessage(String payload) {
        log.info("notification received: {}", payload);
    }
}
`;
  const health = (name: string, imports: string, field: string, check: string) => ({
    path: `${SRC}/messaging/${name}HealthIndicator.java`,
    content: `package ${PKG}.messaging;

${imports}
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/** Broker check for /health?ready=1 and /actuator/health. */
@Component
public class ${name}HealthIndicator implements HealthIndicator {

    ${field}

    @Override
    public Health health() {
        try {
            ${check}
            return Health.up().build();
        } catch (Exception e) {
            return Health.down(e).build();
        }
    }
}
`,
  });

  switch (queue) {
    case "kafka":
      return [
        { path: `${SRC}/messaging/NotificationPublisher.java`, content: pub(
          "import org.springframework.kafka.core.KafkaTemplate;",
          "Publishes JSON payloads to the Kafka / Redpanda topic.",
          `private final KafkaTemplate<String, String> kafka;

    public NotificationPublisher(KafkaTemplate<String, String> kafka) {
        this.kafka = kafka;
    }`,
          "kafka.send(DESTINATION, payload);") },
        { path: `${SRC}/messaging/NotificationConsumer.java`, content: consumer(
          "import org.springframework.kafka.annotation.KafkaListener;",
          `@KafkaListener(topics = NotificationPublisher.DESTINATION, groupId = "\${spring.application.name}")`) },
        { path: `${SRC}/messaging/MessagingConfig.java`, content: `package ${PKG}.messaging;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/** KafkaAdmin creates the topic at startup (Redpanda does not auto-create topics). */
@Configuration
public class MessagingConfig {

    @Bean
    NewTopic notificationsTopic() {
        return TopicBuilder.name(NotificationPublisher.DESTINATION).partitions(1).replicas(1).build();
    }
}
` },
        health("Kafka", `import java.util.concurrent.TimeUnit;
import org.apache.kafka.clients.admin.AdminClient;
import org.springframework.kafka.core.KafkaAdmin;`,
          `private final KafkaAdmin admin;

    public KafkaHealthIndicator(KafkaAdmin admin) {
        this.admin = admin;
    }`,
          `try (AdminClient client = AdminClient.create(admin.getConfigurationProperties())) {
                client.describeCluster().nodes().get(3, TimeUnit.SECONDS);
            }`),
      ];
    case "rabbitmq":
      return [
        { path: `${SRC}/messaging/NotificationPublisher.java`, content: pub(
          "import org.springframework.amqp.rabbit.core.RabbitTemplate;",
          "Publishes JSON payloads to the durable RabbitMQ queue (default exchange, routing key = queue name).",
          `private final RabbitTemplate rabbit;

    public NotificationPublisher(RabbitTemplate rabbit) {
        this.rabbit = rabbit;
    }`,
          "rabbit.convertAndSend(DESTINATION, payload);") },
        { path: `${SRC}/messaging/NotificationConsumer.java`, content: consumer(
          "import org.springframework.amqp.rabbit.annotation.RabbitListener;",
          "@RabbitListener(queues = NotificationPublisher.DESTINATION)") },
        { path: `${SRC}/messaging/MessagingConfig.java`, content: `package ${PKG}.messaging;

import org.springframework.amqp.core.Queue;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** RabbitAdmin declares this queue on the first connection. RabbitHealthIndicator is auto-configured. */
@Configuration
public class MessagingConfig {

    @Bean
    Queue notificationsQueue() {
        return new Queue(NotificationPublisher.DESTINATION, true);
    }
}
` },
      ];
    case "nats":
      return [
        { path: `${SRC}/messaging/NatsConnection.java`, content: `package ${PKG}.messaging;

import io.nats.client.Connection;
import io.nats.client.Nats;
import io.nats.client.Options;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * One shared NATS connection, opened on first use so the app (and its tests)
 * start without a server. Doubles as the "nats" health indicator.
 */
@Component("nats")
public class NatsConnection implements HealthIndicator, DisposableBean {

    private final String url;
    private Connection connection;

    public NatsConnection(@Value("\${nats.url}") String url) {
        this.url = url;
    }

    public synchronized Connection get() {
        if (connection == null) {
            try {
                connection = Nats.connect(new Options.Builder().server(url).maxReconnects(-1).build());
            } catch (java.io.IOException e) {
                throw new IllegalStateException("cannot connect to NATS at " + url, e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted connecting to NATS", e);
            }
        }
        return connection;
    }

    @Override
    public Health health() {
        try {
            return get().getStatus() == Connection.Status.CONNECTED ? Health.up().build() : Health.down().build();
        } catch (IllegalStateException e) {
            return Health.down(e).build();
        }
    }

    @Override
    public synchronized void destroy() throws InterruptedException {
        if (connection != null) connection.close();
    }
}
` },
        { path: `${SRC}/messaging/NotificationPublisher.java`, content: pub(
          "import java.nio.charset.StandardCharsets;",
          "Publishes JSON payloads on a NATS subject.\n * ponytail: core NATS is at-most-once; use JetStream (connection.jetStream()) when messages must survive a restart.",
          `private final NatsConnection nats;

    public NotificationPublisher(NatsConnection nats) {
        this.nats = nats;
    }`,
          "nats.get().publish(DESTINATION, payload.getBytes(StandardCharsets.UTF_8));") },
        { path: `${SRC}/messaging/NotificationConsumer.java`, content: consumer(
          `import java.nio.charset.StandardCharsets;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;`,
          "",
          `
    private final NatsConnection nats;

    public NotificationConsumer(NatsConnection nats) {
        this.nats = nats;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void subscribe() {
        nats.get()
            .createDispatcher(msg -> onMessage(new String(msg.getData(), StandardCharsets.UTF_8)))
            .subscribe(NotificationPublisher.DESTINATION);
    }
`) },
      ];
    case "sqs":
      return [
        { path: `${SRC}/messaging/NotificationPublisher.java`, content: pub(
          "import io.awspring.cloud.sqs.operations.SqsTemplate;",
          "Sends JSON payloads to the SQS queue (created on first send if missing).",
          `private final SqsTemplate sqs;

    public NotificationPublisher(SqsTemplate sqs) {
        this.sqs = sqs;
    }`,
          "sqs.send(DESTINATION, payload);") },
        { path: `${SRC}/messaging/NotificationConsumer.java`, content: consumer(
          "import io.awspring.cloud.sqs.annotation.SqsListener;",
          "@SqsListener(NotificationPublisher.DESTINATION)") },
        health("Sqs", `import java.util.concurrent.TimeUnit;
import software.amazon.awssdk.services.sqs.SqsAsyncClient;`,
          `private final SqsAsyncClient sqs;

    public SqsHealthIndicator(SqsAsyncClient sqs) {
        this.sqs = sqs;
    }`,
          "sqs.listQueues().get(3, TimeUnit.SECONDS);"),
      ];
    case "redis":
      return [
        { path: `${SRC}/messaging/NotificationPublisher.java`, content: pub(
          "import org.springframework.data.redis.core.StringRedisTemplate;",
          `Publishes JSON payloads on a Redis pub/sub channel.
 *
 * BullMQ is a Node.js library with its own job format; there is no JVM client,
 * so this is plain Redis pub/sub on the same REDIS_URL. Node BullMQ workers will
 * NOT see these messages. ponytail: pub/sub is fire-and-forget — use Redis
 * Streams (opsForStream) when consumers must not miss messages.`,
          `private final StringRedisTemplate redis;

    public NotificationPublisher(StringRedisTemplate redis) {
        this.redis = redis;
    }`,
          "redis.convertAndSend(DESTINATION, payload);") },
        { path: `${SRC}/messaging/NotificationConsumer.java`, content: `package ${PKG}.messaging;

import java.nio.charset.StandardCharsets;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

/** Subscribes to the channel NotificationPublisher writes to. Replace the log line with real work. */
@Configuration
${CONSUMER_GATE}
public class NotificationConsumer {

    private static final Logger log = LoggerFactory.getLogger(NotificationConsumer.class);

    @Bean
    RedisMessageListenerContainer notificationListener(RedisConnectionFactory connections) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connections);
        container.addMessageListener(
            (message, pattern) -> onMessage(new String(message.getBody(), StandardCharsets.UTF_8)),
            new ChannelTopic(NotificationPublisher.DESTINATION));
        return container;
    }

    public void onMessage(String payload) {
        log.info("notification received: {}", payload);
    }
}
` },
      ];
  }
}

// ─── Quarkus ──────────────────────────────────────────────────────────────────

export function quarkusInfra(config: StackConfig): JavaInfra {
  const queue = javaQueue(config.queue);
  const cache = javaRedisCache(config.cache);
  const redis = cache || queue === "redis";
  const q = (a: string, scope?: string) => dep("io.quarkus", a, undefined, scope);
  const deps: string[] = [];
  const boms: string[] = [];
  const props: string[] = [];
  const files: GeneratedFile[] = [];

  if (config.tracing) {
    deps.push(q("quarkus-opentelemetry"));
    props.push(`# ─── Tracing ─────────────────────────────────────────────────────────────────
# OTLP/HTTP; Quarkus appends /v1/traces to the base URL.
quarkus.otel.exporter.otlp.traces.protocol=http/protobuf
quarkus.otel.exporter.otlp.traces.endpoint=\${OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4318}
%test.quarkus.otel.sdk.disabled=true`);
  }

  if (config.monitoring === "sentry") {
    deps.push(dep("io.quarkiverse.loggingsentry", "quarkus-logging-sentry", "2.1.1"));
    props.push(`# ─── Sentry ──────────────────────────────────────────────────────────────────
# ERROR logs (including unhandled exceptions) become Sentry events.
quarkus.log.sentry.enabled=true
quarkus.log.sentry.dsn=\${SENTRY_DSN:}
quarkus.log.sentry.in-app-packages=${PKG}
%test.quarkus.log.sentry.enabled=false`);
  } else if (config.monitoring === "datadog") {
    deps.push(dep("io.quarkiverse.micrometer.registry", "quarkus-micrometer-registry-datadog", "3.2.4"));
    props.push(`# ─── Datadog ─────────────────────────────────────────────────────────────────
# Micrometer ships metrics straight to the Datadog API. For APM traces, turn on
# tracing and point OTEL_EXPORTER_OTLP_ENDPOINT at the Datadog Agent (:4318).
quarkus.micrometer.export.datadog.api-key=\${DD_API_KEY:}
quarkus.micrometer.export.datadog.step=30s
# The registry validates the key even when disabled; tests get a placeholder.
%test.quarkus.micrometer.export.datadog.enabled=false
%test.quarkus.micrometer.export.datadog.api-key=test`);
  }

  if (config.rateLimit) {
    deps.push(BUCKET4J());
    files.push({ path: `${SRC}/infra/RateLimitFilter.java`, content: quarkusRateLimitFilter() });
  }
  if (config.audit) {
    files.push({ path: `${SRC}/infra/AuditFilter.java`, content: quarkusAuditFilter() });
  }

  if (redis) {
    deps.push(q("quarkus-redis-client"));
    props.push(`# ─── Redis ───────────────────────────────────────────────────────────────────
# redis:// or rediss:// (TLS, e.g. Upstash). Dragonfly speaks the same protocol.
quarkus.redis.hosts=\${REDIS_URL:redis://localhost:6379}
quarkus.redis.devservices.enabled=false`);
  }
  if (cache) {
    files.push({ path: `${SRC}/infra/JsonCache.java`, content: quarkusJsonCache() });
  }

  if (queue) {
    props.push(`# ─── Queue ───────────────────────────────────────────────────────────────────`);
    files.push(...quarkusQueueFiles(queue));
  }
  const inMemory = `%test.mp.messaging.outgoing.notifications-out.connector=smallrye-in-memory
%test.mp.messaging.incoming.notifications-in.connector=smallrye-in-memory`;
  switch (queue) {
    case "kafka":
      deps.push(q("quarkus-messaging-kafka"), dep("io.smallrye.reactive", "smallrye-reactive-messaging-in-memory", undefined, "test"));
      props.push(`# The topic must exist — Redpanda doesn't auto-create it: rpk topic create notifications
kafka.bootstrap.servers=\${KAFKA_BROKERS:localhost:9092}
mp.messaging.outgoing.notifications-out.connector=smallrye-kafka
mp.messaging.outgoing.notifications-out.topic=notifications
mp.messaging.incoming.notifications-in.connector=smallrye-kafka
mp.messaging.incoming.notifications-in.topic=notifications
mp.messaging.incoming.notifications-in.auto.offset.reset=earliest
${inMemory}`);
      break;
    case "rabbitmq":
      deps.push(q("quarkus-messaging-rabbitmq"), dep("io.smallrye.reactive", "smallrye-reactive-messaging-in-memory", undefined, "test"));
      props.push(`# Connection comes from RABBITMQ_URL via the RabbitOptions bean (the connector has no URL attribute).
rabbitmq.url=\${RABBITMQ_URL:amqp://guest:guest@localhost:5672}
rabbitmq-client-options-name=rabbitmq-options
quarkus.rabbitmq.devservices.enabled=false
mp.messaging.outgoing.notifications-out.connector=smallrye-rabbitmq
mp.messaging.outgoing.notifications-out.exchange.name=notifications
mp.messaging.incoming.notifications-in.connector=smallrye-rabbitmq
mp.messaging.incoming.notifications-in.exchange.name=notifications
mp.messaging.incoming.notifications-in.queue.name=notifications
${inMemory}`);
      break;
    case "nats":
      deps.push(JNATS());
      props.push(`nats.url=\${NATS_URL:nats://localhost:4222}
queue.consumer.enabled=true
%test.queue.consumer.enabled=false`);
      break;
    case "sqs":
      boms.push(`      <dependency>
        <groupId>io.quarkus.platform</groupId>
        <artifactId>quarkus-amazon-services-bom</artifactId>
        <version>\${quarkus.platform.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
`);
      deps.push(dep("io.quarkiverse.amazonservices", "quarkus-amazon-sqs"), dep("software.amazon.awssdk", "url-connection-client"));
      props.push(`# Local ElasticMQ; leave AWS_ENDPOINT_URL_SQS unset in production to use real SQS.
quarkus.sqs.endpoint-override=\${AWS_ENDPOINT_URL_SQS:}
quarkus.sqs.aws.region=\${AWS_REGION:us-east-1}
quarkus.sqs.aws.credentials.type=default
quarkus.sqs.sync-client.type=url
quarkus.sqs.devservices.enabled=false
queue.consumer.enabled=true
%test.queue.consumer.enabled=false`);
      break;
    case "redis":
      props.push(`queue.consumer.enabled=true
%test.queue.consumer.enabled=false`);
      break;
  }

  return {
    deps: deps.join(""),
    boms: boms.join(""),
    props: props.length ? `\n${props.join("\n\n")}\n` : "",
    testProps: "",
    files,
    cache,
    publisher: queue !== null,
  };
}

function quarkusRateLimitFilter(): string {
  return `package ${PKG}.infra;

import io.github.bucket4j.Bucket;
import io.vertx.core.http.HttpServerRequest;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.jboss.resteasy.reactive.server.ServerRequestFilter;

/**
 * Per-client-IP token bucket (bucket4j), checked before routing. Behind a load
 * balancer set quarkus.http.proxy.proxy-address-forwarding=true so
 * remoteAddress() is the real client.
 */
public class RateLimitFilter {

${RATE_LIMIT_CONSTANTS}

    @ServerRequestFilter(preMatching = true)
    public Optional<Response> rateLimit(HttpServerRequest request) {
        String ip = request.remoteAddress() == null ? "unknown" : request.remoteAddress().host();
        if (allow(ip)) return Optional.empty();
        return Optional.of(Response.status(429)
            .header("Retry-After", "1")
            .type(MediaType.APPLICATION_JSON)
            .entity("{\\"error\\":\\"rate_limited\\"}")
            .build());
    }
}
`;
}

function quarkusAuditFilter(): string {
  return `package ${PKG}.infra;

import jakarta.ws.rs.container.ContainerRequestContext;
import jakarta.ws.rs.container.ContainerResponseContext;
import java.security.Principal;
import java.util.Set;
import org.jboss.logging.Logger;
import org.jboss.resteasy.reactive.server.ServerResponseFilter;

/** One "audit" log line per mutating request (who, what, result). */
public class AuditFilter {

    private static final Logger AUDIT = Logger.getLogger("audit");
    private static final Set<String> MUTATING = Set.of("POST", "PUT", "PATCH", "DELETE");

    @ServerResponseFilter
    public void audit(ContainerRequestContext request, ContainerResponseContext response) {
        if (!MUTATING.contains(request.getMethod())) return;
        Principal user = request.getSecurityContext().getUserPrincipal();
        AUDIT.infof("audit method=%s path=%s status=%d user=%s",
            request.getMethod(), request.getUriInfo().getPath(), response.getStatus(),
            user == null ? null : user.getName());
    }
}
`;
}

function quarkusJsonCache(): string {
  return `package ${PKG}.infra;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.quarkus.redis.datasource.RedisDataSource;
import io.quarkus.redis.datasource.keys.KeyCommands;
import io.quarkus.redis.datasource.value.ValueCommands;
import jakarta.enterprise.context.ApplicationScoped;
import org.jboss.logging.Logger;

/**
 * Cache-aside helper over Redis: resources read get-by-id through it and evict
 * on update/delete. Values are JSON (the app's ObjectMapper), TTL 60s. A Redis
 * outage degrades to database reads instead of failing the request.
 */
@ApplicationScoped
public class JsonCache {

    private static final Logger LOG = Logger.getLogger(JsonCache.class);
    private static final long TTL_SECONDS = 60;

    private final ValueCommands<String, String> values;
    private final KeyCommands<String> keys;
    private final ObjectMapper mapper;

    public JsonCache(RedisDataSource redis, ObjectMapper mapper) {
        this.values = redis.value(String.class);
        this.keys = redis.key();
        this.mapper = mapper;
    }

    public <T> T get(String key, Class<T> type) {
        try {
            String json = values.get(key);
            return json == null ? null : mapper.readValue(json, type);
        } catch (Exception e) {
            LOG.warnf("cache read failed for %s: %s", key, e.getMessage());
            return null;
        }
    }

    public void put(String key, Object value) {
        try {
            values.setex(key, TTL_SECONDS, mapper.writeValueAsString(value));
        } catch (Exception e) {
            LOG.warnf("cache write failed for %s: %s", key, e.getMessage());
        }
    }

    public void evict(String key) {
        try {
            keys.del(key);
        } catch (Exception e) {
            LOG.warnf("cache evict failed for %s: %s", key, e.getMessage());
        }
    }
}
`;
}

function quarkusQueueFiles(queue: Exclude<JavaQueue, null>): GeneratedFile[] {
  const file = (name: string, content: string) => ({ path: `${SRC}/messaging/${name}.java`, content: `package ${PKG}.messaging;\n\n${content}` });

  // Kafka and RabbitMQ go through SmallRye Reactive Messaging: an Emitter on the
  // outgoing channel, @Incoming on the other. Tests swap both for in-memory.
  const smallrye = (doc: string) => [
    file("NotificationPublisher", `import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.eclipse.microprofile.reactive.messaging.Channel;
import org.eclipse.microprofile.reactive.messaging.Emitter;

/** ${doc} Channel config lives in application.properties. */
@ApplicationScoped
public class NotificationPublisher {

    @Inject
    @Channel("notifications-out")
    Emitter<String> emitter;

    public void publish(String payload) {
        emitter.send(payload);
    }
}
`),
    file("NotificationConsumer", `import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.reactive.messaging.Incoming;
import org.jboss.logging.Logger;

/** Handles messages published by NotificationPublisher. Replace the log line with real work. */
@ApplicationScoped
public class NotificationConsumer {

    private static final Logger LOG = Logger.getLogger(NotificationConsumer.class);

    @Incoming("notifications-in")
    public void onMessage(String payload) {
        LOG.infof("notification received: %s", payload);
    }
}
`),
  ];

  // NATS / SQS / Redis have no SmallRye connector here: consumers start on
  // StartupEvent unless queue.consumer.enabled=false (the test profile).
  const gatedConsumer = (imports: string, fields: string, start: string, extra = "") => file("NotificationConsumer", `${imports}
import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

/** Handles messages published by NotificationPublisher. Replace the log line with real work. */
@ApplicationScoped
public class NotificationConsumer {

    private static final Logger LOG = Logger.getLogger(NotificationConsumer.class);

${fields}

    @ConfigProperty(name = "queue.consumer.enabled", defaultValue = "true")
    boolean enabled;

    void onStart(@Observes StartupEvent event) {
        if (!enabled) return;
${start}
    }

    public void onMessage(String payload) {
        LOG.infof("notification received: %s", payload);
    }
${extra}}
`);

  // Readiness check for brokers SmallRye has no built-in check for. Its own class:
  // the @Readiness qualifier would drop @Default from a bean other code injects.
  const readiness = (name: string, imports: string, param: string, label: string, check: string) => file(`${name}HealthCheck`, `${imports}
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.health.HealthCheck;
import org.eclipse.microprofile.health.HealthCheckResponse;
import org.eclipse.microprofile.health.Readiness;

/** "${label}" check for /health?ready=1 and /q/health/ready. */
@Readiness
@ApplicationScoped
public class ${name}HealthCheck implements HealthCheck {

    private final ${param};

    public ${name}HealthCheck(${param}) {
        this.${param.split(" ")[1]} = ${param.split(" ")[1]};
    }

    @Override
    public HealthCheckResponse call() {
        try {
            return ${check};
        } catch (RuntimeException e) {
            return HealthCheckResponse.down("${label}");
        }
    }
}
`);

  switch (queue) {
    case "kafka":
      return smallrye("Publishes JSON payloads to the Kafka / Redpanda topic \"notifications\".");
    case "rabbitmq":
      return [
        ...smallrye("Publishes JSON payloads to the RabbitMQ exchange \"notifications\" (bound to the queue of the same name)."),
        file("RabbitOptions", `import io.smallrye.common.annotation.Identifier;
import io.vertx.rabbitmq.RabbitMQOptions;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.inject.Produces;
import org.eclipse.microprofile.config.inject.ConfigProperty;

/** Builds the RabbitMQ client options from RABBITMQ_URL (amqp://user:pass@host:5672/vhost). */
@ApplicationScoped
public class RabbitOptions {

    @Produces
    @Identifier("rabbitmq-options")
    RabbitMQOptions options(@ConfigProperty(name = "rabbitmq.url") String url) {
        return new RabbitMQOptions()
            .setUri(url)
            .setAutomaticRecoveryEnabled(true)
            .setReconnectAttempts(100)
            .setReconnectInterval(10_000);
    }
}
`),
      ];
    case "nats":
      return [
        file("NatsConnection", `import io.nats.client.Connection;
import io.nats.client.Nats;
import io.nats.client.Options;
import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;

/**
 * One shared NATS connection, opened on first use so the app (and its tests)
 * start without a server.
 */
@ApplicationScoped
public class NatsConnection {

    @ConfigProperty(name = "nats.url")
    String url;

    private Connection connection;

    public synchronized Connection get() {
        if (connection == null) {
            try {
                connection = Nats.connect(new Options.Builder().server(url).maxReconnects(-1).build());
            } catch (java.io.IOException e) {
                throw new IllegalStateException("cannot connect to NATS at " + url, e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted connecting to NATS", e);
            }
        }
        return connection;
    }

    @PreDestroy
    synchronized void close() throws InterruptedException {
        if (connection != null) connection.close();
    }
}
`),
        readiness("Nats", "import io.nats.client.Connection;", "NatsConnection nats", "nats",
          "HealthCheckResponse.named(\"nats\").status(nats.get().getStatus() == Connection.Status.CONNECTED).build()"),
        file("NotificationPublisher", `import jakarta.enterprise.context.ApplicationScoped;
import java.nio.charset.StandardCharsets;

/**
 * Publishes JSON payloads on the NATS subject "notifications".
 * ponytail: core NATS is at-most-once; use JetStream (connection.jetStream()) when messages must survive a restart.
 */
@ApplicationScoped
public class NotificationPublisher {

    public static final String DESTINATION = "notifications";

    private final NatsConnection nats;

    public NotificationPublisher(NatsConnection nats) {
        this.nats = nats;
    }

    public void publish(String payload) {
        nats.get().publish(DESTINATION, payload.getBytes(StandardCharsets.UTF_8));
    }
}
`),
        gatedConsumer("import java.nio.charset.StandardCharsets;", `    private final NatsConnection nats;

    public NotificationConsumer(NatsConnection nats) {
        this.nats = nats;
    }`, `        nats.get()
            .createDispatcher(msg -> onMessage(new String(msg.getData(), StandardCharsets.UTF_8)))
            .subscribe(NotificationPublisher.DESTINATION);`),
      ];
    case "sqs":
      return [
        readiness("Sqs", "import software.amazon.awssdk.services.sqs.SqsClient;", "SqsClient sqs", "sqs",
          "sqs.listQueues() != null ? HealthCheckResponse.up(\"sqs\") : HealthCheckResponse.down(\"sqs\")"),
        file("NotificationPublisher", `import jakarta.enterprise.context.ApplicationScoped;
import software.amazon.awssdk.services.sqs.SqsClient;

/** Sends JSON payloads to the SQS queue "notifications" (created if missing). */
@ApplicationScoped
public class NotificationPublisher {

    public static final String DESTINATION = "notifications";

    private final SqsClient sqs;
    private volatile String queueUrl;

    public NotificationPublisher(SqsClient sqs) {
        this.sqs = sqs;
    }

    /** CreateQueue is idempotent and returns the URL of an existing queue. */
    public String queueUrl() {
        if (queueUrl == null) queueUrl = sqs.createQueue(r -> r.queueName(DESTINATION)).queueUrl();
        return queueUrl;
    }

    public void publish(String payload) {
        sqs.sendMessage(r -> r.queueUrl(queueUrl()).messageBody(payload));
    }
}
`),
        gatedConsumer(`import io.quarkus.runtime.ShutdownEvent;
import software.amazon.awssdk.services.sqs.SqsClient;
import software.amazon.awssdk.services.sqs.model.Message;`, `    private final SqsClient sqs;
    private final NotificationPublisher publisher;
    private volatile boolean running;

    public NotificationConsumer(SqsClient sqs, NotificationPublisher publisher) {
        this.sqs = sqs;
        this.publisher = publisher;
    }`, `        running = true;
        Thread.ofVirtual().name("sqs-consumer").start(this::poll);`, `
    void onStop(@Observes ShutdownEvent event) {
        running = false;
    }

    /** Long-polls the queue; a message is deleted only after onMessage succeeds. */
    private void poll() {
        while (running) {
            try {
                String url = publisher.queueUrl();
                for (Message m : sqs.receiveMessage(r -> r.queueUrl(url).waitTimeSeconds(20).maxNumberOfMessages(10)).messages()) {
                    onMessage(m.body());
                    sqs.deleteMessage(r -> r.queueUrl(url).receiptHandle(m.receiptHandle()));
                }
            } catch (RuntimeException e) {
                LOG.warnf("sqs poll failed: %s", e.getMessage());
                try {
                    Thread.sleep(5_000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }
`),
      ];
    case "redis":
      return [
        file("NotificationPublisher", `import io.quarkus.redis.datasource.RedisDataSource;
import io.quarkus.redis.datasource.pubsub.PubSubCommands;
import jakarta.enterprise.context.ApplicationScoped;

/**
 * Publishes JSON payloads on the Redis pub/sub channel "notifications".
 *
 * BullMQ is a Node.js library with its own job format; there is no JVM client,
 * so this is plain Redis pub/sub on the same REDIS_URL. Node BullMQ workers will
 * NOT see these messages. ponytail: pub/sub is fire-and-forget — use Redis
 * Streams (redis.stream(...)) when consumers must not miss messages.
 */
@ApplicationScoped
public class NotificationPublisher {

    public static final String DESTINATION = "notifications";

    private final PubSubCommands<String> pubsub;

    public NotificationPublisher(RedisDataSource redis) {
        this.pubsub = redis.pubsub(String.class);
    }

    public void publish(String payload) {
        pubsub.publish(DESTINATION, payload);
    }
}
`),
        gatedConsumer("import io.quarkus.redis.datasource.RedisDataSource;", `    private final RedisDataSource redis;

    public NotificationConsumer(RedisDataSource redis) {
        this.redis = redis;
    }`, `        redis.pubsub(String.class).subscribe(NotificationPublisher.DESTINATION, this::onMessage);`),
      ];
  }
}

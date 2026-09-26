import type { GeneratedFile } from "../types";

// Go queue wiring: internal/queue (one Queue interface, exactly one broker
// implementation per stack) + cmd/worker (the consumer process).
export type GoQueueKind = "kafka" | "rabbitmq" | "nats" | "sqs" | "redis";

export function goQueueKind(queue: string): GoQueueKind | null {
  if (queue === "kafka" || queue === "redpanda") return "kafka";
  if (queue === "rabbitmq" || queue === "nats" || queue === "sqs") return queue;
  if (queue === "bullmq") return "redis";
  return null;
}

// Extra internal/config fields, in their own block so gofmt alignment of the
// base block is untouched. Env names match what common.ts puts in .env.example.
export function goQueueConfigField(kind: GoQueueKind | null): string {
  if (kind === "kafka") return "\tKafkaBrokers []string `env:\"KAFKA_BROKERS\" envSeparator:\",\"`\n";
  if (kind === "rabbitmq") return "\tRabbitMQURL string `env:\"RABBITMQ_URL\"`\n";
  if (kind === "nats") return "\tNATSURL string `env:\"NATS_URL\"`\n";
  return ""; // sqs: the AWS SDK reads AWS_* itself; redis: RedisURL already exists
}

const IFACE = `// Topics published by the API and consumed by cmd/worker.
const (
\tTopicNotifications = "notifications"
\tTopicWebhooks      = "webhooks"
)

// Queue is the message broker the API publishes to and cmd/worker consumes.
type Queue interface {
\tPublish(ctx context.Context, topic string, msg []byte) error
\t// Subscribe blocks, calling handle for every message on topic, until ctx is
\t// cancelled (returns nil) or the broker connection fails (returns the error).
\tSubscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error
\t// Ping backs the "queue" readiness check (/health?ready=1).
\tPing(ctx context.Context) error
\tClose() error
}`;

const IMPL: Record<GoQueueKind, { std: string[]; ext: string[]; code: string }> = {
  kafka: {
    std: ["context", "errors"],
    ext: ["github.com/segmentio/kafka-go"],
    code: `type kafkaQueue struct {
\tbrokers []string
\tgroup   string
\tw       *kafka.Writer
}

// Open connects to KAFKA_BROKERS (Kafka or Redpanda). The writer dials lazily;
// readiness reports the broker as down until it is reachable.
func Open(_ context.Context, cfg *config.Config) (Queue, error) {
\tif len(cfg.KafkaBrokers) == 0 {
\t\treturn nil, errors.New("KAFKA_BROKERS is not set")
\t}
\tw := &kafka.Writer{Addr: kafka.TCP(cfg.KafkaBrokers...), Balancer: &kafka.LeastBytes{}, AllowAutoTopicCreation: true}
\treturn &kafkaQueue{brokers: cfg.KafkaBrokers, group: cfg.AppName + "-worker", w: w}, nil
}

func (k *kafkaQueue) Publish(ctx context.Context, topic string, msg []byte) error {
\treturn k.w.WriteMessages(ctx, kafka.Message{Topic: topic, Value: msg})
}

// Subscribe reads as consumer group "<APP_NAME>-worker" and commits each offset
// after handle succeeds. A handler error stops the consumer with the offset
// uncommitted, so the message is redelivered when the worker restarts.
func (k *kafkaQueue) Subscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error {
\tr := kafka.NewReader(kafka.ReaderConfig{Brokers: k.brokers, GroupID: k.group, Topic: topic})
\tdefer r.Close()
\tfor {
\t\tm, err := r.FetchMessage(ctx)
\t\tif err != nil {
\t\t\tif ctx.Err() != nil {
\t\t\t\treturn nil
\t\t\t}
\t\t\treturn err
\t\t}
\t\tif err := handle(ctx, m.Value); err != nil {
\t\t\treturn err
\t\t}
\t\tif err := r.CommitMessages(ctx, m); err != nil && ctx.Err() == nil {
\t\t\treturn err
\t\t}
\t}
}

func (k *kafkaQueue) Ping(ctx context.Context) error {
\tconn, err := kafka.DialContext(ctx, "tcp", k.brokers[0])
\tif err != nil {
\t\treturn err
\t}
\treturn conn.Close()
}

func (k *kafkaQueue) Close() error { return k.w.Close() }`,
  },

  rabbitmq: {
    std: ["context", "errors", "sync"],
    ext: ["github.com/rabbitmq/amqp091-go"],
    code: `type rabbitQueue struct {
\tconn *amqp.Connection
\tmu   sync.Mutex // an AMQP channel must not be used for concurrent publishes
\tch   *amqp.Channel
}

// Open dials RABBITMQ_URL. Each topic is a durable queue on the default exchange.
func Open(_ context.Context, cfg *config.Config) (Queue, error) {
\tif cfg.RabbitMQURL == "" {
\t\treturn nil, errors.New("RABBITMQ_URL is not set")
\t}
\tconn, err := amqp.Dial(cfg.RabbitMQURL)
\tif err != nil {
\t\treturn nil, err
\t}
\tch, err := conn.Channel()
\tif err != nil {
\t\t_ = conn.Close()
\t\treturn nil, err
\t}
\treturn &rabbitQueue{conn: conn, ch: ch}, nil
}

func declare(ch *amqp.Channel, topic string) error {
\t_, err := ch.QueueDeclare(topic, true, false, false, false, nil)
\treturn err
}

// ponytail: declares on every publish (idempotent, one round trip); cache the
// declared set if publish latency matters.
func (r *rabbitQueue) Publish(ctx context.Context, topic string, msg []byte) error {
\tr.mu.Lock()
\tdefer r.mu.Unlock()
\tif err := declare(r.ch, topic); err != nil {
\t\treturn err
\t}
\treturn r.ch.PublishWithContext(ctx, "", topic, false, false, amqp.Publishing{
\t\tContentType:  "application/json",
\t\tDeliveryMode: amqp.Persistent,
\t\tBody:         msg,
\t})
}

// Subscribe acks after handle succeeds. A handler error nacks without requeue
// (dropped, or dead-lettered if the queue has a DLX) to avoid a hot retry loop.
func (r *rabbitQueue) Subscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error {
\tch, err := r.conn.Channel()
\tif err != nil {
\t\treturn err
\t}
\tdefer ch.Close()
\tif err := declare(ch, topic); err != nil {
\t\treturn err
\t}
\tif err := ch.Qos(10, 0, false); err != nil {
\t\treturn err
\t}
\tdeliveries, err := ch.Consume(topic, "", false, false, false, false, nil)
\tif err != nil {
\t\treturn err
\t}
\tfor {
\t\tselect {
\t\tcase <-ctx.Done():
\t\t\treturn nil
\t\tcase d, ok := <-deliveries:
\t\t\tif !ok {
\t\t\t\treturn errors.New("rabbitmq: delivery channel closed")
\t\t\t}
\t\t\tif err := handle(ctx, d.Body); err != nil {
\t\t\t\t_ = d.Nack(false, false)
\t\t\t} else {
\t\t\t\t_ = d.Ack(false)
\t\t\t}
\t\t}
\t}
}

func (r *rabbitQueue) Ping(context.Context) error {
\tif r.conn.IsClosed() || r.ch.IsClosed() {
\t\treturn errors.New("rabbitmq: connection closed")
\t}
\treturn nil
}

func (r *rabbitQueue) Close() error {
\t_ = r.ch.Close()
\treturn r.conn.Close()
}`,
  },

  nats: {
    std: ["context", "errors", "fmt"],
    ext: ["github.com/nats-io/nats.go"],
    code: `type natsQueue struct {
\tnc    *nats.Conn
\tgroup string
}

// Open connects to NATS_URL and keeps reconnecting in the background.
// ponytail: core NATS pub/sub (at-most-once). Switch to JetStream streams if
// messages must survive a worker being down.
func Open(_ context.Context, cfg *config.Config) (Queue, error) {
\tif cfg.NATSURL == "" {
\t\treturn nil, errors.New("NATS_URL is not set")
\t}
\tnc, err := nats.Connect(cfg.NATSURL, nats.Name(cfg.AppName), nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1))
\tif err != nil {
\t\treturn nil, err
\t}
\treturn &natsQueue{nc: nc, group: cfg.AppName + "-worker"}, nil
}

func (n *natsQueue) Publish(_ context.Context, topic string, msg []byte) error {
\treturn n.nc.Publish(topic, msg)
}

// Subscribe joins queue group "<APP_NAME>-worker", so each message goes to one
// worker replica. Handler errors are not redelivered (core NATS has no acks).
func (n *natsQueue) Subscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error {
\tsub, err := n.nc.QueueSubscribe(topic, n.group, func(m *nats.Msg) {
\t\t_ = handle(ctx, m.Data)
\t})
\tif err != nil {
\t\treturn err
\t}
\t<-ctx.Done()
\treturn sub.Unsubscribe()
}

func (n *natsQueue) Ping(context.Context) error {
\tif !n.nc.IsConnected() {
\t\treturn fmt.Errorf("nats: %s", n.nc.Status())
\t}
\treturn nil
}

func (n *natsQueue) Close() error { return n.nc.Drain() }`,
  },

  sqs: {
    std: ["context", "sync"],
    ext: ["github.com/aws/aws-sdk-go-v2/aws", "github.com/aws/aws-sdk-go-v2/config", "github.com/aws/aws-sdk-go-v2/service/sqs"],
    code: `type sqsQueue struct {
\tclient *sqs.Client
\tmu     sync.Mutex
\turls   map[string]string // topic -> queue URL
}

// Open builds an SQS client from the standard AWS env (AWS_REGION, credentials,
// and AWS_ENDPOINT_URL_SQS for ElasticMQ / LocalStack in development).
func Open(ctx context.Context, _ *config.Config) (Queue, error) {
\tawsCfg, err := awsconfig.LoadDefaultConfig(ctx)
\tif err != nil {
\t\treturn nil, err
\t}
\treturn &sqsQueue{client: sqs.NewFromConfig(awsCfg), urls: map[string]string{}}, nil
}

// queueURL resolves the queue named after topic, creating it when it does not
// exist yet (needs sqs:CreateQueue; pre-create the queues if IAM forbids it).
func (q *sqsQueue) queueURL(ctx context.Context, topic string) (string, error) {
\tq.mu.Lock()
\tdefer q.mu.Unlock()
\tif u, ok := q.urls[topic]; ok {
\t\treturn u, nil
\t}
\tvar u *string
\tif out, err := q.client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(topic)}); err == nil {
\t\tu = out.QueueUrl
\t} else if out, err := q.client.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String(topic)}); err == nil {
\t\tu = out.QueueUrl
\t} else {
\t\treturn "", err
\t}
\tq.urls[topic] = aws.ToString(u)
\treturn q.urls[topic], nil
}

func (q *sqsQueue) Publish(ctx context.Context, topic string, msg []byte) error {
\turl, err := q.queueURL(ctx, topic)
\tif err != nil {
\t\treturn err
\t}
\t_, err = q.client.SendMessage(ctx, &sqs.SendMessageInput{QueueUrl: aws.String(url), MessageBody: aws.String(string(msg))})
\treturn err
}

// Subscribe long-polls and deletes each message after handle succeeds. A
// handler error leaves it on the queue; SQS redelivers it after the visibility
// timeout (configure a redrive policy to cap retries).
func (q *sqsQueue) Subscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error {
\turl, err := q.queueURL(ctx, topic)
\tif err != nil {
\t\treturn err
\t}
\tfor {
\t\tout, err := q.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{QueueUrl: aws.String(url), MaxNumberOfMessages: 10, WaitTimeSeconds: 20})
\t\tif err != nil {
\t\t\tif ctx.Err() != nil {
\t\t\t\treturn nil
\t\t\t}
\t\t\treturn err
\t\t}
\t\tfor _, m := range out.Messages {
\t\t\tif err := handle(ctx, []byte(aws.ToString(m.Body))); err != nil {
\t\t\t\tcontinue
\t\t\t}
\t\t\tif _, err := q.client.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: aws.String(url), ReceiptHandle: m.ReceiptHandle}); err != nil && ctx.Err() == nil {
\t\t\t\treturn err
\t\t\t}
\t\t}
\t}
}

func (q *sqsQueue) Ping(ctx context.Context) error {
\t_, err := q.client.ListQueues(ctx, &sqs.ListQueuesInput{MaxResults: aws.Int32(1)})
\treturn err
}

func (q *sqsQueue) Close() error { return nil }`,
  },

  redis: {
    std: ["context", "errors", "time"],
    ext: ["github.com/redis/go-redis/v9"],
    code: `// BullMQ's job format (Redis hashes + Lua scripts) is implemented only by the
// Node library, so this Go service does NOT produce or consume BullMQ jobs: a
// Node BullMQ worker will not see these messages. It uses the same Redis
// (REDIS_URL) with a plain list per topic, "queue:<topic>" — LPUSH to publish,
// BRPOP to consume — and cmd/worker is the consumer.
type redisQueue struct {
\trdb *redis.Client
}

func Open(_ context.Context, cfg *config.Config) (Queue, error) {
\tif cfg.RedisURL == "" {
\t\treturn nil, errors.New("REDIS_URL is not set")
\t}
\topt, err := redis.ParseURL(cfg.RedisURL)
\tif err != nil {
\t\treturn nil, err
\t}
\treturn &redisQueue{rdb: redis.NewClient(opt)}, nil
}

func (q *redisQueue) Publish(ctx context.Context, topic string, msg []byte) error {
\treturn q.rdb.LPush(ctx, "queue:"+topic, msg).Err()
}

// ponytail: at-most-once — a message is gone once popped, even if handle fails.
// Use BLMOVE into a processing list if you need at-least-once.
func (q *redisQueue) Subscribe(ctx context.Context, topic string, handle func(context.Context, []byte) error) error {
\tfor {
\t\tres, err := q.rdb.BRPop(ctx, 5*time.Second, "queue:"+topic).Result()
\t\tif errors.Is(err, redis.Nil) {
\t\t\tcontinue
\t\t}
\t\tif err != nil {
\t\t\tif ctx.Err() != nil {
\t\t\t\treturn nil
\t\t\t}
\t\t\treturn err
\t\t}
\t\t_ = handle(ctx, []byte(res[1])) // res is [key, value]
\t}
}

func (q *redisQueue) Ping(ctx context.Context) error { return q.rdb.Ping(ctx).Err() }

func (q *redisQueue) Close() error { return q.rdb.Close() }`,
  },
};

function queueGo(module: string, kind: GoQueueKind): string {
  const impl = IMPL[kind];
  const alias = (p: string) =>
    p === "github.com/rabbitmq/amqp091-go" ? `amqp "${p}"`
    : p === "github.com/aws/aws-sdk-go-v2/config" ? `awsconfig "${p}"`
    : `"${p}"`;
  const ext = [...impl.ext.map(alias), `"${module}/internal/config"`].sort((a, b) => a.replace(/^\w+ /, "").localeCompare(b.replace(/^\w+ /, "")));
  return `// Package queue connects to the stack's message broker.
package queue

import (
${impl.std.map((p) => `\t"${p}"`).join("\n")}

${ext.map((p) => `\t${p}`).join("\n")}
)

${IFACE}

${impl.code}
`;
}

function workerMain(module: string): string {
  return `// Command worker consumes the topics the API publishes (see internal/queue).
package main

import (
\t"context"
\t"log/slog"
\t"os"
\t"os/signal"
\t"sync"
\t"syscall"

\t"${module}/internal/config"
\t"${module}/internal/queue"
)

func main() {
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
\tslog.SetDefault(logger)

\tcfg, err := config.Load()
\tif err != nil {
\t\tlogger.Error("config", "err", err)
\t\tos.Exit(1)
\t}

\tctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
\tdefer cancel()

\tq, err := queue.Open(ctx, cfg)
\tif err != nil {
\t\tlogger.Error("queue", "err", err)
\t\tos.Exit(1)
\t}

\t// One consumer per topic. SIGINT/SIGTERM cancels ctx: consumers finish the
\t// message in hand and return; a failed consumer cancels the others.
\tvar wg sync.WaitGroup
\tfor _, topic := range []string{queue.TopicNotifications, queue.TopicWebhooks} {
\t\twg.Add(1)
\t\tgo func() {
\t\t\tdefer wg.Done()
\t\t\tlogger.Info("consuming", "topic", topic)
\t\t\terr := q.Subscribe(ctx, topic, func(ctx context.Context, msg []byte) error {
\t\t\t\treturn handle(ctx, logger, topic, msg)
\t\t\t})
\t\t\tif err != nil {
\t\t\t\tlogger.Error("consume", "topic", topic, "err", err)
\t\t\t\tcancel()
\t\t\t}
\t\t}()
\t}
\twg.Wait()

\tif err := q.Close(); err != nil {
\t\tlogger.Warn("queue close", "err", err)
\t}
\tlogger.Info("worker stopped")
}

// handle processes one message: replace the log line with the real work (send
// the notification, apply the webhook event). A returned error marks the
// message failed; redelivery depends on the broker (see queue.Subscribe).
func handle(_ context.Context, log *slog.Logger, topic string, msg []byte) error {
\tlog.Info("consumed", "topic", topic, "body", string(msg[:min(len(msg), 200)]))
\treturn nil
}
`;
}

export function goQueueFiles(module: string, kind: GoQueueKind): GeneratedFile[] {
  return [
    { path: "internal/queue/queue.go", content: queueGo(module, kind) },
    { path: "cmd/worker/main.go", content: workerMain(module) },
  ];
}

export type StackOption = {
  id: string;
  label: string;
  description: string;
  tags?: string[];
  popular?: boolean;
  accent?: string;
};

export const languages: StackOption[] = [
  {
    id: "go",
    label: "Go",
    description: "Compiled, concurrent, great for high-throughput services.",
    tags: ["Fast", "Concurrency", "Single binary"],
    popular: true,
    accent: "#00ADD8",
  },
  {
    id: "typescript",
    label: "TypeScript",
    description: "Node.js + TypeScript for end-to-end typed APIs.",
    tags: ["Bun", "Node 22", "Typed"],
    popular: true,
    accent: "#3178C6",
  },
  {
    id: "python",
    label: "Python",
    description: "Async FastAPI stack with Pydantic v2 models.",
    tags: ["Async", "Pydantic"],
    accent: "#3776AB",
  },
  {
    id: "rust",
    label: "Rust",
    description: "Memory-safe, zero-cost abstractions, blazing performance.",
    tags: ["Axum", "Tokio"],
    accent: "#DEA584",
  },
  {
    id: "java",
    label: "Java",
    description: "Enterprise-grade JVM with Spring Boot 3.",
    tags: ["Spring", "JDK 21"],
    accent: "#F89820",
  },
  {
    id: "kotlin",
    label: "Kotlin",
    description: "Modern JVM language with Ktor or Spring.",
    tags: ["Ktor", "Coroutines"],
    accent: "#7F52FF",
  },
];

export const frameworks: Record<string, StackOption[]> = {
  go: [
    { id: "gin", label: "Gin", description: "Lightweight HTTP framework." },
    { id: "fiber", label: "Fiber", description: "Express-style on FastHTTP." },
    { id: "echo", label: "Echo", description: "Minimalist, high-performance." },
    { id: "chi", label: "Chi", description: "Idiomatic net/http router." },
  ],
  typescript: [
    { id: "nestjs", label: "NestJS", description: "Modular, opinionated, Angular-ish.", popular: true },
    { id: "express", label: "Express", description: "Minimal, battle-tested." },
    { id: "fastify", label: "Fastify", description: "High throughput, schema-first." },
    { id: "hono", label: "Hono", description: "Ultrafast, edge-ready." },
  ],
  python: [
    { id: "fastapi", label: "FastAPI", description: "Async, typed, OpenAPI-first.", popular: true },
    { id: "django", label: "Django", description: "Batteries-included framework." },
    { id: "litestar", label: "Litestar", description: "Modern async framework." },
  ],
  rust: [
    { id: "axum", label: "Axum", description: "Tokio-based ergonomic framework.", popular: true },
    { id: "actix", label: "Actix Web", description: "Actor-based, high throughput." },
  ],
  java: [
    { id: "spring", label: "Spring Boot", description: "Production-grade Java platform." },
    { id: "quarkus", label: "Quarkus", description: "Supersonic subatomic Java." },
  ],
  kotlin: [
    { id: "ktor", label: "Ktor", description: "Kotlin-first async framework." },
    { id: "spring-kt", label: "Spring Boot (Kotlin)", description: "Spring with Kotlin idioms." },
  ],
};

export const databases: StackOption[] = [
  { id: "postgres", label: "PostgreSQL", description: "ACID, JSONB, extensions — the default relational choice.", popular: true, accent: "#336791" },
  { id: "mysql", label: "MySQL", description: "Widely deployed OLTP database.", accent: "#00758F" },
  { id: "mongodb", label: "MongoDB", description: "Document store with flexible schemas.", accent: "#47A248" },
  { id: "dynamodb", label: "DynamoDB", description: "Serverless, fully-managed key-value store.", accent: "#4053D6" },
  { id: "cockroach", label: "CockroachDB", description: "Distributed PostgreSQL-compatible SQL.", accent: "#6933FF" },
  { id: "planetscale", label: "PlanetScale", description: "Serverless MySQL with branching.", accent: "#EAEAEA" },
  { id: "supabase", label: "Supabase", description: "Postgres + auth + realtime.", accent: "#3ECF8E" },
  { id: "neon", label: "Neon", description: "Serverless Postgres with branching.", popular: true, accent: "#00E599" },
];

export const caches: StackOption[] = [
  { id: "redis", label: "Redis", description: "In-memory data store with rich data structures.", popular: true, accent: "#DC382D" },
  { id: "memcached", label: "Memcached", description: "Distributed memory object caching system.", accent: "#006848" },
  { id: "dragonfly", label: "Dragonfly", description: "Modern replacement for Redis / Memcached.", accent: "#f48fb1" },
  { id: "upstash", label: "Upstash Redis", description: "Serverless Redis with HTTP API.", accent: "#00E599" },
];

export const queues: StackOption[] = [
  { id: "rabbitmq", label: "RabbitMQ", description: "Robust AMQP broker.", popular: true, accent: "#FF6600" },
  { id: "kafka", label: "Apache Kafka", description: "Distributed event streaming.", popular: true, accent: "#000000" },
  { id: "sqs", label: "AWS SQS", description: "Managed message queue.", accent: "#FF9900" },
  { id: "nats", label: "NATS JetStream", description: "High-performance messaging.", accent: "#27AAE1" },
  { id: "bullmq", label: "BullMQ", description: "Redis-backed job queue for Node.", accent: "#DC382D" },
];

export const apis = [
  { id: "rest", label: "REST", description: "Resource-oriented HTTP APIs." },
  { id: "grpc", label: "gRPC", description: "Protobuf, HTTP/2, streaming RPC." },
  { id: "graphql", label: "GraphQL", description: "Typed client-driven queries." },
  { id: "trpc", label: "tRPC", description: "End-to-end typesafe APIs." },
];

export const authProviders: StackOption[] = [
  { id: "clerk", label: "Clerk", description: "Drop-in auth with rich UIs.", popular: true, accent: "#6C47FF" },
  { id: "auth0", label: "Auth0", description: "Enterprise identity platform.", accent: "#EB5424" },
  { id: "supabase-auth", label: "Supabase Auth", description: "Postgres-native auth.", accent: "#3ECF8E" },
  { id: "cognito", label: "AWS Cognito", description: "Managed user directories.", accent: "#DD344C" },
  { id: "firebase", label: "Firebase Auth", description: "Google identity platform.", accent: "#FFCA28" },
  { id: "keycloak", label: "Keycloak", description: "Open-source IAM.", accent: "#4D4D4D" },
];

export const deployments: StackOption[] = [
  { id: "vercel", label: "Vercel", description: "Instant deploys, edge network.", popular: true, accent: "#ffffff" },
  { id: "railway", label: "Railway", description: "Opinionated infra with great DX.", popular: true, accent: "#A855F7" },
  { id: "render", label: "Render", description: "Simple services + databases.", accent: "#46E3B7" },
  { id: "fly", label: "Fly.io", description: "Global app deployment.", accent: "#8B5CF6" },
  { id: "aws", label: "AWS", description: "ECS, EKS, Lambda, Fargate.", accent: "#FF9900" },
  { id: "gcp", label: "Google Cloud", description: "Cloud Run, GKE.", accent: "#4285F4" },
  { id: "azure", label: "Azure", description: "Container Apps, AKS.", accent: "#0078D4" },
  { id: "k8s", label: "Kubernetes", description: "Bring-your-own cluster.", accent: "#326CE5" },
];

export const scalingStrategies: StackOption[] = [
  { id: "horizontal", label: "Horizontal", description: "Stateless replicas behind a load balancer.", popular: true },
  { id: "vertical", label: "Vertical", description: "Scale single node CPU / memory." },
  { id: "serverless", label: "Serverless", description: "Per-request scale to zero." },
  { id: "hybrid", label: "Hybrid", description: "Mix replicas + serverless for spikes." },
];

export const monitoring: StackOption[] = [
  { id: "grafana", label: "Grafana + Prometheus", description: "Dashboards + metrics.", popular: true },
  { id: "datadog", label: "Datadog", description: "APM, logs, infra in one." },
  { id: "sentry", label: "Sentry", description: "Error + performance monitoring." },
  { id: "newrelic", label: "New Relic", description: "Full-stack observability." },
  { id: "otel", label: "OpenTelemetry", description: "Vendor-neutral instrumentation." },
];

export const cicd: StackOption[] = [
  { id: "gh-actions", label: "GitHub Actions", description: "Native GitHub workflows.", popular: true },
  { id: "gitlab-ci", label: "GitLab CI", description: "Built into GitLab." },
  { id: "circleci", label: "CircleCI", description: "Scalable managed CI." },
  { id: "argo", label: "Argo CD", description: "GitOps continuous delivery." },
];

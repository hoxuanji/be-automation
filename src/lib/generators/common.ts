import type { Endpoint, GeneratedFile, StackConfig } from "./types";
import { safeName, toEnvKey, looksLikeSecretValue, isGrpcSupported, isGraphqlSupported } from "./types";
import { authProviderSpec } from "./auth/providers";
import type { GitConfig } from "../git-config";
import { gitWorkflowFiles } from "./git-files";
import {
  acrName, ciDeploySection, circleDeployJob, flyToml, githubDeployWorkflow, gitlabDeployJob,
  maxInstances, minInstances, providerRegion, railwayJson, vercelSupported,
} from "./deploy";

const languageMeta: Record<
  StackConfig["language"],
  { runCommand: string; testCommand: string; devCommand: string; installCommand: string }
> = {
  go: { runCommand: "go run ./cmd/api", testCommand: "go test ./... -race -cover", devCommand: "go run ./cmd/api", installCommand: "go mod tidy" },
  typescript: { runCommand: "npm run start", testCommand: "npm test", devCommand: "npm run dev", installCommand: "npm install" },
  python: { runCommand: "uvicorn app.main:app --host 0.0.0.0 --port 8080", testCommand: "pytest -q", devCommand: "uvicorn app.main:app --reload", installCommand: "poetry install" },
  rust: { runCommand: "cargo run --release", testCommand: "cargo test", devCommand: "cargo run", installCommand: "cargo build" },
  java: { runCommand: "./mvnw spring-boot:run", testCommand: "./mvnw test", devCommand: "./mvnw spring-boot:run", installCommand: "./mvnw dependency:resolve" },
  kotlin: { runCommand: "./gradlew run", testCommand: "./gradlew test", devCommand: "./gradlew run", installCommand: "./gradlew dependencies" },
};

// Every language generator now wires tracing (OTLP), rate limiting and the selected
// monitoring SDK into the app; kept as a predicate so a new language opts in explicitly.
const hasAppObservability = (l: StackConfig["language"]) =>
  l === "go" || l === "typescript" || l === "python" || l === "rust" || l === "kotlin" || l === "java";

// Whether the app exports OTLP traces. Go also turns tracing on when OTel is the
// monitoring choice (go.ts: withTracing).
const emitsOtel = (c: StackConfig) =>
  hasAppObservability(c.language) &&
  (c.tracing ||
    (c.language === "go" && c.monitoring === "otel") ||
    // rust.ts turns tracing on for otel, and ships Datadog traces over OTLP to the agent.
    (c.language === "rust" && (c.monitoring === "otel" || c.monitoring === "datadog")));

// REST servers ping their dependencies (DB, cache, queue) on /health?ready=1; gRPC/GraphQL
// trees answer readiness with plain /health.
const readyPath = (c: StackConfig) => (c.api === "rest" ? "/health?ready=1" : "/health");

// Self-managed auth (no provider): pattern login/register endpoints sign JWTs with JWT_SECRET.
const selfIssuesJwt = (c: StackConfig, endpoints: Endpoint[]) =>
  !authProviderSpec(c) && endpoints.some((e) => e.pattern?.startsWith("auth_"));

const isRedisLike = (cache: string) => cache === "redis" || cache === "upstash" || cache === "dragonfly";
const isJvm = (l: StackConfig["language"]) => l === "java" || l === "kotlin";

// Where Prometheus should scrape each framework's metrics endpoint.
function metricsPath(config: StackConfig): string {
  if (config.framework === "spring" || config.framework === "spring-kt") return "/actuator/prometheus";
  if (config.framework === "quarkus") return "/q/metrics";
  return "/metrics";
}

// DATABASE_URL in the shape each runtime's driver expects. JVM stacks need a
// JDBC URL (credentials as query params); everyone else takes the native URL.
// `host` lets docker-compose point at the service name instead of localhost.
function databaseUrl(config: StackConfig, host = "localhost"): string | null {
  const db = safeName(config.name);
  const jvm = isJvm(config.language);
  if (/postgres|neon|supabase/.test(config.database)) {
    return jvm ? `jdbc:postgresql://${host}:5432/${db}?user=app&password=app` : `postgres://app:app@${host}:5432/${db}`;
  }
  if (config.database === "cockroach") {
    return jvm
      ? `jdbc:postgresql://${host}:26257/${db}?user=root&sslmode=disable`
      : `postgres://root@${host}:26257/${db}?sslmode=disable`;
  }
  if (config.database === "mysql" || config.database === "planetscale") {
    return jvm ? `jdbc:mysql://${host}:3306/${db}?user=app&password=app` : `mysql://app:app@${host}:3306/${db}`;
  }
  return null;
}

const langEmoji: Record<StackConfig["language"], string> = {
  go: "Go",
  typescript: "TypeScript",
  python: "Python",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
};

export function commonFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  gitConfig?: GitConfig
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const meta = languageMeta[config.language];
  const name = safeName(config.name);

  files.push({
    path: "README.md",
    content: readme(config, endpoints, meta),
  });

  files.push({ path: "QUICKSTART.md", content: quickstart(config) });
  files.push({ path: "DEPLOY.md", content: deployGuide(config) });
  files.push({ path: ".env.example", content: envExample(config, endpoints) });
  files.push({ path: ".gitignore", content: gitignore(config.language) });
  files.push({
    path: ".editorconfig",
    content:
      "root = true\n\n[*]\nend_of_line = lf\ncharset = utf-8\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n",
  });

  if (config.docker) {
    files.push({ path: "docker-compose.yml", content: dockerCompose(config) });
  }

  // A k8s target always needs something to apply: plain manifests unless Helm is chosen.
  if (config.kubernetes || (config.deployment === "k8s" && !config.helm)) {
    files.push({
      path: "deploy/k8s/deployment.yaml",
      content: k8sDeployment(config),
    });
    files.push({
      path: "deploy/k8s/service.yaml",
      content: k8sService(config),
    });
    files.push({
      path: "deploy/k8s/secrets.example.env",
      content: k8sSecretsExample(config),
    });
    files.push({
      path: "deploy/k8s/Makefile",
      content: k8sMakefile(config),
    });
    // PodDisruptionBudget matters whenever replicas > 1 — without it the
    // cluster-autoscaler or a kubectl drain can evict every pod at once.
    if (config.replicas > 1) {
      files.push({
        path: "deploy/k8s/pdb.yaml",
        content: k8sPDB(config),
      });
    }
    // `vertical` scaling right-sizes pods via a VPA instead of adding replicas;
    // HPA + VPA both acting on CPU fight each other, so emit one or the other.
    if (config.autoscale && config.scaling === "vertical") {
      files.push({
        path: "deploy/k8s/vpa.yaml",
        content: k8sVPA(config),
      });
    } else if (config.autoscale) {
      files.push({
        path: "deploy/k8s/hpa.yaml",
        content: k8sHPA(config),
      });
    }
  }

  if (config.deployment === "aws") {
    files.push({ path: "deploy/aws/task-definition.json", content: ecsTaskDefinition(config) });
  } else if (config.deployment === "gcp") {
    files.push({ path: "deploy/gcp/service.yaml", content: cloudRunService(config) });
  } else if (config.deployment === "azure") {
    files.push({ path: "deploy/azure/containerapp.yaml", content: azureContainerApp(config) });
  } else if (config.deployment === "fly") {
    files.push({ path: "fly.toml", content: flyToml(config) });
  } else if (config.deployment === "railway") {
    files.push({ path: "railway.json", content: railwayJson(config) });
  }

  if (config.helm) {
    files.push({
      path: "deploy/helm/Chart.yaml",
      content: helmChart(name, config),
    });
    files.push({
      path: "deploy/helm/values.yaml",
      content: helmValues(config),
    });
    files.push({
      path: "deploy/helm/templates/deployment.yaml",
      content: helmDeploymentTemplate(config),
    });
    files.push({
      path: "deploy/helm/templates/service.yaml",
      content: helmServiceTemplate(),
    });
    files.push({
      path: "deploy/helm/templates/hpa.yaml",
      content: helmHpaTemplate(),
    });
  }

  if (gitConfig) {
    files.push(...gitWorkflowFiles(config, gitConfig));
  } else if (config.cicd !== "gitlab-ci" && config.cicd !== "circleci") {
    files.push({
      path: ".github/workflows/ci.yml",
      content: ciWorkflow(config),
    });
  }
  // Fixed path + workflow/job name `deploy`: Helios' one-click deploy dispatches it.
  if (config.cicd !== "gitlab-ci" && config.cicd !== "circleci") {
    files.push({
      path: ".github/workflows/deploy.yml",
      content: githubDeployWorkflow(config, ghaBuildSteps(config.language)),
    });
  }
  if (config.cicd === "gitlab-ci") {
    files.push({ path: ".gitlab-ci.yml", content: gitlabCi(config) });
  } else if (config.cicd === "circleci") {
    files.push({ path: ".circleci/config.yml", content: circleCi(config) });
  } else if (config.cicd === "argo" && (config.kubernetes || config.helm)) {
    // Argo CD is CD only — GitHub Actions (above) still builds + pushes the image.
    files.push({ path: "deploy/argocd/application.yaml", content: argoApplication(config) });
  }

  files.push({
    path: "api/openapi.yaml",
    content: openapiSpec(config, endpoints),
  });

  files.push({
    path: "api/postman_collection.json",
    content: postmanCollection(config, endpoints),
  });

  if (config.monitoring === "grafana") {
    // gRPC servers serve metrics on a separate plain-HTTP listener (:9464), not the gRPC port.
    const metricsTarget = config.api === "grpc" && isGrpcSupported(config.language) ? "api:9464" : "api:8080";
    files.push({ path: "deploy/prometheus.yml", content: prometheusConfig(name, metricsPath(config), metricsTarget) });
    files.push({ path: "deploy/grafana/datasource.yml", content: grafanaDatasource() });
  }

  if (config.monitoring === "otel") {
    files.push({ path: "deploy/otel-collector.yaml", content: otelCollectorConfig() });
  }

  if (config.monitoring === "datadog") {
    files.push({ path: "deploy/datadog.yaml", content: datadogConfig(config) });
    files.push({ path: "SETUP_MONITORING.md", content: datadogSetupGuide(config) });
  }

  if (config.monitoring === "sentry") {
    files.push({ path: "SETUP_MONITORING.md", content: sentrySetupGuide(config) });
  }

  if (config.monitoring === "newrelic") {
    files.push({ path: "deploy/newrelic.yml", content: newrelicConfig(name) });
  }

  return files;
}

function readme(
  config: StackConfig,
  endpoints: Endpoint[],
  meta: (typeof languageMeta)[StackConfig["language"]]
) {
  const ep = endpoints
    .map((e) => `| \`${e.method}\` | \`${e.path}\` | ${e.summary}${e.auth ? " | 🔐" : " | —"} |`)
    .join("\n");

  const isGrpc = config.api === "grpc";
  const isGraphql = config.api === "graphql";
  const grpcUnsupportedBanner =
    isGrpc && !isGrpcSupported(config.language)
      ? `
> ⚠️ **gRPC not yet generated for ${langEmoji[config.language]}.** Helios emitted a REST server instead.
> gRPC support lands first for Go, TypeScript, and Python — switch the stack language if you need a working gRPC
> bootstrap, or keep this repo on REST.
`
      : "";
  const graphqlUnsupportedBanner =
    isGraphql && !isGraphqlSupported(config.language)
      ? `
> ⚠️ **GraphQL not yet generated for ${langEmoji[config.language]}.** Helios emitted a REST server instead.
> GraphQL support lands first for Go (gqlgen), TypeScript (graphql-yoga), and Python (Strawberry) — switch the
> stack language if you need a working GraphQL bootstrap, or keep this repo on REST.
`
      : "";
  const name = safeName(config.name);
  const pkg = name.replace(/-/g, "_") + ".v1";

  // For gRPC we replace the REST-shaped "Endpoints" table with a gRPC-specific
  // section (services list, proto path, grpcurl smoke test). When gRPC was
  // requested on an unsupported language we actually emit REST, so fall
  // through to the REST section — the banner above explains why.
  const apiSection = isGrpc && isGrpcSupported(config.language)
    ? `## gRPC services

Proto at \`proto/${pkg.split(".")[0]}/v1/service.proto\`. After editing the proto, regenerate client/server stubs:

\`\`\`bash
make proto
\`\`\`

Smoke-test the running server with [grpcurl](https://github.com/fullstorydev/grpcurl):

\`\`\`bash
# Overall health
grpcurl -plaintext localhost:8080 grpc.health.v1.Health/Check

# List services (requires reflection, enabled by default)
grpcurl -plaintext localhost:8080 list
\`\`\`
`
    : isGraphql && isGraphqlSupported(config.language)
    ? `## GraphQL

Schema at \`graphql/schema.graphql\`. The server reads the SDL at startup; mutate the schema and your resolvers
must follow.

\`\`\`bash
# Local development
curl -s http://localhost:8080/graphql \\
  -H 'Content-Type: application/json' \\
  -d '{"query":"{ health }"}'
\`\`\`

GraphiQL/Playground is mounted at \`/\` (Go) or \`/graphql\` (TypeScript / Python — yoga + Strawberry serve their
own UI alongside the endpoint). Open it in a browser to explore queries against your entities.
`
    : `## Endpoints

| Method | Path | Summary | Auth |
| --- | --- | --- | --- |
${ep || "| — | — | _no endpoints defined_ | — |"}
`;

  return `# ${config.name}

[![Built with Helios](https://img.shields.io/badge/Built%20with-Helios-6366f1?logo=lightning&logoColor=white)](https://helios.app)

Generated by **[Helios](https://helios.app)** — an AI-native backend generator.

> ${langEmoji[config.language]} · ${config.framework} · ${config.database} · ${config.cache} · ${config.api.toUpperCase()} · ${config.deployment}
${grpcUnsupportedBanner}${graphqlUnsupportedBanner}
## Quickstart

\`\`\`bash
cp .env.example .env
${config.docker ? "docker compose up --build" : meta.devCommand}
\`\`\`

## Scripts

| Command | Purpose |
| --- | --- |
| \`${meta.devCommand}\` | Run locally with hot reload |
| \`${meta.runCommand}\` | Start the API server |
| \`${meta.testCommand}\` | Run the test suite |

${apiSection}
## Deploy

Target: **${config.deployment}** · Region: \`${config.region}\` · Baseline replicas: ${config.replicas}${config.autoscale ? " (autoscaling enabled)" : ""}.

${deployBullets(config).join("\n")}

${authReadmeSection(config)}## Observability

${observabilityClaims(config).join("\n")}
`;
}

function deployBullets(config: StackConfig): string[] {
  const b: string[] = [];
  if (config.docker) b.push("- Dockerfile and docker-compose at the repo root");
  if (config.kubernetes) b.push("- Kubernetes manifests under `deploy/k8s/`");
  if (config.helm) b.push("- Helm chart under `deploy/helm/`");
  if (config.deployment === "aws") b.push("- ECS Fargate task definition at `deploy/aws/task-definition.json`");
  if (config.deployment === "gcp") b.push("- Cloud Run service at `deploy/gcp/service.yaml`");
  if (config.deployment === "azure") b.push("- Azure Container App at `deploy/azure/containerapp.yaml`");
  b.push(`- CI: ${ciLocation(config)}`);
  if (config.cicd === "argo" && (config.kubernetes || config.helm)) b.push("- Argo CD Application at `deploy/argocd/application.yaml`");
  return b;
}

function ciLocation(config: StackConfig): string {
  if (config.cicd === "gitlab-ci") return "GitLab CI at `.gitlab-ci.yml` (test + image push to the GitLab registry)";
  if (config.cicd === "circleci") return "CircleCI at `.circleci/config.yml`";
  return "GitHub Actions under `.github/workflows/`";
}

// Only claim what the generated code actually does. Go/TS/Python wire the
// monitoring SDK, OTLP tracing and rate limiting themselves; Rust/Java/Kotlin
// only expose Prometheus metrics (for `grafana`).
function observabilityClaims(config: StackConfig): string[] {
  const lang = config.language;
  const full = hasAppObservability(lang);
  const out: string[] = [];
  switch (config.monitoring) {
    case "grafana":
      out.push(`- Prometheus metrics at \`${metricsPath(config)}\`; \`deploy/prometheus.yml\` + a Grafana datasource are included${config.docker ? " and run via docker compose (Grafana on :3000)" : ""}.`);
      // gRPC servers expose metrics on a separate plain-HTTP listener, not the gRPC port.
      if (config.api === "grpc" && isGrpcSupported(lang)) {
        out.push("- gRPC: metrics are served on `:9464/metrics` (`METRICS_PORT`), not the gRPC port; `deploy/prometheus.yml` already scrapes `api:9464`.");
      }
      break;
    case "datadog":
      out.push(lang === "rust"
        ? "- Datadog: traces are exported via OTLP to the Datadog Agent; agent setup in `SETUP_MONITORING.md`."
        : lang === "kotlin"
        ? "- Datadog: metrics are shipped via Micrometer's Datadog registry (no traces); agent setup in `SETUP_MONITORING.md`."
        : full
        ? "- Datadog tracer initialised at startup; agent setup in `SETUP_MONITORING.md`."
        : "- Datadog: agent config and setup steps in `SETUP_MONITORING.md` — the tracer is not wired into the code yet.");
      break;
    case "sentry":
      out.push(full
        ? "- Sentry SDK initialised from `SENTRY_DSN`."
        : "- Sentry: setup steps in `SETUP_MONITORING.md` — the SDK is not wired into the code yet.");
      break;
    case "newrelic":
      out.push("- New Relic: `deploy/newrelic.yml` is provided; attach the New Relic agent for your runtime to use it.");
      break;
    case "otel":
      out.push(`- OpenTelemetry Collector config at \`deploy/otel-collector.yaml\`${config.docker ? " (runs in docker compose, OTLP on :4317/:4318)" : ""}.`);
      break;
  }
  if (config.tracing) {
    out.push(full
      ? "- OpenTelemetry traces are exported via OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT`."
      : `- Tracing: not generated for ${langEmoji[lang]} yet.`);
  }
  if (config.rateLimit) {
    out.push(full ? "- Per-client rate limiting is enabled." : `- Rate limiting: not generated for ${langEmoji[lang]} yet.`);
  }
  if (config.audit) {
    out.push("- Audit logs are emitted for every mutating request.");
  }
  return out.length > 0 ? out : ["- No monitoring provider selected."];
}

function authReadmeSection(config: StackConfig): string {
  const spec = authProviderSpec(config);
  if (!spec) return "";

  const envLines = [
    `- \`${spec.issuerEnv}\` — e.g. \`${spec.issuerExample}\``,
    `- \`${spec.jwksUrlEnv}\` — e.g. \`${spec.jwksUrlExample}\``,
  ];
  if (spec.audienceEnv) {
    envLines.push(`- \`${spec.audienceEnv}\` — optional; when set, the middleware rejects tokens with a mismatched \`aud\` claim.`);
  }

  // Per-language pointer to the generated auth wiring.
  const hookNotes: Record<StackConfig["language"], string> = {
    go: `Generated in \`internal/auth/jwt.go\`. Routes tagged \`auth: true\` wear the \`authRequired\` middleware automatically.`,
    typescript:
      config.framework === "nestjs"
        ? `Generated in \`src/auth/jwt.guard.ts\`. Apply via \`@UseGuards(JwtAuthGuard)\` on controllers or globally in \`main.ts\`.`
        : `Generated in \`src/middleware/auth.ts\`. Apply via \`app.use(authRequired)\` or per-route as a middleware argument.`,
    python: `Generated in \`app/auth.py\`. Add \`claims: dict = Depends(auth_required)\` to any FastAPI route handler.`,
    rust: `Generated in \`src/auth.rs\` (jsonwebtoken + JWKS fetched from \`AUTH_JWKS_URL\`). Routes tagged \`auth: true\` and all entity CRUD routes require a valid Bearer token.`,
    java:
      config.framework === "quarkus"
        ? `SmallRye JWT (\`quarkus-smallrye-jwt\`) verifies tokens against \`AUTH_JWKS_URL\` (RS256). Resources and routes tagged \`auth: true\` carry \`@Authenticated\`.`
        : `Spring Security with \`spring-boot-starter-oauth2-resource-server\` is configured in \`SecurityConfig.java\`. Everything except \`/health\` requires a valid JWT.`,
    kotlin:
      config.framework === "ktor"
        ? `Generated in \`src/main/kotlin/Auth.kt\` (\`ktor-server-auth-jwt\` with a cached JWKS provider). Routes tagged \`auth: true\` and all entity routes sit inside \`authenticate("auth-jwt")\`.`
        : `Spring Security with \`spring-boot-starter-oauth2-resource-server\` is configured in \`SecurityConfig.kt\`. Everything except \`/health\` requires a valid JWT.`,
  };

  return `## Authentication

Using **${spec.label}**. Configure these env vars in \`.env\` (and in your Kubernetes Secret at deploy time):

${envLines.join("\n")}

${spec.notes}

${hookNotes[config.language]}

`;
}

function quickstart(config: StackConfig): string {
  const name = safeName(config.name);
  const meta = languageMeta[config.language];

  const prerequisites: Record<StackConfig["language"], string> = {
    go: `- [Go 1.23+](https://go.dev/dl/)
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
    typescript: `- [Node.js 22+](https://nodejs.org/)
- [npm 10+](https://www.npmjs.com/) (bundled with Node)
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
    python: `- [Python 3.12+](https://www.python.org/downloads/)
- [uv](https://docs.astral.sh/uv/) (recommended) or \`pip\`
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
    rust: `- [Rust (stable)](https://rustup.rs/)
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
    java: `- [Java 21+](https://adoptium.net/) (Eclipse Temurin recommended)
- [Maven](https://maven.apache.org/) (or use the \`./mvnw\` wrapper)
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
    kotlin: `- [Java 21+](https://adoptium.net/) (Eclipse Temurin recommended)
- [Gradle](https://gradle.org/) (or use the \`./gradlew\` wrapper)
- [Docker](https://docs.docker.com/get-docker/) (optional, for running dependencies)`,
  };

  const migrationStep: Record<StackConfig["language"], string> = {
    typescript: `npx prisma migrate dev`,
    go: `go run ./cmd/migrate`,
    python: `alembic upgrade head`,
    rust: `cargo run --bin migrate`,
    java: `./mvnw flyway:migrate`,
    kotlin: `./gradlew flywayMigrate`,
  };

  const dbDependencies = composeServices(config).filter((s) => s.gate !== null).map((s) => s.name);

  const step3Docker = config.docker && dbDependencies.length > 0
    ? `\`\`\`bash
docker compose up -d ${dbDependencies.join(" ")}
\`\`\``
    : manualDepsInstructions(config);

  const envVarDocs = buildEnvVarDocs(config);

  return `# Quickstart — ${config.name}

Zero to running server in under 5 minutes.

## Prerequisites

${prerequisites[config.language]}

---

## Step 1: Unzip and enter the project

\`\`\`bash
unzip ${name}.zip
cd ${name}
\`\`\`

---

## Step 2: Install dependencies

\`\`\`bash
${meta.installCommand}
\`\`\`

---

## Step 3: Set up environment variables

\`\`\`bash
cp .env.example .env
\`\`\`

Open \`.env\` and fill in the following values:

${envVarDocs}

---

## Step 4: Start dependencies

${step3Docker}

---

## Step 5: Run database migrations

\`\`\`bash
${migrationStep[config.language]}
\`\`\`

---

## Step 6: Start the development server

\`\`\`bash
${meta.devCommand}
\`\`\`

The server will be available at **http://localhost:8080**.

---

## Step 7: Test the API

\`\`\`bash
curl http://localhost:8080/health
\`\`\`

Expected response: \`{"status":"ok"}\`

---

## Troubleshooting

**Port 8080 already in use**
Change \`PORT\` in your \`.env\` file, or find and stop the conflicting process:
\`\`\`bash
lsof -i :8080
kill -9 <PID>
\`\`\`

**Database connection refused**
${config.docker
    ? "Make sure the database container is running: `docker compose ps`\nIf it exited, check logs: `docker compose logs db`"
    : `Ensure your database is running and that \`DATABASE_URL\` (or the equivalent) in \`.env\` points to the correct host and port.`}

**\`DATABASE_URL\` not found / missing env variable**
Run \`cp .env.example .env\` and verify all required variables are set. The server will not start with missing required env vars.

**Dependency install errors**
${config.language === "typescript"
    ? "Delete `node_modules` and `package-lock.json`, then run `npm install` again."
    : config.language === "go"
    ? "Run `go mod tidy` to synchronise the module graph, then retry."
    : config.language === "python"
    ? "Ensure you are using Python 3.12+. Run `uv sync` (or `pip install -e '.[dev]'`) in a clean virtual environment."
    : config.language === "rust"
    ? "Run `cargo clean && cargo build` to force a full rebuild."
    : "Check that Java 21+ is on your PATH and that the wrapper script is executable (`chmod +x ./mvnw` or `chmod +x ./gradlew`)."}
`;
}

function buildEnvVarDocs(config: StackConfig): string {
  const lines: string[] = [];

  const dbUrl = databaseUrl(config);
  if (dbUrl) {
    lines.push(`| \`DATABASE_URL\` | \`${dbUrl}\` | ${config.database} connection string${isJvm(config.language) ? " (JDBC format)" : ""} |`);
  } else if (config.database === "dynamodb") {
    lines.push(`| \`AWS_ENDPOINT_URL_DYNAMODB\` | \`http://localhost:8000\` | DynamoDB Local endpoint — remove in production to use real AWS |`);
  } else if (config.database === "mongodb") {
    lines.push(`| \`MONGODB_URI\` | \`mongodb://localhost:27017/${safeName(config.name)}\` | MongoDB connection URI |`);
  } else if (config.database === "sqlite") {
    lines.push(`| \`DATABASE_URL\` | \`file:./app.db\` | Path to the SQLite file |`);
  }

  if (isRedisLike(config.cache) || config.queue === "bullmq") {
    lines.push(`| \`REDIS_URL\` | \`redis://localhost:6379\` | Redis connection URL (Dragonfly speaks the Redis protocol — same URL format). For Upstash, get from the Upstash console |`);
  } else if (config.cache === "memcached") {
    lines.push(`| \`MEMCACHED_URL\` | \`localhost:11211\` | Memcached server address |`);
  }

  if (config.queue === "rabbitmq") {
    lines.push(`| \`RABBITMQ_URL\` | \`amqp://app:app@localhost:5672\` | RabbitMQ AMQP connection URL |`);
  } else if (config.queue === "kafka" || config.queue === "redpanda") {
    lines.push(`| \`KAFKA_BROKERS\` | \`localhost:9092\` | Comma-separated list of Kafka broker addresses |`);
  } else if (config.queue === "nats") {
    lines.push(`| \`NATS_URL\` | \`nats://localhost:4222\` | NATS server URL |`);
  } else if (config.queue === "sqs") {
    lines.push(`| \`AWS_ENDPOINT_URL_SQS\` | \`http://localhost:9324\` | ElasticMQ (local SQS) endpoint — remove in production |`);
  }

  if (emitsOtel(config)) {
    lines.push(`| \`OTEL_EXPORTER_OTLP_ENDPOINT\` | \`http://localhost:4318\` | OTLP/HTTP endpoint that receives traces |`);
    lines.push(`| \`OTEL_SERVICE_NAME\` | \`${safeName(config.name)}\` | service.name attached to every span |`);
  }

  const authSpec = authProviderSpec(config);
  if (authSpec) {
    lines.push(
      `| \`${authSpec.issuerEnv}\` | \`${authSpec.issuerExample}\` | Expected JWT \`iss\` claim for ${authSpec.label}. |`,
      `| \`${authSpec.jwksUrlEnv}\` | \`${authSpec.jwksUrlExample}\` | JWKS endpoint for RS256/ES256 public-key fetch. |`
    );
    if (authSpec.audienceEnv) {
      lines.push(
        `| \`${authSpec.audienceEnv}\` | \`your-api-audience\` | Expected JWT \`aud\` claim. Optional — leave unset to skip audience checking. |`
      );
    }
  }

  if (config.monitoring === "sentry") {
    lines.push(`| \`SENTRY_DSN\` | \`https://...@sentry.io/...\` | From your Sentry project → Settings → Client Keys |`);
  } else if (config.monitoring === "datadog") {
    lines.push(`| \`DD_API_KEY\` | \`...\` | From the [Datadog API keys page](https://app.datadoghq.com/organization-settings/api-keys) |`);
  }

  for (const v of config.envVars) {
    const looksSensitive = looksLikeSecretValue(v.key, v.value);
    const shouldRedact = v.secret !== false || looksSensitive;
    lines.push(`| \`${toEnvKey(v.key)}\` | \`${shouldRedact ? "change-me" : v.value}\` | Custom variable |`);
  }

  if (lines.length === 0) {
    return `| Variable | Example | Notes |
| --- | --- | --- |
| \`APP_NAME\` | \`${config.name}\` | Application name shown in logs |
| \`PORT\` | \`8080\` | Port the server listens on |`;
  }

  return `| Variable | Example | Notes |
| --- | --- | --- |
| \`APP_NAME\` | \`${config.name}\` | Application name shown in logs |
| \`PORT\` | \`8080\` | Port the server listens on |
${lines.join("\n")}`;
}

function manualDepsInstructions(config: StackConfig): string {
  const parts: string[] = [];

  if (/postgres|neon|supabase|cockroach/.test(config.database)) {
    parts.push(`**PostgreSQL**: Install and start PostgreSQL 16, then create the database:
\`\`\`bash
createdb ${safeName(config.name)}
\`\`\``);
  } else if (config.database === "mysql" || config.database === "planetscale") {
    parts.push(`**MySQL**: Install and start MySQL 8, then create the database:
\`\`\`bash
mysql -u root -e "CREATE DATABASE IF NOT EXISTS ${safeName(config.name)};"
\`\`\``);
  } else if (config.database === "mongodb") {
    parts.push(`**MongoDB**: Install and start MongoDB 7. The database will be created automatically on first write.`);
  } else if (config.database === "sqlite") {
    parts.push(`**SQLite**: No separate service needed — the database file will be created automatically.`);
  }

  if (config.cache === "redis" || config.cache === "upstash") {
    parts.push(`**Redis**: Install and start Redis 7.`);
  } else if (config.cache === "memcached") {
    parts.push(`**Memcached**: Install and start Memcached 1.6.`);
  }

  if (config.queue === "rabbitmq") {
    parts.push(`**RabbitMQ**: Install and start RabbitMQ 3.`);
  } else if (config.queue === "kafka") {
    parts.push(`**Kafka / Redpanda**: Install and start Redpanda or Kafka. The default broker address is \`localhost:9092\`.`);
  } else if (config.queue === "nats") {
    parts.push(`**NATS**: Install and start NATS 2 with JetStream enabled (\`nats-server -js\`).`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "No external dependencies required.";
}

function deployGuide(config: StackConfig): string {
  return deployGuideBody(config) + ciDeploySection(config);
}

function deployGuideBody(config: StackConfig): string {
  const name = safeName(config.name);

  const envVarList = buildDeployEnvVarList(config);

  switch (config.deployment) {
    case "vercel":
      return `# Deploy to Vercel
${vercelSupported(config) ? "" : `\n> **Warning:** ${config.language}/${config.framework}${config.api === "grpc" ? " (gRPC)" : ""} cannot run on Vercel — it only runs serverless Node frameworks and FastAPI, not this Dockerfile. Pick Railway, Render, Fly or a container platform instead.\n`}

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli): \`npm i -g vercel\`
- A Vercel account

## Steps

### 1. Link the project

\`\`\`bash
vercel link
\`\`\`

Follow the prompts to connect to your Vercel account and project.

### 2. Add environment variables

\`\`\`bash
${envVarList.map((v) => `vercel env add ${v}`).join("\n")}
\`\`\`

Repeat for \`preview\` and \`production\` environments as prompted.

### 3. Deploy to production

\`\`\`bash
vercel deploy --prod
\`\`\`

### 4. Verify

\`\`\`bash
curl https://<your-vercel-url>/health
\`\`\`

## Notes

- Vercel runs serverless functions; long-lived connections (WebSockets, persistent DB pools) need extra consideration.
- Set \`VERCEL_REGION\` if you need a specific deployment region.
`;

    case "railway":
      return `# Deploy to Railway

## Prerequisites

- [Railway CLI](https://docs.railway.app/develop/cli): \`npm i -g @railway/cli\`
- A Railway account

## Steps

### 1. Login and initialise

\`\`\`bash
railway login
railway link
\`\`\`

### 2. Add a Postgres plugin (if needed)

In the Railway dashboard, open your project → **New** → **Database** → **PostgreSQL**.
Copy the \`DATABASE_URL\` it generates and set it in the next step.

### 3. Set environment variables

\`\`\`bash
${envVarList.map((v) => `railway variables set ${v}=<value>`).join("\n")}
\`\`\`

### 4. Deploy

\`\`\`bash
railway up
\`\`\`

Railway auto-detects the Dockerfile and builds it.

### 5. Open the deployed service

\`\`\`bash
railway open
\`\`\`

## Notes

- Railway uses the \`PORT\` env var automatically — make sure your app reads it.
- Run \`railway logs\` to tail live logs.
`;

    case "render":
      return `# Deploy to Render

## Prerequisites

- A [Render](https://render.com) account
- Your repo pushed to GitHub or GitLab

## Steps

### 1. Create a Web Service

1. Go to the Render dashboard → **New** → **Web Service**.
2. Connect your GitHub repository.
3. Set **Environment** to **Docker** (Render auto-detects the Dockerfile).
4. Set **Region** to \`${config.region}\`.

### 2. Add environment variables

In the **Environment** tab of your Render service, add:

${envVarList.map((v) => `- \`${v}\``).join("\n")}

### 3. Add a Postgres / Redis instance (if needed)

1. Render dashboard → **New** → **PostgreSQL** (or Redis).
2. Copy the internal connection URL.
3. Paste it as \`DATABASE_URL\` (or \`REDIS_URL\`) in your service's environment variables.

### 4. Deploy

CI triggers a deploy of each pushed commit (see **Continuous deployment** below) — turn the service's Auto-Deploy off so commits aren't deployed twice. To trigger manually:

\`\`\`bash
curl -X POST https://api.render.com/v1/services/<service-id>/deploys -H "Authorization: Bearer $RENDER_API_KEY"
\`\`\`

## Notes

- Use Render's **Internal** connection strings for DB/cache to avoid egress charges.
- Set health-check path to \`/health\` in the service settings.
`;

    case "fly":
      return `# Deploy to Fly.io

## Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/): \`curl -L https://fly.io/install.sh | sh\`
- A Fly.io account

## Steps

### 1. Create the app

\`\`\`bash
flyctl apps create ${name}
\`\`\`

\`fly.toml\` (region \`${providerRegion(config, "fly")}\`, health check, machine size) is already committed.

### 2. Create a Postgres cluster (if needed)

\`\`\`bash
flyctl postgres create --name ${name}-db --region ${providerRegion(config, "fly")}
flyctl postgres attach --app ${name} ${name}-db
\`\`\`

Fly sets \`DATABASE_URL\` in your app's secrets automatically.

### 3. Set secrets

\`\`\`bash
${envVarList.map((v) => `flyctl secrets set ${v}=<value> --app ${name}`).join("\n")}
\`\`\`

### 4. Deploy

\`\`\`bash
flyctl deploy --app ${name}
\`\`\`

### 5. Verify

\`\`\`bash
flyctl status --app ${name}
curl https://${name}.fly.dev/health
\`\`\`

## Notes

- Scale replicas: \`flyctl scale count ${config.replicas} --app ${name}\`
- View logs: \`flyctl logs --app ${name}\`
`;

    case "aws":
      return `# Deploy to AWS (ECR + App Runner / ECS Fargate)

## Prerequisites

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with appropriate credentials
- Docker

## Steps

### 1. Create an ECR repository

\`\`\`bash
aws ecr create-repository --repository-name ${name} --region ${config.region}
\`\`\`

### 2. Build and push the image

\`\`\`bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY=$ACCOUNT.dkr.ecr.${config.region}.amazonaws.com

aws ecr get-login-password --region ${config.region} | \\
  docker login --username AWS --password-stdin $REGISTRY

docker build -t ${name} .
docker tag ${name}:latest $REGISTRY/${name}:latest
docker push $REGISTRY/${name}:latest
\`\`\`

### 3a. Deploy via App Runner (simpler)

\`\`\`bash
aws apprunner create-service \\
  --service-name ${name} \\
  --source-configuration "ImageRepository={ImageIdentifier=$REGISTRY/${name}:latest,ImageRepositoryType=ECR}" \\
  --instance-configuration "Cpu=1 vCPU,Memory=2 GB"
\`\`\`

### 3b. Deploy via ECS Fargate (more control)

The task definition lives at \`deploy/aws/task-definition.json\`. Secrets are read from SSM Parameter Store
under \`/${name}/<VAR>\`:

\`\`\`bash
export AWS_ACCOUNT_ID=$ACCOUNT
${envVarList.filter((v) => v !== "APP_NAME" && v !== "PORT").map((v) => `aws ssm put-parameter --region ${config.region} --type SecureString --name /${name}/${v} --value "<value>"`).join("\n")}

aws logs create-log-group --region ${config.region} --log-group-name /ecs/${name}
envsubst < deploy/aws/task-definition.json > /tmp/task-definition.json
aws ecs register-task-definition --region ${config.region} --cli-input-json file:///tmp/task-definition.json

aws ecs create-cluster --region ${config.region} --cluster-name ${name}
aws ecs create-service --region ${config.region} --cluster ${name} --service-name ${name} \\
  --task-definition ${name} --desired-count ${config.replicas} --launch-type FARGATE \\
  --network-configuration "awsvpcConfiguration={subnets=[subnet-XXXX],securityGroups=[sg-XXXX],assignPublicIp=ENABLED}"
\`\`\`

## Notes

- \`ecsTaskExecutionRole\` needs \`AmazonECSTaskExecutionRolePolicy\` plus \`ssm:GetParameters\` on \`arn:aws:ssm:${config.region}:$AWS_ACCOUNT_ID:parameter/${name}/*\`.
- Use an Application Load Balancer in front of Fargate for HTTPS termination.
`;

    case "gcp":
      return `# Deploy to GCP (Artifact Registry + Cloud Run)

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) authenticated
- Docker

## Steps

### 1. Enable required APIs

\`\`\`bash
gcloud services enable artifactregistry.googleapis.com run.googleapis.com
\`\`\`

### 2. Create an Artifact Registry repository

\`\`\`bash
gcloud artifacts repositories create ${name} \\
  --repository-format=docker \\
  --location=${providerRegion(config, "gcp")}
\`\`\`

### 3. Build and push the image

\`\`\`bash
PROJECT=$(gcloud config get-value project)
REGISTRY=${providerRegion(config, "gcp")}-docker.pkg.dev/$PROJECT/${name}

gcloud auth configure-docker ${providerRegion(config, "gcp")}-docker.pkg.dev
docker build -t ${name} .
docker tag ${name}:latest $REGISTRY/${name}:latest
docker push $REGISTRY/${name}:latest
\`\`\`

### 4. Create secrets and deploy to Cloud Run

The service is defined in \`deploy/gcp/service.yaml\` (min ${minInstances(config)} / max ${maxInstances(config)} instances). Each secret env var reads
the \`latest\` version of a Secret Manager secret:

\`\`\`bash
${envVarList.filter((v) => v !== "APP_NAME" && v !== "PORT").map((v) => `printf '%s' "<value>" | gcloud secrets create ${secretName(name, v)} --data-file=-`).join("\n")}

export GCP_PROJECT_ID=$PROJECT
envsubst < deploy/gcp/service.yaml > /tmp/service.yaml
gcloud run services replace /tmp/service.yaml --region ${providerRegion(config, "gcp")}
gcloud run services add-iam-policy-binding ${name} --region ${providerRegion(config, "gcp")} \\
  --member=allUsers --role=roles/run.invoker
\`\`\`

### 5. Verify

\`\`\`bash
gcloud run services describe ${name} --region ${providerRegion(config, "gcp")} --format "value(status.url)"
\`\`\`

## Notes

- The Cloud Run service account needs \`roles/secretmanager.secretAccessor\` on the secrets above.
`;

    case "azure":
      return `# Deploy to Azure (Container Registry + Container Apps)

## Prerequisites

- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) authenticated
- Docker

## Steps

### 1. Create a resource group and Container Registry

\`\`\`bash
az group create --name ${name}-rg --location ${providerRegion(config, "azure")}
az acr create --resource-group ${name}-rg --name ${acrName(name)} --sku Basic --admin-enabled true
\`\`\`

### 2. Build and push the image

\`\`\`bash
az acr login --name ${acrName(name)}
docker build -t ${name}:latest .
docker tag ${name}:latest ${acrName(name)}.azurecr.io/${name}:latest
docker push ${acrName(name)}.azurecr.io/${name}:latest
\`\`\`

### 3. Create a Container Apps environment

\`\`\`bash
az containerapp env create \\
  --name ${name}-env \\
  --resource-group ${name}-rg \\
  --location ${providerRegion(config, "azure")}
\`\`\`

### 4. Deploy the Container App

\`deploy/azure/containerapp.yaml\` declares ingress, secrets and scale (min ${minInstances(config)} / max ${maxInstances(config)} replicas).
Secret values are substituted from your shell environment, so they never land in git:

\`\`\`bash
set -a; . ./.env; set +a
export AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
export ACR_PASSWORD=$(az acr credential show --name ${acrName(name)} --query "passwords[0].value" -o tsv)
envsubst < deploy/azure/containerapp.yaml > /tmp/containerapp.yaml
az containerapp create --name ${name} --resource-group ${name}-rg --yaml /tmp/containerapp.yaml
\`\`\`

## Notes

- Use Azure Key Vault for secrets and reference them via Container Apps secrets.
- Enable managed identity for seamless access to other Azure services.
`;

    case "k8s":
      return `# Deploy to Kubernetes

## Prerequisites

- \`kubectl\` configured to point at your target cluster
- Docker registry access (the manifests default to \`ghcr.io/${config.owner || "your-org"}/${name}\`)
- \`make\` installed (optional — commands also work standalone)

## Steps

### 1. Build and push your image

\`\`\`bash
docker build -t ghcr.io/${config.owner || "your-org"}/${name}:latest .
docker push ghcr.io/${config.owner || "your-org"}/${name}:latest
\`\`\`

### 2. Prepare secrets

Copy the secrets template and fill in real values locally. The file \`deploy/k8s/secrets.env\` is gitignored — **never commit it**.

\`\`\`bash
cp deploy/k8s/secrets.example.env deploy/k8s/secrets.env
$EDITOR deploy/k8s/secrets.env
\`\`\`

### 3. Deploy

The generated \`deploy/k8s/Makefile\` drives the whole rollout:

\`\`\`bash
make -C deploy/k8s all
\`\`\`

This creates the namespace, applies the Secret from \`secrets.env\` (without putting values on your shell command line), applies the manifests, and waits for the rollout to become ready.

If you'd rather run the individual steps:

\`\`\`bash
make -C deploy/k8s namespace   # create namespace
make -C deploy/k8s secrets     # sync secrets.env → Kubernetes Secret
make -C deploy/k8s apply       # apply deployment + service + hpa
make -C deploy/k8s rollout     # wait for rollout
\`\`\`

### 4. Verify and access

\`\`\`bash
make -C deploy/k8s logs
make -C deploy/k8s port-forward   # localhost:8080 → service
curl http://localhost:8080/health
\`\`\`

${config.helm ? `### 5. Alternatively, deploy via Helm

The generated chart declares **Bitnami** charts (PostgreSQL/MySQL/MongoDB/Redis/RabbitMQ — whichever applies) as dependencies via Artifact Hub. Fetch them once, then install:

\`\`\`bash
helm dependency update ./deploy/helm
helm upgrade --install ${name} ./deploy/helm \\
  --namespace ${name} \\
  --create-namespace \\
  --set image.tag=latest
\`\`\`

If you're using a managed database (RDS, Cloud SQL, Neon, …), disable the bundled chart in \`deploy/helm/values.yaml\`:

\`\`\`yaml
postgresql:
  enabled: false   # then set DATABASE_URL via the app's Secret
\`\`\`
` : ""}
## Notes

- CI pins \`deploy/k8s/deployment.yaml\` to the commit's image tag at deploy time; for manual deploys set it yourself.
- For ingress, add an \`Ingress\` resource or use your cluster's load balancer service type.
- Enable HPA by applying \`deploy/k8s/hpa.yaml\` (${config.autoscale ? "already included" : "set `autoscale: true` in your config to generate it"}).
- The \`secrets.env\` file is gitignored; rotate values there and re-run \`make -C deploy/k8s secrets\` to update the cluster Secret in place.
`;

    default:
      return `# Deployment Guide

Target: **${config.deployment}**

Refer to your deployment provider's documentation. The generated \`Dockerfile\` and \`docker-compose.yml\` are the recommended starting points.

Ensure all environment variables from \`.env.example\` are set in your target environment before deploying.
`;
  }
}

function buildDeployEnvVarList(config: StackConfig): string[] {
  const vars: string[] = ["APP_NAME", "PORT"];

  if (/postgres|neon|supabase|cockroach/.test(config.database)) {
    vars.push("DATABASE_URL");
  } else if (config.database === "mysql" || config.database === "planetscale") {
    vars.push("DATABASE_URL");
  } else if (config.database === "mongodb") {
    vars.push("MONGODB_URI");
  } else if (config.database === "sqlite") {
    vars.push("DATABASE_URL");
  }

  if (isRedisLike(config.cache) || config.queue === "bullmq") {
    vars.push("REDIS_URL");
  } else if (config.cache === "memcached") {
    vars.push("MEMCACHED_URL");
  }

  if (config.queue === "rabbitmq") {
    vars.push("RABBITMQ_URL");
  } else if (config.queue === "kafka" || config.queue === "redpanda") {
    vars.push("KAFKA_BROKERS");
  } else if (config.queue === "nats") {
    vars.push("NATS_URL");
  }

  if (emitsOtel(config)) {
    vars.push("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_SERVICE_NAME");
  }

  const authSpec = authProviderSpec(config);
  if (authSpec) {
    for (const v of authSpec.envVars) vars.push(v);
  }

  if (config.monitoring === "sentry") {
    vars.push("SENTRY_DSN");
  } else if (config.monitoring === "datadog") {
    vars.push("DD_API_KEY");
  }

  for (const v of config.envVars) {
    vars.push(toEnvKey(v.key));
  }

  return vars;
}

function envExample(config: StackConfig, endpoints: Endpoint[]) {
  const lines = [
    `# ─── Runtime ──────────────────────────────────────────────────────────────────`,
    `# APP_NAME — human-readable name shown in logs and health-check responses.`,
    `APP_NAME=${config.name}`,
    `# LOG_LEVEL — verbosity: debug | info | warn | error`,
    `LOG_LEVEL=info`,
    `# PORT — TCP port the HTTP server binds to. Must match the Dockerfile EXPOSE and`,
    `#         the Kubernetes/Railway port mapping.`,
    `PORT=8080`,
    ``,
  ];

  if (/postgres|neon|supabase/.test(config.database)) {
    const where = config.database === "neon"
      ? "neon.tech → your project → Connection Details"
      : config.database === "supabase"
        ? "supabase.com → your project → Settings → Database"
        : "your local Postgres or any managed provider (Neon, Supabase, Railway)";
    lines.push(`# ─── Database (${config.database}) ───────────────────────────────────────────────────`);
    lines.push(`# DATABASE_URL — Required. PostgreSQL connection string.`);
    lines.push(isJvm(config.language)
      ? `# Format (JDBC): jdbc:postgresql://host:5432/dbname?user=u&password=p&sslmode=require`
      : `# Format: postgres://user:password@host:5432/dbname?sslmode=require`);
    lines.push(`# Get it from: ${where}`);
    lines.push(`DATABASE_URL=${databaseUrl(config)}`);
    lines.push(``);
  } else if (config.database === "cockroach") {
    lines.push(`# ─── Database (CockroachDB) ────────────────────────────────────────────────────`);
    lines.push(`# DATABASE_URL — Required. CockroachDB connection string.`);
    lines.push(`# Format: postgres://root@host:26257/dbname?sslmode=disable (local) or with certs (cloud)`);
    lines.push(`# Get it from: cockroachlabs.com → your cluster → Connect`);
    lines.push(`DATABASE_URL=${databaseUrl(config)}`);
    lines.push(``);
  } else if (config.database === "mysql" || config.database === "planetscale") {
    const where = config.database === "planetscale"
      ? "planetscale.com → your database → Connect"
      : "your local MySQL or a managed provider (PlanetScale, Railway)";
    lines.push(`# ─── Database (${config.database}) ───────────────────────────────────────────────────`);
    lines.push(`# DATABASE_URL — Required. MySQL connection string.`);
    lines.push(isJvm(config.language)
      ? `# Format (JDBC): jdbc:mysql://host:3306/dbname?user=u&password=p`
      : `# Format: mysql://user:password@host:3306/dbname`);
    lines.push(`# Get it from: ${where}`);
    lines.push(`DATABASE_URL=${databaseUrl(config)}`);
    lines.push(``);
  } else if (config.database === "mongodb") {
    lines.push(`# ─── Database (MongoDB) ────────────────────────────────────────────────────────`);
    lines.push(`# MONGODB_URI — Required. MongoDB connection string.`);
    lines.push(`# Format: mongodb+srv://user:password@cluster.mongodb.net/dbname`);
    lines.push(`# Get it from: cloud.mongodb.com → your cluster → Connect → Drivers`);
    lines.push(`MONGODB_URI=mongodb://localhost:27017/${safeName(config.name)}`);
    lines.push(``);
  } else if (config.database === "sqlite") {
    lines.push(`# ─── Database (SQLite) ─────────────────────────────────────────────────────────`);
    lines.push(`# DATABASE_URL — Required. Path to the SQLite database file.`);
    lines.push(`# Note: SQLite is local-only; use Postgres/MySQL for production deployments.`);
    lines.push(`DATABASE_URL=file:./app.db`);
    lines.push(``);
  } else if (config.database === "dynamodb") {
    lines.push(`# ─── Database (DynamoDB) ───────────────────────────────────────────────────────`);
    lines.push(`# Local development runs DynamoDB Local (docker compose up dynamodb). The AWS SDKs`);
    lines.push(`# read AWS_ENDPOINT_URL_DYNAMODB automatically — delete it in production.`);
    lines.push(`AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000`);
    lines.push(``);
  }

  if (config.database === "dynamodb" || config.queue === "sqs") {
    lines.push(`# ─── AWS ───────────────────────────────────────────────────────────────────────`);
    lines.push(`# Local emulators accept any credentials. Use real IAM credentials (or a role) in production.`);
    lines.push(`AWS_REGION=${config.region}`);
    lines.push(`AWS_ACCESS_KEY_ID=local`);
    lines.push(`AWS_SECRET_ACCESS_KEY=local`);
    lines.push(``);
  }

  if (isRedisLike(config.cache) || config.queue === "bullmq") {
    const where = config.cache === "upstash"
      ? "upstash.com → your database → REST API → REDIS_URL"
      : config.cache === "dragonfly"
        ? "your local Dragonfly (docker compose `cache` service) — it speaks the Redis protocol, so any redis:// URL works"
        : "your local Redis (brew install redis) or Upstash/Railway";
    lines.push(`# ─── ${isRedisLike(config.cache) ? `Cache (${config.cache})` : "Redis (BullMQ)"} ─────────────────────────────────────────────────────────`);
    lines.push(`# REDIS_URL — Required. Redis connection string.`);
    lines.push(`# Format: redis://:password@host:6379 (or rediss:// for TLS)`);
    lines.push(`# Get it from: ${where}`);
    lines.push(`REDIS_URL=redis://localhost:6379`);
    lines.push(``);
  } else if (config.cache === "memcached") {
    lines.push(`# ─── Cache (Memcached) ─────────────────────────────────────────────────────────`);
    lines.push(`# MEMCACHED_URL — Required. host:port of your Memcached server.`);
    lines.push(`MEMCACHED_URL=localhost:11211`);
    lines.push(``);
  }

  if (config.queue === "rabbitmq") {
    lines.push(`# ─── Queue (RabbitMQ) ──────────────────────────────────────────────────────────`);
    lines.push(`# RABBITMQ_URL — Required. AMQP connection string.`);
    lines.push(`# Format: amqp://user:password@host:5672/vhost`);
    lines.push(`# Get it from: cloudamqp.com or run locally via docker compose up rabbit`);
    lines.push(`RABBITMQ_URL=amqp://app:app@localhost:5672`);
    lines.push(``);
  } else if (config.queue === "kafka" || config.queue === "redpanda") {
    const label = config.queue === "redpanda" ? "Redpanda" : "Kafka";
    lines.push(`# ─── Queue (${label}) ─────────────────────────────────────────────────────────`);
    lines.push(`# KAFKA_BROKERS — Required. Comma-separated list of broker host:port pairs.`);
    lines.push(`# Get it from: confluent.io → your cluster → Clients, or run Redpanda locally`);
    lines.push(`KAFKA_BROKERS=localhost:9092`);
    lines.push(``);
  } else if (config.queue === "nats") {
    lines.push(`# ─── Queue (NATS) ──────────────────────────────────────────────────────────────`);
    lines.push(`# NATS_URL — Required. NATS server URL.`);
    lines.push(`# Get it from: ngs.synadia.com or run locally: docker run nats`);
    lines.push(`NATS_URL=nats://localhost:4222`);
    lines.push(``);
  } else if (config.queue === "sqs") {
    lines.push(`# ─── Queue (SQS) ───────────────────────────────────────────────────────────────`);
    lines.push(`# Local development runs ElasticMQ (docker compose up sqs). The AWS SDKs read`);
    lines.push(`# AWS_ENDPOINT_URL_SQS automatically — delete it in production.`);
    lines.push(`AWS_ENDPOINT_URL_SQS=http://localhost:9324`);
    lines.push(``);
  }

  if (emitsOtel(config)) {
    lines.push(`# ─── Tracing (OpenTelemetry) ───────────────────────────────────────────────────`);
    lines.push(`# OTEL_EXPORTER_OTLP_ENDPOINT — OTLP/HTTP collector base URL (traces go to /v1/traces).`);
    lines.push(`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`);
    lines.push(`# OTEL_SERVICE_NAME — service.name attached to every span.`);
    lines.push(`OTEL_SERVICE_NAME=${safeName(config.name)}`);
    lines.push(``);
  }

  if (selfIssuesJwt(config, endpoints)) {
    lines.push(`# ─── Auth (self-managed JWT) ───────────────────────────────────────────────────`);
    lines.push(`# JWT_SECRET — Required. HMAC key used to sign and verify HS256 access tokens.`);
    lines.push(`JWT_SECRET=change-me-to-a-long-random-string`);
    lines.push(``);
  }

  const authSpecExample = authProviderSpec(config);
  if (authSpecExample) {
    lines.push(`# ─── Auth (${authSpecExample.label}) ─────────────────────────────────────────────────────`);
    lines.push(`# ${authSpecExample.notes}`);
    lines.push(`# ${authSpecExample.issuerEnv} — Required. JWT issuer claim expected in every incoming token.`);
    lines.push(`${authSpecExample.issuerEnv}=${authSpecExample.issuerExample}`);
    lines.push(`# ${authSpecExample.jwksUrlEnv} — Required. JWKS endpoint to fetch the signing public key.`);
    lines.push(`${authSpecExample.jwksUrlEnv}=${authSpecExample.jwksUrlExample}`);
    if (authSpecExample.audienceEnv) {
      lines.push(`# ${authSpecExample.audienceEnv} — Optional. When set, tokens with a mismatched aud claim are rejected.`);
      lines.push(`${authSpecExample.audienceEnv}=`);
    }
    lines.push(``);
  }

  if (config.monitoring === "sentry") {
    lines.push(`# ─── Monitoring (Sentry) ───────────────────────────────────────────────────────`);
    lines.push(`# SENTRY_DSN — Required. Get it from: sentry.io → your project → Settings → DSN`);
    lines.push(`SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0`);
    lines.push(``);
  } else if (config.monitoring === "datadog") {
    lines.push(`# ─── Monitoring (Datadog) ──────────────────────────────────────────────────────`);
    lines.push(`# DD_API_KEY — Required. Get it from: app.datadoghq.com → Organization Settings → API Keys`);
    lines.push(`DD_API_KEY=`);
    lines.push(``);
  }

  if (config.envVars.length > 0) {
    lines.push(`# ─── Application ───────────────────────────────────────────────────────────────`);
    for (const v of config.envVars) {
      // Default to treating unknown values as secrets — only emit raw values if
      // the user explicitly marked the var as non-secret AND the value doesn't
      // look sensitive. `.env.example` is committed to git, so a single wrong
      // toggle would leak a credential.
      const looksSensitive = looksLikeSecretValue(v.key, v.value);
      const shouldRedact = v.secret !== false || looksSensitive;
      lines.push(`${toEnvKey(v.key)}=${shouldRedact ? "change-me" : v.value}`);
    }
    lines.push(``);
  }

  return lines.join("\n") + "\n";
}

function gitignore(language: StackConfig["language"]) {
  const base = `# env
.env
.env.*
!.env.example

# deploy secrets — never commit real secret values
deploy/k8s/secrets.env
deploy/**/secrets.env

# editor
.idea/
.vscode/
.DS_Store

# build
dist/
out/
build/
coverage/

# logs
*.log
npm-debug.log*
`;
  const langMap: Record<StackConfig["language"], string> = {
    go: "\n# go\n/bin/\n*.test\n*.out\nvendor/\n",
    typescript: "\n# node\nnode_modules/\n.next/\n.nuxt/\n.turbo/\n.tsbuildinfo\n",
    python: "\n# python\n__pycache__/\n*.pyc\n.venv/\nvenv/\n.pytest_cache/\n.mypy_cache/\n.ruff_cache/\n",
    rust: "\n# rust\n/target/\n",
    java: "\n# java\n/target/\n.gradle/\nbuild/\n",
    kotlin: "\n# kotlin\n/target/\n.gradle/\nbuild/\n",
  };
  return base + langMap[language];
}

type ComposeService = {
  name: string;
  // true → api waits for `service_healthy`; false → `service_started`.
  // null → api doesn't depend on it (observability sidecars).
  gate: boolean | null;
  body: string;
  // Overrides for the api container: .env points at localhost for host-side
  // runs, but inside compose each dependency is reachable by service name.
  apiEnv?: Record<string, string>;
};

function healthcheck(test: string): string {
  return `    healthcheck:
      test: ${test}
      interval: 5s
      timeout: 3s
      retries: 10`;
}

// Every dependency service implied by the stack. Deriving `depends_on` from
// this list keeps the two in sync — a dependency can't be referenced without
// a matching service.
function composeServices(config: StackConfig): ComposeService[] {
  const out: ComposeService[] = [];
  const dbName = safeName(config.name);
  const dbUrl = databaseUrl(config, "db");
  const dbEnv = dbUrl ? { DATABASE_URL: dbUrl } : undefined;

  if (/postgres|supabase|neon/.test(config.database)) {
    out.push({ name: "db", gate: true, apiEnv: dbEnv, body: `    image: postgres:16-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-app}
      POSTGRES_DB: \${POSTGRES_DB:-${dbName}}
    ports: ["5432:5432"]
    volumes: [db-data:/var/lib/postgresql/data]
${healthcheck(`["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-app} -d \${POSTGRES_DB:-${dbName}}"]`)}` });
  } else if (config.database === "mysql" || config.database === "planetscale") {
    out.push({ name: "db", gate: true, apiEnv: dbEnv, body: `    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:-app}
      MYSQL_DATABASE: \${MYSQL_DATABASE:-${dbName}}
      MYSQL_USER: \${MYSQL_USER:-app}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-app}
    ports: ["3306:3306"]
    volumes: [db-data:/var/lib/mysql]
${healthcheck(`["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p\${MYSQL_ROOT_PASSWORD:-app}"]`)}` });
  } else if (config.database === "mongodb") {
    out.push({ name: "db", gate: true, apiEnv: { MONGODB_URI: `mongodb://app:app@db:27017/${dbName}?authSource=admin` }, body: `    image: mongo:7
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER:-app}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD:-app}
    ports: ["27017:27017"]
    volumes: [db-data:/data/db]
${healthcheck(`["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]`)}` });
  } else if (config.database === "cockroach") {
    out.push({ name: "db", gate: true, apiEnv: dbEnv, body: `    image: cockroachdb/cockroach:latest-v24.3
    command: start-single-node --insecure
    ports: ["26257:26257", "8081:8080"]
    volumes: [db-data:/cockroach/cockroach-data]
${healthcheck(`["CMD-SHELL", "curl -fsS http://localhost:8080/health?ready=1 || exit 1"]`)}` });
  } else if (config.database === "dynamodb") {
    out.push({ name: "dynamodb", gate: false, apiEnv: { AWS_ENDPOINT_URL_DYNAMODB: "http://dynamodb:8000" }, body: `    image: amazon/dynamodb-local:latest
    command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"]
    ports: ["8000:8000"]` });
  }

  const redisEnv = { REDIS_URL: "redis://cache:6379" };
  if (config.cache === "redis" || config.cache === "upstash") {
    out.push({ name: "cache", gate: true, apiEnv: redisEnv, body: `    image: redis:7-alpine
    ports: ["6379:6379"]
${healthcheck(`["CMD", "redis-cli", "ping"]`)}` });
  } else if (config.cache === "dragonfly") {
    out.push({ name: "cache", gate: true, apiEnv: redisEnv, body: `    image: docker.dragonflydb.io/dragonflydb/dragonfly:latest
    ports: ["6379:6379"]
${healthcheck(`["CMD", "redis-cli", "ping"]`)}` });
  } else if (config.cache === "memcached") {
    out.push({ name: "cache", gate: true, apiEnv: { MEMCACHED_URL: "cache:11211" }, body: `    image: memcached:1.6-alpine
    ports: ["11211:11211"]
${healthcheck(`["CMD-SHELL", "echo stats | nc -w 1 localhost 11211 | grep -q uptime"]`)}` });
  }

  if (config.queue === "rabbitmq") {
    // The default guest user is loopback-only, so it can't be used across
    // containers (or through the published port) — create an app user.
    out.push({ name: "rabbit", gate: true, apiEnv: { RABBITMQ_URL: "amqp://app:app@rabbit:5672" }, body: `    image: rabbitmq:3-management
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: app
    ports: ["5672:5672", "15672:15672"]
${healthcheck(`["CMD", "rabbitmq-diagnostics", "-q", "ping"]`)}` });
  } else if (config.queue === "kafka") {
    // Two listeners: kafka:29092 for containers, localhost:9092 for the host.
    out.push({ name: "kafka", gate: false, apiEnv: { KAFKA_BROKERS: "kafka:29092" }, body: `    image: redpandadata/redpanda:latest
    command: redpanda start --overprovisioned --smp 1 --memory 512M --reserve-memory 0M --node-id 0 --check=false --kafka-addr internal://0.0.0.0:29092,external://0.0.0.0:9092 --advertise-kafka-addr internal://kafka:29092,external://localhost:9092
    ports: ["9092:9092"]` });
  } else if (config.queue === "nats") {
    out.push({ name: "nats", gate: false, apiEnv: { NATS_URL: "nats://nats:4222" }, body: `    image: nats:2-alpine
    command: ["-js"]
    ports: ["4222:4222"]` });
  } else if (config.queue === "sqs") {
    out.push({ name: "sqs", gate: false, apiEnv: { AWS_ENDPOINT_URL_SQS: "http://sqs:9324" }, body: `    image: softwaremill/elasticmq-native:latest
    ports: ["9324:9324", "9325:9325"]` });
  } else if (config.queue === "bullmq" && !isRedisLike(config.cache)) {
    // BullMQ is Redis-backed; reuse the cache when it already speaks Redis.
    out.push({ name: "redis", gate: true, apiEnv: { REDIS_URL: "redis://redis:6379" }, body: `    image: redis:7-alpine
    ports: ["6379:6379"]
${healthcheck(`["CMD", "redis-cli", "ping"]`)}` });
  }

  if (config.monitoring === "grafana") {
    out.push({ name: "prometheus", gate: null, body: `    image: prom/prometheus:v2.54.1
    volumes: ["./deploy/prometheus.yml:/etc/prometheus/prometheus.yml:ro"]
    ports: ["9090:9090"]` });
    out.push({ name: "grafana", gate: null, body: `    image: grafana/grafana:11.2.0
    volumes: ["./deploy/grafana/datasource.yml:/etc/grafana/provisioning/datasources/datasource.yml:ro"]
    ports: ["3000:3000"]` });
  } else if (config.monitoring === "otel") {
    out.push({
      name: "otel-collector",
      gate: null,
      apiEnv: emitsOtel(config) ? { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318", OTEL_SERVICE_NAME: safeName(config.name) } : undefined,
      body: `    image: otel/opentelemetry-collector-contrib:0.111.0
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes: ["./deploy/otel-collector.yaml:/etc/otelcol/config.yaml:ro"]
    ports: ["4317:4317", "4318:4318"]`,
    });
  }

  return out;
}

function dockerCompose(config: StackConfig) {
  const deps = composeServices(config);
  // Healthcheck gating (`service_healthy`) keeps the API from starting before
  // its database is ready — avoids the "crash, restart" loop on first boot.
  const dependsOn = deps
    .filter((s) => s.gate !== null)
    .map((s) => `      ${s.name}:\n        condition: ${s.gate ? "service_healthy" : "service_started"}`);

  const apiEnv: Record<string, string> = Object.assign({}, ...deps.map((s) => s.apiEnv ?? {}));
  if (config.database === "dynamodb" || config.queue === "sqs") {
    // Local emulators accept any credentials; the AWS SDKs just need them set.
    Object.assign(apiEnv, { AWS_REGION: config.region, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local" });
  }
  const envBlock = Object.keys(apiEnv).length > 0
    ? `\n    environment:\n${Object.entries(apiEnv).map(([k, v]) => `      ${k}: "${v}"`).join("\n")}`
    : "";

  const api = `  api:
    build: .
    ports:
      - "8080:8080"
    env_file: [.env]${envBlock}${dependsOn.length > 0 ? `\n    depends_on:\n${dependsOn.join("\n")}` : ""}
    restart: unless-stopped`;

  const services = [api, ...deps.map((s) => `  ${s.name}:\n${s.body}\n    restart: unless-stopped`)];

  return `services:
${services.join("\n\n")}

volumes:
  db-data: {}
`;
}

// Per-language tuning for the K8s container spec. The defaults are
// conservative — tune in your own values.yaml / deployment.yaml once you
// have real load telemetry, but a reasonable starting point avoids the
// "my JVM pod keeps OOMKilling" footgun for new users.
type K8sProfile = {
  // Startup tolerance. JVM stacks can easily take 30-60 s to become ready;
  // non-JVM stacks are near-instant.
  startupFailureThreshold: number;
  startupPeriodSeconds: number;
  // Resource requests/limits.
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

function k8sProfile(config: StackConfig): K8sProfile {
  switch (config.language) {
    case "java":
    case "kotlin":
      return {
        startupFailureThreshold: 30,
        startupPeriodSeconds: 5,
        requests: { cpu: "500m", memory: "768Mi" },
        limits: { cpu: "2", memory: "1.5Gi" },
      };
    case "python":
      return {
        startupFailureThreshold: 15,
        startupPeriodSeconds: 3,
        requests: { cpu: "250m", memory: "256Mi" },
        limits: { cpu: "1", memory: "512Mi" },
      };
    case "rust":
    case "go":
      return {
        startupFailureThreshold: 10,
        startupPeriodSeconds: 2,
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "1", memory: "256Mi" },
      };
    case "typescript":
      return {
        startupFailureThreshold: 15,
        startupPeriodSeconds: 2,
        requests: { cpu: "200m", memory: "256Mi" },
        limits: { cpu: "1", memory: "512Mi" },
      };
  }
}

function k8sDeployment(config: StackConfig) {
  const name = safeName(config.name);
  const isGrpc = config.api === "grpc";
  const probe = isGrpc
    ? `grpc: { port: 8080 }`
    : `httpGet: { path: /health, port: 8080 }`;
  // Readiness pings dependencies where the app supports it; liveness stays on
  // plain /health so a flaky database never restarts healthy pods.
  const readyProbe = isGrpc ? probe : `httpGet: { path: "${readyPath(config)}", port: 8080 }`;
  const portName = isGrpc ? "grpc" : "http";
  const p = k8sProfile(config);

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app: ${name}
spec:
  replicas: ${config.replicas}
  # RollingUpdate with maxUnavailable=0 guarantees zero-downtime deploys when
  # combined with the PodDisruptionBudget emitted when replicas > 1.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      # Default K8s terminationGracePeriodSeconds is 30s — set it explicitly
      # here so it's easy to raise if your graceful-shutdown drain needs longer.
      terminationGracePeriodSeconds: 30
      containers:
        - name: api
          image: ghcr.io/${config.owner || "your-org"}/${name}:latest
          ports:
            - name: ${portName}
              containerPort: 8080
          envFrom:
            - secretRef:
                name: ${name}-env
          # startupProbe disables readiness/liveness until the container
          # first reports healthy — critical for JVM stacks that cold-start
          # in 20-60s. Once it succeeds, readinessProbe takes over.
          startupProbe:
            ${probe}
            failureThreshold: ${p.startupFailureThreshold}
            periodSeconds: ${p.startupPeriodSeconds}
          readinessProbe:
            ${readyProbe}
            periodSeconds: 5
            timeoutSeconds: 2
          livenessProbe:
            ${probe}
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          resources:
            requests: { cpu: ${p.requests.cpu}, memory: ${p.requests.memory} }
            limits:   { cpu: ${p.limits.cpu}, memory: ${p.limits.memory} }
          # Run as non-root + drop all Linux capabilities — belt-and-suspenders
          # since the Dockerfile already sets a non-root USER.
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            readOnlyRootFilesystem: false
            capabilities:
              drop: ["ALL"]
`;
}

function k8sPDB(config: StackConfig) {
  const name = safeName(config.name);
  // maxUnavailable=1 keeps at least N-1 replicas running during voluntary
  // disruptions (node drains, cluster upgrades). Safer default than
  // minAvailable because it scales automatically with replica count.
  return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: ${name}
`;
}

function k8sService(config: StackConfig) {
  const name = safeName(config.name);
  const portName = config.api === "grpc" ? "grpc" : "http";
  const appProtocol = config.api === "grpc" ? "\n      appProtocol: grpc" : "";
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector:
    app: ${name}
  ports:
    - name: ${portName}
      port: 80
      targetPort: 8080${appProtocol}
  type: ClusterIP
`;
}

function k8sHPA(config: StackConfig) {
  const name = safeName(config.name);
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${name}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  minReplicas: ${config.replicas}
  maxReplicas: ${Math.max(config.replicas * 4, 10)}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
`;
}

function k8sSecretsExample(config: StackConfig) {
  const vars = buildDeployEnvVarList(config);
  const lines = [
    "# Copy this file to `secrets.env` and fill in real values.",
    "# `secrets.env` is gitignored — never commit it.",
    "#",
    "# Apply with:",
    "#   make -C deploy/k8s secrets",
    "# or manually:",
    "#   kubectl create secret generic <name>-env \\",
    "#     --namespace <name> \\",
    "#     --from-env-file=deploy/k8s/secrets.env \\",
    "#     --dry-run=client -o yaml | kubectl apply -f -",
    "",
    ...vars.map((v) => `${v}=`),
    "",
  ];
  return lines.join("\n");
}

function k8sMakefile(config: StackConfig) {
  const name = safeName(config.name);
  return `# Helper targets for Kubernetes deploys.
# All targets assume kubectl is configured for the target cluster.

NAMESPACE ?= ${name}
IMAGE     ?= ghcr.io/${config.owner || "your-org"}/${name}:latest

.PHONY: all namespace secrets apply rollout logs port-forward

all: namespace secrets apply rollout

namespace:
	kubectl get namespace $(NAMESPACE) >/dev/null 2>&1 || kubectl create namespace $(NAMESPACE)

# Create/update the env Secret from secrets.env (copy secrets.example.env → secrets.env first).
# This never places secret values on the shell command line or in shell history.
secrets:
	@test -f $(CURDIR)/secrets.env || (echo "ERROR: deploy/k8s/secrets.env not found. Copy secrets.example.env → secrets.env and fill values." && exit 1)
	kubectl create secret generic $(NAMESPACE)-env \\
		--namespace $(NAMESPACE) \\
		--from-env-file=$(CURDIR)/secrets.env \\
		--dry-run=client -o yaml | kubectl apply -f -

apply:
	kubectl apply -f $(CURDIR)/deployment.yaml --namespace $(NAMESPACE)
	kubectl apply -f $(CURDIR)/service.yaml --namespace $(NAMESPACE)
	@test ! -f $(CURDIR)/hpa.yaml || kubectl apply -f $(CURDIR)/hpa.yaml --namespace $(NAMESPACE)
	@test ! -f $(CURDIR)/vpa.yaml || kubectl apply -f $(CURDIR)/vpa.yaml --namespace $(NAMESPACE)

rollout:
	kubectl rollout status deployment/$(NAMESPACE) --namespace $(NAMESPACE)

logs:
	kubectl logs -f deployment/$(NAMESPACE) --namespace $(NAMESPACE)

port-forward:
	kubectl port-forward svc/$(NAMESPACE) 8080:80 --namespace $(NAMESPACE)
`;
}

function helmChart(name: string, config: StackConfig) {
  // Bitnami charts are the de-facto standard production-grade charts on
  // Artifact Hub (artifacthub.io/packages/helm/bitnami/*). As of 2024 they're
  // primarily distributed via OCI. The `condition` key lets users disable a
  // bundled DB/cache and point at an external managed service.
  const deps: string[] = [];
  const wantsPostgres = /postgres|supabase|neon/.test(config.database);
  const wantsMysql = /mysql|planetscale/.test(config.database);
  const wantsMongo = /mongo/.test(config.database);
  const wantsRedis = config.cache === "redis" || config.cache === "upstash" || config.cache === "dragonfly";
  const wantsRabbit = config.queue === "rabbitmq";

  if (wantsPostgres) {
    deps.push(`  - name: postgresql
    version: "16.3.5"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: postgresql.enabled`);
  }
  if (wantsMysql) {
    deps.push(`  - name: mysql
    version: "12.2.2"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: mysql.enabled`);
  }
  if (wantsMongo) {
    deps.push(`  - name: mongodb
    version: "16.3.3"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: mongodb.enabled`);
  }
  if (wantsRedis) {
    deps.push(`  - name: redis
    version: "20.3.0"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: redis.enabled`);
  }
  if (wantsRabbit) {
    deps.push(`  - name: rabbitmq
    version: "15.1.1"
    repository: oci://registry-1.docker.io/bitnamicharts
    condition: rabbitmq.enabled`);
  }

  const depsBlock = deps.length > 0 ? `\ndependencies:\n${deps.join("\n")}\n` : "";

  return `apiVersion: v2
name: ${name}
description: Generated by Helios
type: application
version: 0.1.0
appVersion: "0.1.0"
${depsBlock}`;
}

function helmValues(config: StackConfig) {
  const name = safeName(config.name);
  const db = config.database;
  const cache = config.cache;
  const queue = config.queue;

  // Bitnami chart value overrides — keys here follow each chart's documented
  // values.yaml schema. Defaults aim for a useful-but-small local / dev
  // footprint; production users should tune persistence, resources, and auth.
  const bitnamiBlocks: string[] = [];

  if (/postgres|supabase|neon/.test(db)) {
    bitnamiBlocks.push(`
# Bitnami PostgreSQL (artifacthub.io/packages/helm/bitnami/postgresql).
# Set \`enabled: false\` to use a managed Postgres; then set DATABASE_URL
# via the app's Secret.
postgresql:
  enabled: true
  auth:
    username: app
    password: change-me-in-values
    database: ${name}
  primary:
    persistence:
      enabled: true
      size: 8Gi
    resources:
      requests: { cpu: 100m, memory: 256Mi }
      limits:   { cpu: 500m, memory: 512Mi }
`);
  } else if (/mysql|planetscale/.test(db)) {
    bitnamiBlocks.push(`
# Bitnami MySQL (artifacthub.io/packages/helm/bitnami/mysql).
mysql:
  enabled: true
  auth:
    rootPassword: change-me-in-values
    database: ${name}
    username: app
    password: change-me-in-values
  primary:
    persistence:
      enabled: true
      size: 8Gi
`);
  } else if (/mongo/.test(db)) {
    bitnamiBlocks.push(`
# Bitnami MongoDB (artifacthub.io/packages/helm/bitnami/mongodb).
mongodb:
  enabled: true
  auth:
    rootUser: root
    rootPassword: change-me-in-values
    usernames: ["app"]
    passwords: ["change-me-in-values"]
    databases: ["${name}"]
  persistence:
    enabled: true
    size: 8Gi
`);
  }

  if (cache === "redis" || cache === "upstash" || cache === "dragonfly") {
    bitnamiBlocks.push(`
# Bitnami Redis (artifacthub.io/packages/helm/bitnami/redis).
redis:
  enabled: true
  architecture: standalone
  auth:
    enabled: false
  master:
    persistence:
      enabled: true
      size: 2Gi
`);
  }

  if (queue === "rabbitmq") {
    bitnamiBlocks.push(`
# Bitnami RabbitMQ (artifacthub.io/packages/helm/bitnami/rabbitmq).
rabbitmq:
  enabled: true
  auth:
    username: app
    password: change-me-in-values
  persistence:
    enabled: true
    size: 2Gi
`);
  }

  return `replicaCount: ${config.replicas}

image:
  repository: ghcr.io/${config.owner || "your-org"}/${name}
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

# \`vertical\` scaling uses a VPA (deploy/k8s/vpa.yaml) instead of an HPA.
autoscaling:
  enabled: ${config.autoscale && config.scaling !== "vertical"}
  minReplicas: ${config.replicas}
  maxReplicas: ${Math.max(config.replicas * 4, 10)}
  targetCPUUtilizationPercentage: 65

resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: 1
    memory: 512Mi
${bitnamiBlocks.join("")}`;
}

function helmDeploymentTemplate(config: StackConfig) {
  const probes = config.api === "grpc"
    ? `          readinessProbe:
            grpc: { port: 8080 }
          livenessProbe:
            grpc: { port: 8080 }
`
    : `          readinessProbe:
            httpGet: { path: "${readyPath(config)}", port: 8080 }
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
`;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - containerPort: 8080
${probes}          resources:
{{ toYaml .Values.resources | indent 12 }}
`;
}

function helmHpaTemplate() {
  return `{{- if .Values.autoscaling.enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .Release.Name }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .Release.Name }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
{{- end }}
`;
}

function helmServiceTemplate() {
  return `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}
spec:
  selector:
    app: {{ .Release.Name }}
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: 8080
`;
}

function ciWorkflow(config: StackConfig) {
  const lang = config.language;
  const name = safeName(config.name);

  // CodeQL supports a subset of our languages; map Helios languages to the
  // closest CodeQL language id. Unknown entries disable the CodeQL step.
  const codeqlLang: Record<StackConfig["language"], string | null> = {
    go: "go",
    typescript: "javascript-typescript",
    python: "python",
    java: "java-kotlin",
    kotlin: "java-kotlin",
    rust: null, // CodeQL doesn't support Rust; gitleaks alone covers this stack.
  };

  const securityJob = `  security:
    name: Security scans
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Secret scan (gitleaks)
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
${codeqlLang[lang] ? `      - name: Initialize CodeQL
        uses: github/codeql-action/init@v3
        with:
          languages: ${codeqlLang[lang]}
      - name: CodeQL analyze
        uses: github/codeql-action/analyze@v3` : ""}
`;

  const dockerBuildPush = config.docker
    ? `
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          push: \${{ github.ref == 'refs/heads/main' }}
          tags: ghcr.io/${config.owner || "your-org"}/${name}:\${{ github.sha }},ghcr.io/${config.owner || "your-org"}/${name}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max`
    : "";

  const header = `name: ci
on:
  push:
    branches: [main]
  pull_request:
`;

  return (
    header +
    `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${ghaBuildSteps(lang)}
${dockerBuildPush}

${securityJob}`
  );
}

// Build/test steps for one language — shared by ci.yml and deploy.yml's test job.
function ghaBuildSteps(lang: StackConfig["language"]): string {
  const steps: Record<StackConfig["language"], string> = {
    go: `      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true
      - name: Vet
        run: go vet ./...
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: latest
      - name: Test
        run: go test ./... -race -cover -coverprofile=coverage.out
      - name: Build
        run: go build ./...`,
    typescript: `      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: Audit
        run: npm audit --audit-level=high
      - name: Type check
        run: npx tsc --noEmit
      - name: Test
        run: npm test --if-present
      - name: Build
        run: npm run build --if-present`,
    python: `      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install uv
        run: pip install uv
      - name: Install dependencies
        run: uv pip install -e ".[dev]" --system
      - name: Lint
        run: ruff check .
      - name: Test
        run: pytest -q --cov --cov-report=xml`,
    rust: `      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - name: Clippy
        run: cargo clippy -- -D warnings
      - name: Test
        run: cargo test --all
      - name: Build
        run: cargo build --release`,
    java: `      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
          cache: 'maven'
      - name: Test
        run: mvn -B test
      - name: Build
        run: mvn -B package -DskipTests`,
    kotlin: `      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
          cache: 'gradle'
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.10'
      - name: Test
        run: gradle test
      - name: Build
        run: gradle build -x test`,
  };
  return steps[lang];
}

function prometheusConfig(name: string, path: string, target: string) {
  return `global:
  scrape_interval: 15s

scrape_configs:
  - job_name: '${name}'
    static_configs:
      - targets: ['${target}']
    metrics_path: '${path}'
`;
}

function grafanaDatasource() {
  return `apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus:9090
    isDefault: true
`;
}

function datadogConfig(config: StackConfig) {
  const name = safeName(config.name);
  return `init_config:

instances: []

logs_enabled: true

apm_config:
  enabled: true
  env: production

service: ${name}
env: production
version: "0.1.0"
`;
}

function datadogSetupGuide(config: StackConfig) {
  const name = safeName(config.name);
  return `# Setting Up Datadog

## 1. Add the DD Agent sidecar (Kubernetes)

Add the following container to your pod spec in \`deploy/k8s/deployment.yaml\`:

\`\`\`yaml
- name: datadog-agent
  image: datadog/agent:latest
  env:
    - name: DD_API_KEY
      valueFrom:
        secretKeyRef:
          name: ${name}-env
          key: DD_API_KEY
    - name: DD_APM_ENABLED
      value: "true"
    - name: DD_LOGS_ENABLED
      value: "true"
    - name: DD_SERVICE
      value: "${name}"
    - name: DD_ENV
      value: "production"
  ports:
    - containerPort: 8126
      name: traceport
\`\`\`

## 2. Set your API key

\`\`\`bash
kubectl create secret generic ${name}-env --from-literal=DD_API_KEY=<your-key>
\`\`\`

Or add \`DD_API_KEY\` to your existing secret.

## 3. Instrument your application

${config.language === "typescript"
    ? `Install the tracer: \`npm install dd-trace\`\n\nAdd to the top of your entry file (before any imports):\n\`\`\`ts\nimport 'dd-trace/init';\n\`\`\``
    : config.language === "python"
    ? `Install the tracer: \`pip install ddtrace\`\n\nRun your app with: \`ddtrace-run uvicorn app.main:app\``
    : config.language === "go"
    ? `Install: \`go get gopkg.in/DataDog/dd-trace-go.v1/ddtrace\`\n\nSee the [Go tracer docs](https://docs.datadoghq.com/tracing/setup_overview/setup/go/).`
    : `See the [Datadog APM docs](https://docs.datadoghq.com/tracing/) for ${config.language}.`}

## 4. Verify

Open the [Datadog APM dashboard](https://app.datadoghq.com/apm) and confirm traces appear within ~2 minutes of starting your service.
`;
}

function sentrySetupGuide(config: StackConfig) {
  const sdkInstructions: Record<StackConfig["language"], string> = {
    typescript: `Install the SDK:
\`\`\`bash
npm install @sentry/node
\`\`\`

Initialise in your entry file (before any other imports):
\`\`\`ts
import * as Sentry from "@sentry/node";
Sentry.init({ dsn: process.env.SENTRY_DSN });
\`\`\``,
    python: `Install the SDK:
\`\`\`bash
pip install sentry-sdk[fastapi]
\`\`\`

Initialise in \`app/main.py\`:
\`\`\`python
import sentry_sdk
sentry_sdk.init(dsn=os.environ["SENTRY_DSN"])
\`\`\``,
    go: `Install the SDK:
\`\`\`bash
go get github.com/getsentry/sentry-go
\`\`\`

Initialise in \`main.go\`:
\`\`\`go
sentry.Init(sentry.ClientOptions{Dsn: os.Getenv("SENTRY_DSN")})
defer sentry.Flush(2 * time.Second)
\`\`\``,
    rust: `Install in \`Cargo.toml\`:
\`\`\`toml
sentry = "0.34"
\`\`\`

Initialise in \`main.rs\`:
\`\`\`rust
let _guard = sentry::init(std::env::var("SENTRY_DSN").unwrap());
\`\`\``,
    java: `Add to \`pom.xml\`:
\`\`\`xml
<dependency>
  <groupId>io.sentry</groupId>
  <artifactId>sentry-spring-boot-starter-jakarta</artifactId>
  <version>7.x.x</version>
</dependency>
\`\`\`

Set \`sentry.dsn=\${SENTRY_DSN}\` in \`application.properties\`.`,
    kotlin: `Add to \`build.gradle.kts\`:
\`\`\`kotlin
implementation("io.sentry:sentry-spring-boot-starter-jakarta:7.x.x")
\`\`\`

Set \`sentry.dsn=\${SENTRY_DSN}\` in \`application.properties\`.`,
  };

  return `# Setting Up Sentry

## 1. Create a Sentry project

1. Go to [sentry.io](https://sentry.io) and create a new project.
2. Select your platform: **${config.language}**.
3. Copy the DSN from the project setup page.

## 2. Set the DSN

Add to your \`.env\`:
\`\`\`
SENTRY_DSN=https://...@sentry.io/...
\`\`\`

And set it as a secret in your deployment environment.

## 3. Install and initialise the SDK

${sdkInstructions[config.language]}

## 4. Verify

Trigger a test error and confirm it appears in your Sentry dashboard within ~30 seconds.
`;
}

function newrelicConfig(name: string) {
  return `app_name: ${name}
license_key: "\${NEW_RELIC_LICENSE_KEY}"

log_level: info

distributed_tracing:
  enabled: true

transaction_tracer:
  enabled: true
  transaction_threshold: apdex_f

error_collector:
  enabled: true
`;
}

function openapiSpec(config: StackConfig, endpoints: Endpoint[]) {
  const byPath = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    const key = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
    byPath.set(key, [...(byPath.get(key) ?? []), e]);
  }
  const paths: string[] = [];
  for (const [p, eps] of byPath) {
    paths.push(`  ${p}:`);
    for (const e of eps) {
      paths.push(`    ${e.method.toLowerCase()}:`);
      paths.push(`      summary: ${JSON.stringify(e.summary)}`);
      paths.push(`      operationId: ${operationId(e)}`);
      if (e.auth) paths.push(`      security: [{ bearerAuth: [] }]`);
      paths.push(`      responses:`);
      paths.push(`        "200":`);
      paths.push(`          description: OK`);
      if (e.responseSchema) {
        paths.push(`          content:`);
        paths.push(`            application/json:`);
        paths.push(`              schema:`);
        paths.push(
          `                $ref: "#/components/schemas/${e.responseSchema}"`
        );
      }
    }
  }

  return `openapi: 3.1.0
info:
  title: ${config.name}
  version: 0.1.0
  description: Generated by Helios.
servers:
  - url: https://api.example.com
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
paths:
${paths.join("\n") || "  /health:\n    get:\n      summary: Liveness\n      responses:\n        '200': { description: ok }"}
`;
}

export function operationId(e: Endpoint) {
  return (
    e.method.toLowerCase() +
    e.path
      .split("/")
      .filter(Boolean)
      .map((p) => {
        if (p.startsWith(":")) return "By" + p.slice(1, 2).toUpperCase() + p.slice(2);
        return p[0].toUpperCase() + p.slice(1);
      })
      .join("")
  );
}

function postmanCollection(config: StackConfig, endpoints: Endpoint[]): string {
  const baseUrl = "{{base_url}}";

  const items = endpoints.map((e) => {
    const rawPath = e.path.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
    const segments = rawPath.split("/").filter(Boolean);
    const pathVars = segments
      .filter((s) => s.startsWith(":"))
      .map((s) => ({ key: s.slice(1), value: `{{${s.slice(1)}}}`, description: "" }));

    const hasBody = ["POST", "PUT", "PATCH"].includes(e.method.toUpperCase());
    const body = hasBody && e.requestSchema
      ? {
          mode: "raw",
          raw: JSON.stringify(
            Object.fromEntries(
              Object.entries(e.requestSchema).map(([k]) => [k, `<${k}>`])
            ),
            null, 2
          ),
          options: { raw: { language: "json" } },
        }
      : hasBody
      ? { mode: "raw", raw: "{}", options: { raw: { language: "json" } } }
      : undefined;

    const headers: { key: string; value: string; type: string }[] = [];
    if (hasBody) headers.push({ key: "Content-Type", value: "application/json", type: "text" });
    if (e.auth) headers.push({ key: "Authorization", value: "Bearer {{token}}", type: "text" });

    const request: Record<string, unknown> = {
      method: e.method.toUpperCase(),
      header: headers,
      url: {
        raw: `${baseUrl}/${segments.join("/")}`,
        host: [baseUrl],
        path: segments,
        ...(pathVars.length ? { variable: pathVars } : {}),
      },
      description: e.summary,
    };
    if (body) request.body = body;

    return { name: `${e.method.toUpperCase()} ${e.path}`, request, response: [] };
  });

  const collection = {
    info: {
      name: `${config.name} API`,
      description: `Generated by Helios — ${config.language}/${config.framework}`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: [
      { key: "base_url", value: "http://localhost:8080", type: "string" },
      { key: "token", value: "your-jwt-token-here", type: "string" },
    ],
  };

  return JSON.stringify(collection, null, 2) + "\n";
}

// ─── Scaling helpers ─────────────────────────────────────────────────────────
// minInstances / maxInstances live in ./deploy (shared with the deploy jobs).

// Non-secret runtime vars; everything else from buildDeployEnvVarList is
// treated as a secret on the cloud targets.
const PLAIN_ENV = new Set(["APP_NAME", "PORT"]);

function k8sVPA(config: StackConfig) {
  const name = safeName(config.name);
  const p = k8sProfile(config);
  return `# Requires the Vertical Pod Autoscaler controller:
#   https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: ${name}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${name}
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed: { cpu: ${p.requests.cpu}, memory: ${p.requests.memory} }
        maxAllowed: { cpu: ${p.limits.cpu}, memory: ${p.limits.memory} }
`;
}

// ─── Cloud IaC ───────────────────────────────────────────────────────────────

function ecsTaskDefinition(config: StackConfig): string {
  const name = safeName(config.name);
  const jvm = isJvm(config.language);
  const vars = buildDeployEnvVarList(config);
  const def = {
    family: name,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: jvm ? "1024" : "512",
    memory: jvm ? "2048" : "1024",
    runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
    executionRoleArn: "arn:aws:iam::${AWS_ACCOUNT_ID}:role/ecsTaskExecutionRole",
    containerDefinitions: [
      {
        name: "api",
        image: `\${AWS_ACCOUNT_ID}.dkr.ecr.${config.region}.amazonaws.com/${name}:latest`,
        essential: true,
        portMappings: [{ containerPort: 8080, protocol: "tcp" }],
        environment: [
          { name: "APP_NAME", value: config.name },
          { name: "PORT", value: "8080" },
        ],
        // SSM Parameter Store SecureStrings — see DEPLOY.md for the put-parameter loop.
        secrets: vars
          .filter((v) => !PLAIN_ENV.has(v))
          .map((v) => ({
            name: v,
            valueFrom: `arn:aws:ssm:${config.region}:\${AWS_ACCOUNT_ID}:parameter/${name}/${v}`,
          })),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": `/ecs/${name}`,
            "awslogs-region": config.region,
            "awslogs-stream-prefix": "api",
          },
        },
      },
    ],
  };
  return JSON.stringify(def, null, 2) + "\n";
}

const kebabVar = (v: string) => v.toLowerCase().replace(/_/g, "-");
const secretName = (app: string, v: string) => `${app}-${kebabVar(v)}`;

function cloudRunService(config: StackConfig): string {
  const name = safeName(config.name);
  const region = providerRegion(config, "gcp");
  const vars = buildDeployEnvVarList(config).filter((v) => !PLAIN_ENV.has(v));
  // PORT is reserved on Cloud Run — the platform injects it from containerPort.
  const env = [
    `            - name: APP_NAME\n              value: "${config.name}"`,
    ...vars.map(
      (v) => `            - name: ${v}\n              valueFrom:\n                secretKeyRef:\n                  name: ${secretName(name, v)}\n                  key: latest`
    ),
  ].join("\n");
  return `# Deploy: envsubst < deploy/gcp/service.yaml > /tmp/service.yaml && gcloud run services replace /tmp/service.yaml --region ${region}
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${name}
  labels:
    cloud.googleapis.com/location: ${region}
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "${minInstances(config)}"
        autoscaling.knative.dev/maxScale: "${maxInstances(config)}"
    spec:
      containerConcurrency: 80
      containers:
        - image: ${region}-docker.pkg.dev/\${GCP_PROJECT_ID}/${name}/${name}:latest
          ports:
            - name: ${config.api === "grpc" ? "h2c" : "http1"}
              containerPort: 8080
          resources:
            limits:
              cpu: "1"
              memory: ${isJvm(config.language) ? "1Gi" : "512Mi"}
          env:
${env}
`;
}

function azureContainerApp(config: StackConfig): string {
  const name = safeName(config.name);
  const acr = acrName(name);
  const vars = buildDeployEnvVarList(config).filter((v) => !PLAIN_ENV.has(v));
  const jvm = isJvm(config.language);
  const secrets = [
    `      - name: registry-password\n        value: "\${ACR_PASSWORD}"`,
    ...vars.map((v) => `      - name: ${kebabVar(v)}\n        value: "\${${v}}"`),
  ].join("\n");
  const env = [
    `          - name: APP_NAME\n            value: "${config.name}"`,
    `          - name: PORT\n            value: "8080"`,
    ...vars.map((v) => `          - name: ${v}\n            secretRef: ${kebabVar(v)}`),
  ].join("\n");
  return `# Deploy (values are substituted from your shell env — never commit them):
#   set -a; . ./.env; set +a
#   envsubst < deploy/azure/containerapp.yaml > /tmp/containerapp.yaml
#   az containerapp create --name ${name} --resource-group ${name}-rg --yaml /tmp/containerapp.yaml
location: ${providerRegion(config, "azure")}
name: ${name}
type: Microsoft.App/containerApps
properties:
  managedEnvironmentId: /subscriptions/\${AZURE_SUBSCRIPTION_ID}/resourceGroups/${name}-rg/providers/Microsoft.App/managedEnvironments/${name}-env
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8080
      transport: ${config.api === "grpc" ? "http2" : "auto"}
    registries:
      - server: ${acr}.azurecr.io
        username: ${acr}
        passwordSecretRef: registry-password
    secrets:
${secrets}
  template:
    containers:
      - name: api
        image: ${acr}.azurecr.io/${name}:latest
        resources:
          cpu: ${jvm ? "1.0" : "0.5"}
          memory: ${jvm ? "2Gi" : "1Gi"}
        env:
${env}
    scale:
      minReplicas: ${minInstances(config)}
      maxReplicas: ${maxInstances(config)}
`;
}

// ─── Alternate CI providers ──────────────────────────────────────────────────

// Build/test commands shared by every CI provider. GitHub Actions uses
// setup-* actions for toolchains; GitLab/CircleCI use these images.
const ciCommands: Record<
  StackConfig["language"],
  { image: string; circleImage: string; setup: string[]; test: string[]; build: string[] }
> = {
  go: { image: "golang:1.23", circleImage: "cimg/go:1.23", setup: [], test: ["go vet ./...", "go test ./... -race -cover"], build: ["go build ./..."] },
  typescript: { image: "node:22", circleImage: "cimg/node:lts", setup: ["npm ci"], test: ["npx tsc --noEmit", "npm test --if-present"], build: ["npm run build --if-present"] },
  python: { image: "python:3.12", circleImage: "cimg/python:3.12", setup: ["pip install uv", 'uv pip install -e ".[dev]" --system'], test: ["ruff check .", "pytest -q"], build: [] },
  rust: { image: "rust:1.82", circleImage: "cimg/rust:1.82.0", setup: ["rustup component add clippy"], test: ["cargo clippy -- -D warnings", "cargo test --all"], build: ["cargo build --release"] },
  java: { image: "maven:3.9-eclipse-temurin-21", circleImage: "cimg/openjdk:21.0", setup: [], test: ["mvn -B test"], build: ["mvn -B package -DskipTests"] },
  kotlin: { image: "gradle:8.10-jdk21", circleImage: "cimg/openjdk:21.0", setup: [], test: ["gradle test --no-daemon"], build: ["gradle build -x test --no-daemon"] },
};

function gitlabCi(config: StackConfig): string {
  const c = ciCommands[config.language];
  const script = [...c.setup, ...c.test, ...c.build].map((s) => `    - ${s}`).join("\n");
  const docker = config.docker
    ? `

# Pushes to this project's GitLab Container Registry on the default branch.
docker:
  stage: build
  image: docker:27
  services: [docker:27-dind]
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" -t "$CI_REGISTRY_IMAGE:latest" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
    - docker push "$CI_REGISTRY_IMAGE:latest"`
    : "";
  return `stages: [test${config.docker ? ", build" : ""}, deploy]

test:
  stage: test
  image: ${c.image}
  script:
${script}${docker}${gitlabDeployJob(config)}
`;
}

function circleCi(config: StackConfig): string {
  const c = ciCommands[config.language];
  const image = `ghcr.io/${config.owner || "your-org"}/${safeName(config.name)}`;
  const steps = [...c.setup, ...c.test, ...c.build].map((s) => `      - run: ${s}`).join("\n");
  const dockerJob = config.docker
    ? `
  docker:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
      - setup_remote_docker
      - run:
          name: Build and push
          # Set REGISTRY_USER / REGISTRY_TOKEN (a GHCR token with write:packages) in a CircleCI context.
          command: |
            echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin
            docker build -t ${image}:$CIRCLE_SHA1 -t ${image}:latest .
            docker push ${image}:$CIRCLE_SHA1
            docker push ${image}:latest`
    : "";
  const dockerWorkflow = config.docker
    ? `
      - docker:
          requires: [test]
          filters:
            branches:
              only: main`
    : "";
  const deploy = circleDeployJob(config);
  return `version: 2.1

jobs:
  test:
    docker:
      - image: ${c.circleImage}
    steps:
      - checkout
${steps}${dockerJob}${deploy.job}

workflows:
  ci:
    jobs:
      - test${dockerWorkflow}${deploy.workflow}
`;
}

function argoApplication(config: StackConfig): string {
  const name = safeName(config.name);
  const owner = config.owner || "your-org";
  // Plain manifests first: they need no chart-dependency fetch inside Argo.
  const path = config.kubernetes ? "deploy/k8s" : "deploy/helm";
  return `# Register with: kubectl apply -n argocd -f deploy/argocd/application.yaml
# Argo CD syncs ${path} from the main branch; GitHub Actions builds and pushes the image.${config.kubernetes ? `
# The ${name}-env Secret is not in git — create it once with: make -C deploy/k8s namespace secrets` : ""}
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${name}
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/${owner}/${name}.git
    targetRevision: main
    path: ${path}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${name}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`;
}

function otelCollectorConfig(): string {
  return `# OpenTelemetry Collector — receives OTLP from the api and prints it.
# Swap the debug exporter for otlp/otlphttp pointing at your backend
# (Honeycomb, Grafana Tempo, Jaeger, …) when you have one.
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch: {}

exporters:
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug]
`;
}

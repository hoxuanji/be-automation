import type { Endpoint, GeneratedFile, StackConfig } from "./types";
import { safeName, toEnvKey, looksLikeSecretValue, isGrpcSupported } from "./types";
import { authProviderSpec } from "./auth/providers";

const languageMeta: Record<
  StackConfig["language"],
  { runCommand: string; testCommand: string; devCommand: string }
> = {
  go: { runCommand: "go run ./cmd/api", testCommand: "go test ./... -race -cover", devCommand: "go run ./cmd/api" },
  typescript: { runCommand: "npm run start", testCommand: "npm test", devCommand: "npm run dev" },
  python: { runCommand: "uvicorn app.main:app --host 0.0.0.0 --port 8080", testCommand: "pytest -q", devCommand: "uvicorn app.main:app --reload" },
  rust: { runCommand: "cargo run --release", testCommand: "cargo test", devCommand: "cargo run" },
  java: { runCommand: "./mvnw spring-boot:run", testCommand: "./mvnw test", devCommand: "./mvnw spring-boot:run" },
  kotlin: { runCommand: "./gradlew run", testCommand: "./gradlew test", devCommand: "./gradlew run" },
};

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
  endpoints: Endpoint[]
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
  files.push({ path: ".env.example", content: envExample(config) });
  files.push({ path: ".gitignore", content: gitignore(config.language) });
  files.push({
    path: ".editorconfig",
    content:
      "root = true\n\n[*]\nend_of_line = lf\ncharset = utf-8\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n",
  });

  if (config.docker) {
    files.push({ path: "docker-compose.yml", content: dockerCompose(config) });
  }

  if (config.kubernetes) {
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
    if (config.autoscale) {
      files.push({
        path: "deploy/k8s/hpa.yaml",
        content: k8sHPA(config),
      });
    }
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
      content: helmDeploymentTemplate(),
    });
    files.push({
      path: "deploy/helm/templates/service.yaml",
      content: helmServiceTemplate(),
    });
  }

  files.push({
    path: ".github/workflows/ci.yml",
    content: ciWorkflow(config),
  });

  files.push({
    path: "api/openapi.yaml",
    content: openapiSpec(config, endpoints),
  });

  files.push({
    path: "api/postman_collection.json",
    content: postmanCollection(config, endpoints),
  });

  if (config.monitoring === "prometheus") {
    files.push({ path: "deploy/prometheus.yml", content: prometheusConfig(name) });
  }

  if (config.monitoring === "grafana") {
    files.push({ path: "deploy/prometheus.yml", content: prometheusConfig(name) });
    files.push({ path: "deploy/grafana/datasource.yml", content: grafanaDatasource() });
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
  const grpcUnsupportedBanner =
    isGrpc && !isGrpcSupported(config.language)
      ? `
> ⚠️ **gRPC not yet generated for ${langEmoji[config.language]}.** Helios emitted a REST server instead.
> gRPC support lands first for Go, TypeScript, and Python — switch the stack language if you need a working gRPC
> bootstrap, or keep this repo on REST.
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
    : `## Endpoints

| Method | Path | Summary | Auth |
| --- | --- | --- | --- |
${ep || "| — | — | _no endpoints defined_ | — |"}
`;

  return `# ${config.name}

Generated by **Helios** — an AI-native backend generator.

> ${langEmoji[config.language]} · ${config.framework} · ${config.database} · ${config.cache} · ${config.api.toUpperCase()} · ${config.deployment}
${grpcUnsupportedBanner}
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

- Dockerfile and docker-compose at the repo root
- Kubernetes manifests under \`deploy/k8s/\`${config.helm ? "\n- Helm chart under `deploy/helm/`" : ""}
- CI wired for ${config.cicd} at \`.github/workflows/ci.yml\`

${authReadmeSection(config)}## Observability

${config.monitoring} is wired in with sensible defaults.${config.tracing ? " OpenTelemetry traces are exported via OTLP." : ""}${config.audit ? " Audit logs are emitted for every mutating request." : ""}
`;
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
    rust: `Rust stacks currently ship without a generated JWT middleware — use a crate like \`axum-jwks\` or \`oauth2\` and gate routes with it.`,
    java: `Spring Security with \`spring-boot-starter-oauth2-resource-server\` is configured in \`SecurityConfig.java\`. Everything except \`/health\` requires a valid JWT.`,
    kotlin: `Spring Security with \`spring-boot-starter-oauth2-resource-server\` is configured in \`SecurityConfig.kt\`. Everything except \`/health\` requires a valid JWT.`,
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

  const dbDependencies: string[] = [];
  if (/postgres|neon|supabase|cockroach/.test(config.database)) {
    dbDependencies.push("db");
  } else if (config.database === "mysql" || config.database === "planetscale") {
    dbDependencies.push("db");
  } else if (config.database === "mongodb") {
    dbDependencies.push("db");
  }

  if (config.cache === "redis" || config.cache === "upstash" || config.cache === "dragonfly") {
    dbDependencies.push("cache");
  } else if (config.cache === "memcached") {
    dbDependencies.push("cache");
  }

  if (config.queue === "rabbitmq") {
    dbDependencies.push("rabbit");
  } else if (config.queue === "kafka") {
    dbDependencies.push("kafka");
  } else if (config.queue === "nats") {
    dbDependencies.push("nats");
  }

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

## Step 2: Set up environment variables

\`\`\`bash
cp .env.example .env
\`\`\`

Open \`.env\` and fill in the following values:

${envVarDocs}

---

## Step 3: Start dependencies

${step3Docker}

---

## Step 4: Run database migrations

\`\`\`bash
${migrationStep[config.language]}
\`\`\`

---

## Step 5: Start the development server

\`\`\`bash
${meta.devCommand}
\`\`\`

The server will be available at **http://localhost:8080**.

---

## Step 6: Test the API

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

  if (/postgres|neon|supabase/.test(config.database)) {
    lines.push(`| \`DATABASE_URL\` | \`postgres://user:pass@localhost:5432/${safeName(config.name)}\` | Connection string for your PostgreSQL database |`);
  } else if (config.database === "cockroach") {
    lines.push(`| \`DATABASE_URL\` | \`postgres://root@localhost:26257/${safeName(config.name)}?sslmode=disable\` | CockroachDB connection string |`);
  } else if (config.database === "mysql" || config.database === "planetscale") {
    lines.push(`| \`DATABASE_URL\` | \`mysql://user:pass@localhost:3306/${safeName(config.name)}\` | MySQL connection string |`);
  } else if (config.database === "mongodb") {
    lines.push(`| \`MONGODB_URI\` | \`mongodb://localhost:27017/${safeName(config.name)}\` | MongoDB connection URI |`);
  } else if (config.database === "sqlite") {
    lines.push(`| \`DATABASE_URL\` | \`file:./app.db\` | Path to the SQLite file |`);
  }

  if (config.cache === "redis" || config.cache === "upstash") {
    lines.push(`| \`REDIS_URL\` | \`redis://localhost:6379\` | Redis connection URL. For Upstash, get from the Upstash console |`);
  } else if (config.cache === "memcached") {
    lines.push(`| \`MEMCACHED_URL\` | \`localhost:11211\` | Memcached server address |`);
  }

  if (config.queue === "rabbitmq") {
    lines.push(`| \`RABBITMQ_URL\` | \`amqp://guest:guest@localhost:5672\` | RabbitMQ AMQP connection URL |`);
  } else if (config.queue === "kafka" || config.queue === "redpanda") {
    lines.push(`| \`KAFKA_BROKERS\` | \`localhost:9092\` | Comma-separated list of Kafka broker addresses |`);
  } else if (config.queue === "nats") {
    lines.push(`| \`NATS_URL\` | \`nats://localhost:4222\` | NATS server URL |`);
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
  const name = safeName(config.name);

  const envVarList = buildDeployEnvVarList(config);

  switch (config.deployment) {
    case "vercel":
      return `# Deploy to Vercel

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

Render auto-deploys on every push to \`main\`. To trigger manually:

\`\`\`bash
curl -X POST https://api.render.com/deploy/<service-id>?key=<deploy-hook-key>
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

### 1. Launch the app

\`\`\`bash
flyctl launch --name ${name} --region ${config.region} --no-deploy
\`\`\`

This creates a \`fly.toml\` at the repo root. Review and commit it.

### 2. Create a Postgres cluster (if needed)

\`\`\`bash
flyctl postgres create --name ${name}-db --region ${config.region}
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

1. Create an ECS cluster: \`aws ecs create-cluster --cluster-name ${name}\`
2. Register a task definition pointing to your image.
3. Create a service with desired count \`${config.replicas}\`.

Refer to the [ECS Fargate docs](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/getting-started-fargate.html) for the full task definition JSON.

### 4. Set environment variables

Use AWS Secrets Manager or Parameter Store, then reference them in your task definition's \`secrets\` / \`environment\` blocks:

${envVarList.map((v) => `- \`${v}\``).join("\n")}

## Notes

- Attach the \`AmazonECR_ReadOnly\` policy to your task execution role.
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
  --location=${config.region}
\`\`\`

### 3. Build and push the image

\`\`\`bash
PROJECT=$(gcloud config get-value project)
REGISTRY=${config.region}-docker.pkg.dev/$PROJECT/${name}

gcloud auth configure-docker ${config.region}-docker.pkg.dev
docker build -t ${name} .
docker tag ${name}:latest $REGISTRY/${name}:latest
docker push $REGISTRY/${name}:latest
\`\`\`

### 4. Deploy to Cloud Run

\`\`\`bash
gcloud run deploy ${name} \\
  --image $REGISTRY/${name}:latest \\
  --platform managed \\
  --region ${config.region} \\
  --allow-unauthenticated \\
  --min-instances ${config.replicas} \\
  --set-env-vars="${envVarList.map((v) => `${v}=<value>`).join(",")}"
\`\`\`

### 5. Verify

\`\`\`bash
gcloud run services describe ${name} --region ${config.region} --format "value(status.url)"
\`\`\`

## Notes

- Use Secret Manager for secrets: \`gcloud secrets create MY_SECRET --data-file=-\`
- Reference secrets in Cloud Run: \`--set-secrets=MY_SECRET=MY_SECRET:latest\`
`;

    case "azure":
      return `# Deploy to Azure (Container Registry + Container Apps)

## Prerequisites

- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) authenticated
- Docker

## Steps

### 1. Create a resource group and Container Registry

\`\`\`bash
az group create --name ${name}-rg --location ${config.region}
az acr create --resource-group ${name}-rg --name ${name}registry --sku Basic
\`\`\`

### 2. Build and push the image

\`\`\`bash
az acr login --name ${name}registry
docker build -t ${name}:latest .
docker tag ${name}:latest ${name}registry.azurecr.io/${name}:latest
docker push ${name}registry.azurecr.io/${name}:latest
\`\`\`

### 3. Create a Container Apps environment

\`\`\`bash
az containerapp env create \\
  --name ${name}-env \\
  --resource-group ${name}-rg \\
  --location ${config.region}
\`\`\`

### 4. Deploy the Container App

\`\`\`bash
az containerapp create \\
  --name ${name} \\
  --resource-group ${name}-rg \\
  --environment ${name}-env \\
  --image ${name}registry.azurecr.io/${name}:latest \\
  --target-port 8080 \\
  --ingress external \\
  --min-replicas ${config.replicas} \\
  --registry-server ${name}registry.azurecr.io
\`\`\`

### 5. Set environment variables

\`\`\`bash
az containerapp update --name ${name} --resource-group ${name}-rg \\
  --set-env-vars ${envVarList.map((v) => `${v}=secretref:${v.toLowerCase()}`).join(" ")}
\`\`\`

## Notes

- Use Azure Key Vault for secrets and reference them via Container Apps secrets.
- Enable managed identity for seamless access to other Azure services.
`;

    case "k8s":
      return `# Deploy to Kubernetes

## Prerequisites

- \`kubectl\` configured to point at your target cluster
- Docker registry access (the manifests default to \`ghcr.io/your-org/${name}\`)
- \`make\` installed (optional — commands also work standalone)

## Steps

### 1. Build and push your image

\`\`\`bash
docker build -t ghcr.io/your-org/${name}:latest .
docker push ghcr.io/your-org/${name}:latest
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

- Update \`deploy/k8s/deployment.yaml\` to set the correct image tag before each deploy.
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

  if (config.cache === "redis" || config.cache === "upstash") {
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

function envExample(config: StackConfig) {
  const lines = [
    `# Runtime`,
    `APP_NAME=${config.name}`,
    `LOG_LEVEL=info`,
    `PORT=8080`,
    ``,
  ];

  if (/postgres|neon|supabase/.test(config.database)) {
    lines.push(`# Database`);
    lines.push(`DATABASE_URL=postgres://user:pass@localhost:5432/${safeName(config.name)}`);
    lines.push(``);
  } else if (config.database === "cockroach") {
    lines.push(`# Database`);
    lines.push(`DATABASE_URL=postgres://root@localhost:26257/${safeName(config.name)}?sslmode=disable`);
    lines.push(``);
  } else if (config.database === "mysql" || config.database === "planetscale") {
    lines.push(`# Database`);
    lines.push(`DATABASE_URL=mysql://user:pass@localhost:3306/${safeName(config.name)}`);
    lines.push(``);
  } else if (config.database === "mongodb") {
    lines.push(`# Database`);
    lines.push(`MONGODB_URI=mongodb://localhost:27017/${safeName(config.name)}`);
    lines.push(``);
  } else if (config.database === "sqlite") {
    lines.push(`# Database`);
    lines.push(`DATABASE_URL=file:./app.db`);
    lines.push(``);
  }

  if (config.cache === "redis" || config.cache === "upstash") {
    lines.push(`# Cache`);
    lines.push(`REDIS_URL=redis://localhost:6379`);
    lines.push(``);
  } else if (config.cache === "memcached") {
    lines.push(`# Cache`);
    lines.push(`MEMCACHED_URL=localhost:11211`);
    lines.push(``);
  }

  if (config.queue === "rabbitmq") {
    lines.push(`# Queue`);
    lines.push(`RABBITMQ_URL=amqp://guest:guest@localhost:5672`);
    lines.push(``);
  } else if (config.queue === "kafka" || config.queue === "redpanda") {
    lines.push(`# Queue`);
    lines.push(`KAFKA_BROKERS=localhost:9092`);
    lines.push(``);
  } else if (config.queue === "nats") {
    lines.push(`# Queue`);
    lines.push(`NATS_URL=nats://localhost:4222`);
    lines.push(``);
  }

  const authSpecExample = authProviderSpec(config);
  if (authSpecExample) {
    lines.push(`# Auth — ${authSpecExample.label}`);
    lines.push(`${authSpecExample.issuerEnv}=${authSpecExample.issuerExample}`);
    lines.push(`${authSpecExample.jwksUrlEnv}=${authSpecExample.jwksUrlExample}`);
    if (authSpecExample.audienceEnv) {
      lines.push(`${authSpecExample.audienceEnv}=`);
    }
    lines.push(``);
  }

  if (config.monitoring === "sentry") {
    lines.push(`# Monitoring — Sentry`);
    lines.push(`SENTRY_DSN=https://...@sentry.io/...`);
    lines.push(``);
  } else if (config.monitoring === "datadog") {
    lines.push(`# Monitoring — Datadog`);
    lines.push(`DD_API_KEY=...`);
    lines.push(``);
  }

  if (config.envVars.length > 0) {
    lines.push(`# Application`);
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

function dockerCompose(config: StackConfig) {
  // Build `depends_on` with healthcheck gating so the API container blocks
  // on `service_healthy` instead of `service_started`. This prevents the
  // common "app starts before Postgres is ready, crashes, restarts" loop.
  const deps: string[] = [];
  if (config.database) deps.push(`      db:\n        condition: service_healthy`);
  if (config.cache) deps.push(`      cache:\n        condition: service_healthy`);
  if (config.queue === "rabbitmq") deps.push(`      rabbit:\n        condition: service_healthy`);
  if (config.queue === "kafka") deps.push(`      kafka:\n        condition: service_started`);
  if (config.queue === "nats") deps.push(`      nats:\n        condition: service_started`);
  const dependsOn = deps.length > 0 ? `\n    depends_on:\n${deps.join("\n")}` : "";

  const services: string[] = [
    `  api:
    build: .
    ports:
      - "8080:8080"
    env_file: [.env]${dependsOn}
    restart: unless-stopped`,
  ];

  const dbName = safeName(config.name);

  if (/postgres|supabase|neon/.test(config.database)) {
    services.push(`  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-app}
      POSTGRES_DB: \${POSTGRES_DB:-${dbName}}
    ports: ["5432:5432"]
    volumes: [db-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-app} -d \${POSTGRES_DB:-${dbName}}"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  } else if (config.database === "mysql" || config.database === "planetscale") {
    services.push(`  db:
    image: mysql:8
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD:-app}
      MYSQL_DATABASE: \${MYSQL_DATABASE:-${dbName}}
      MYSQL_USER: \${MYSQL_USER:-app}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD:-app}
    ports: ["3306:3306"]
    volumes: [db-data:/var/lib/mysql]
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p\${MYSQL_ROOT_PASSWORD:-app}"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  } else if (config.database === "mongodb") {
    services.push(`  db:
    image: mongo:7
    environment:
      MONGO_INITDB_ROOT_USERNAME: \${MONGO_USER:-app}
      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_PASSWORD:-app}
    ports: ["27017:27017"]
    volumes: [db-data:/data/db]
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  } else if (config.database === "cockroach") {
    services.push(`  db:
    image: cockroachdb/cockroach:latest-v24.3
    command: start-single-node --insecure
    ports: ["26257:26257", "8081:8080"]
    volumes: [db-data:/cockroach/cockroach-data]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health?ready=1 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  }

  if (config.cache === "redis" || config.cache === "upstash") {
    services.push(`  cache:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  } else if (config.cache === "memcached") {
    services.push(`  cache:
    image: memcached:1.6-alpine
    ports: ["11211:11211"]
    healthcheck:
      test: ["CMD-SHELL", "echo stats | nc -w 1 localhost 11211 | grep -q uptime"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  } else if (config.cache === "dragonfly") {
    services.push(`  cache:
    image: docker.dragonflydb.io/dragonflydb/dragonfly:latest
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped`);
  }

  if (config.queue === "rabbitmq") {
    services.push(`  rabbit:
    image: rabbitmq:3-management
    ports: ["5672:5672", "15672:15672"]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped`);
  } else if (config.queue === "kafka") {
    services.push(`  kafka:
    image: redpandadata/redpanda:latest
    command: redpanda start --overprovisioned --smp 1 --memory 512M --reserve-memory 0M --node-id 0 --check=false
    ports: ["9092:9092"]
    restart: unless-stopped`);
  } else if (config.queue === "nats") {
    services.push(`  nats:
    image: nats:2-alpine
    command: ["-js"]
    ports: ["4222:4222"]
    restart: unless-stopped`);
  }

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
          image: ghcr.io/your-org/${name}:latest
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
            ${probe}
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
IMAGE     ?= ghcr.io/your-org/${name}:latest

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
  repository: ghcr.io/your-org/${name}
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

autoscaling:
  enabled: ${config.autoscale}
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

function helmDeploymentTemplate() {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
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
          resources:
{{ toYaml .Values.resources | indent 12 }}
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
          tags: ghcr.io/your-org/${name}:\${{ github.sha }},ghcr.io/your-org/${name}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max`
    : "";

  const deploymentComment = (() => {
    switch (config.deployment) {
      case "fly":
        return `      - name: Deploy to Fly.io
        if: github.ref == 'refs/heads/main'
        uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        if: github.ref == 'refs/heads/main'
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}`;
      case "railway":
        return `      # Deploy to Railway — trigger via webhook
      # - name: Deploy to Railway
      #   if: github.ref == 'refs/heads/main'
      #   run: curl -X POST "\${{ secrets.RAILWAY_DEPLOY_WEBHOOK }}"`;
      case "render":
        return `      # Deploy to Render — trigger via deploy hook
      # - name: Deploy to Render
      #   if: github.ref == 'refs/heads/main'
      #   run: curl -X POST "\${{ secrets.RENDER_DEPLOY_HOOK }}"`;
      case "vercel":
        return `      # Deploy to Vercel — handled automatically via Vercel GitHub integration
      # Remove this comment and configure the Vercel integration in your repo settings.`;
      default:
        return `      # Add your deployment step here for ${config.deployment}`;
    }
  })();

  const header = `name: ci
on:
  push:
    branches: [main]
  pull_request:
`;

  if (lang === "go") {
    return (
      header +
      `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
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
        run: go build ./...
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
    );
  }

  if (lang === "typescript") {
    return (
      header +
      `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
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
        run: npm run build --if-present
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
    );
  }

  if (lang === "python") {
    return (
      header +
      `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
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
        run: pytest -q --cov --cov-report=xml
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
    );
  }

  if (lang === "rust") {
    return (
      header +
      `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - name: Clippy
        run: cargo clippy -- -D warnings
      - name: Test
        run: cargo test --all
      - name: Build
        run: cargo build --release
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
    );
  }

  if (lang === "java") {
    return (
      header +
      `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
          cache: 'maven'
      - name: Test
        run: ./mvnw -B test
      - name: Build
        run: ./mvnw -B package -DskipTests
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
    );
  }

  return (
    header +
    `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
          cache: 'gradle'
      - name: Test
        run: ./gradlew test
      - name: Build
        run: ./gradlew build -x test
${dockerBuildPush}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
${deploymentComment}

${securityJob}`
  );
}

function prometheusConfig(name: string) {
  return `global:
  scrape_interval: 15s

scrape_configs:
  - job_name: '${name}'
    static_configs:
      - targets: ['api:8080']
    metrics_path: '/metrics'
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

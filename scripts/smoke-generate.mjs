// Generates a repo for the CI smoke-build matrix.
// Run with: node --experimental-strip-types --no-warnings \
//   --import ./src/lib/generators/__tests__/loader.mjs scripts/smoke-generate.mjs
// Env: LANGUAGE, FRAMEWORK (required); PROFILE=minimal|full; DATABASE, AUTH, API, OUT (optional).
import { generate } from "../src/lib/generators/index.ts";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const full = env.PROFILE === "full";

const config = {
  name: "smoke-app",
  language: env.LANGUAGE,
  framework: env.FRAMEWORK,
  database: env.DATABASE || "postgres",
  cache: "redis",
  queue: "rabbitmq",
  api: env.API || "rest",
  auth: env.AUTH || (full ? "clerk" : "none"),
  deployment: "k8s",
  scaling: "horizontal",
  monitoring: full ? "grafana" : "prometheus",
  cicd: "github-actions",
  docker: true,
  kubernetes: full,
  helm: full,
  // The "full" profile turns on every flag so the code paths behind them are compiled.
  tracing: full,
  rateLimit: full,
  audit: full,
  autoscale: full,
  replicas: full ? 2 : 1,
  region: "us-east-1",
  envVars: [],
};

const endpoints = [
  { id: "1", method: "GET", path: "/health", summary: "Health", auth: false },
  ...(full
    ? [
        { id: "2", method: "GET", path: "/reports/:id", summary: "Get report", auth: true },
        { id: "3", method: "POST", path: "/reports", summary: "Create report", auth: true },
      ]
    : []),
];

const entities = full
  ? [
      {
        id: "e1",
        name: "User",
        fields: [
          { id: "f1", name: "id", type: "uuid", required: true, unique: true, primaryKey: true },
          { id: "f2", name: "email", type: "string", required: true, unique: true },
          { id: "f3", name: "score", type: "number", required: false, unique: false },
          { id: "f4", name: "active", type: "boolean", required: true, unique: false },
          { id: "f5", name: "createdAt", type: "date", required: true, unique: false },
        ],
      },
    ]
  : [];

if (!config.language || !config.framework) {
  console.error("LANGUAGE and FRAMEWORK are required");
  process.exit(1);
}

const out = env.OUT || "/tmp/smoke-repo";
rmSync(out, { recursive: true, force: true });
const files = generate(config, endpoints, entities);
for (const f of files) {
  const p = join(out, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content);
}
console.log(`${files.length} files written to ${out} (${JSON.stringify({ ...config, envVars: undefined })})`);

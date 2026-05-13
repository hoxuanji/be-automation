#!/usr/bin/env bash
# Run a quick local smoke build for a generated stack.
# Usage: ./scripts/smoke-local.sh [language] [framework]
# Example: ./scripts/smoke-local.sh typescript hono
set -euo pipefail

LANG="${1:-typescript}"
FRAMEWORK="${2:-hono}"
OUTDIR="/tmp/helios-smoke-$$"

echo "→ Generating $LANG/$FRAMEWORK stack into $OUTDIR"
node --experimental-strip-types --no-warnings \
  --import ./src/lib/generators/__tests__/loader.mjs \
  -e "
    import { generate } from './src/lib/generators/index.ts';
    import { writeFileSync, mkdirSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    const config = {
      name: 'smoke-app',
      language: '$LANG',
      framework: '$FRAMEWORK',
      database: 'postgres',
      cache: 'redis',
      queue: 'rabbitmq',
      api: 'rest',
      auth: 'none',
      deployment: 'k8s',
      scaling: 'horizontal',
      monitoring: 'prometheus',
      cicd: 'github-actions',
      docker: true, kubernetes: false, helm: false,
      tracing: false, rateLimit: false, audit: false,
      autoscale: false, replicas: 1, region: 'us-east-1',
      envVars: [],
    };
    const endpoints = [{ id: '1', method: 'GET', path: '/health', summary: 'Health', auth: false }];
    const files = generate(config, endpoints);
    const out = '$OUTDIR';
    for (const f of files) {
      const p = join(out, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    console.log(files.length + ' files written to ' + out);
  "

echo "→ Running $LANG smoke build"
case "$LANG" in
  typescript)
    cd "$OUTDIR"
    npm install --silent
    npx tsc --noEmit --skipLibCheck
    echo "✓ TypeScript typechecks clean"
    ;;
  go)
    cd "$OUTDIR"
    go mod tidy
    go build ./...
    echo "✓ Go builds clean"
    ;;
  python)
    cd "$OUTDIR"
    pip install -r requirements.txt -q
    python -m py_compile $(find . -name "*.py" | head -20)
    echo "✓ Python syntax clean"
    ;;
  rust)
    cd "$OUTDIR"
    cargo check
    echo "✓ Rust checks clean"
    ;;
  java)
    cd "$OUTDIR"
    chmod +x mvnw 2>/dev/null || true
    ./mvnw compile -q 2>/dev/null || mvn compile -q
    echo "✓ Java compiles clean"
    ;;
  kotlin)
    cd "$OUTDIR"
    chmod +x gradlew 2>/dev/null || true
    ./gradlew compileKotlin -q 2>/dev/null || gradle compileKotlin -q
    echo "✓ Kotlin compiles clean"
    ;;
  *)
    echo "Unknown language: $LANG. Supported: typescript go python rust java kotlin"
    exit 1
    ;;
esac

echo "✓ Smoke passed for $LANG/$FRAMEWORK"

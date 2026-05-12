import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toSnake } from "../types";
import { initialMigrationSql, dialectFor } from "./sql";

/**
 * Emits migration scaffolding for the selected language + database.
 * Skipped when:
 *   - The user picked a schemaless DB (MongoDB, DynamoDB) — migrations N/A.
 *   - There are no entities (nothing to migrate yet).
 *
 * Returns an empty list in skip cases so the caller can unconditionally
 * `push(...migrationFiles(...))`.
 */
export function migrationFiles(config: StackConfig, entities: Entity[]): GeneratedFile[] {
  if (entities.length === 0) return [];
  if (/mongo|dynamo|redis/i.test(config.database)) return [];

  const dialect = dialectFor(config.database);
  const { up, down } = initialMigrationSql(entities, dialect);

  switch (config.language) {
    case "go":
      return goMigrationFiles(config, up, down);
    case "python":
      return pythonMigrationFiles(config, entities, up, down);
    case "rust":
      return rustMigrationFiles(up, down);
    case "java":
      return javaMigrationFiles(up);
    case "kotlin":
      return kotlinMigrationFiles(up);
    case "typescript":
      return typescriptMigrationFiles(entities);
  }
}

// ─── Go (golang-migrate) ─────────────────────────────────────────────────────

function goMigrationFiles(config: StackConfig, up: string, down: string): GeneratedFile[] {
  const module = `github.com/your-org/${safeName(config.name)}`;
  return [
    { path: "migrations/000001_init.up.sql", content: up },
    { path: "migrations/000001_init.down.sql", content: down },
    {
      path: "cmd/migrate/main.go",
      content: `package main

// Runs database migrations using golang-migrate.
//
// Usage:
//   go run ./cmd/migrate up       # apply all pending migrations
//   go run ./cmd/migrate down 1   # rollback the last migration
//   go run ./cmd/migrate version  # print current schema version
//
// In CI / production this is typically run as a Kubernetes Job before the
// rolling deployment of the API Deployment — see deploy/k8s for an example
// Job template.

import (
\t"errors"
\t"log"
\t"os"
\t"strconv"

\t"github.com/golang-migrate/migrate/v4"
\t_ "github.com/golang-migrate/migrate/v4/database/postgres"
\t_ "github.com/golang-migrate/migrate/v4/source/file"

\t"${module}/internal/config"
)

func main() {
\tcfg := config.Load()
\tif cfg.DatabaseURL == "" {
\t\tlog.Fatal("DATABASE_URL must be set to run migrations")
\t}

\tm, err := migrate.New("file://migrations", cfg.DatabaseURL)
\tif err != nil {
\t\tlog.Fatalf("open migrations: %v", err)
\t}
\tdefer func() {
\t\tif srcErr, dbErr := m.Close(); srcErr != nil || dbErr != nil {
\t\t\tlog.Printf("close migrate: src=%v db=%v", srcErr, dbErr)
\t\t}
\t}()

\tcmd := "up"
\tif len(os.Args) > 1 {
\t\tcmd = os.Args[1]
\t}

\tswitch cmd {
\tcase "up":
\t\tif err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
\t\t\tlog.Fatalf("migrate up: %v", err)
\t\t}
\t\tlog.Println("migrations applied")
\tcase "down":
\t\tn := 1
\t\tif len(os.Args) > 2 {
\t\t\tvar err error
\t\t\tn, err = strconv.Atoi(os.Args[2])
\t\t\tif err != nil {
\t\t\t\tlog.Fatalf("invalid step count: %v", err)
\t\t\t}
\t\t}
\t\tif err := m.Steps(-n); err != nil {
\t\t\tlog.Fatalf("migrate down: %v", err)
\t\t}
\t\tlog.Printf("rolled back %d migrations", n)
\tcase "version":
\t\tv, dirty, err := m.Version()
\t\tif err != nil {
\t\t\tlog.Fatalf("version: %v", err)
\t\t}
\t\tlog.Printf("schema version: %d (dirty=%t)", v, dirty)
\tdefault:
\t\tlog.Fatalf("unknown subcommand: %s (want up/down/version)", cmd)
\t}
}
`,
    },
  ];
}

// ─── Python (Alembic) ────────────────────────────────────────────────────────

function pythonMigrationFiles(
  config: StackConfig,
  entities: Entity[],
  up: string,
  down: string
): GeneratedFile[] {
  const rev = "0001_init";
  // Convert SQL UP/DOWN into op.execute() calls. Alembic version files are
  // Python, so we quote the SQL as a triple-quoted string.
  const upLines = up
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .map((l) => l.trim());
  const downLines = down
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--"))
    .map((l) => l.trim());

  return [
    {
      path: "alembic.ini",
      content: `[alembic]
script_location = migrations
prepend_sys_path = .
sqlalchemy.url = %(DATABASE_URL)s

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console
qualname =

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
`,
    },
    {
      path: "migrations/env.py",
      content: `"""Alembic migration environment."""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config

# Pull DATABASE_URL from the environment rather than alembic.ini so production
# deploys can inject a secret via a Secret-mounted env var.
if (db_url := os.environ.get("DATABASE_URL")):
    config.set_main_option("sqlalchemy.url", db_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None  # use raw SQL for the initial migration


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
`,
    },
    {
      path: "migrations/script.py.mako",
      content: `"""\${message}

Revision ID: \${up_revision}
Revises: \${down_revision | comma,n}
Create Date: \${create_date}

"""
from alembic import op
import sqlalchemy as sa
\${imports if imports else ""}

revision = \${repr(up_revision)}
down_revision = \${repr(down_revision)}
branch_labels = \${repr(branch_labels)}
depends_on = \${repr(depends_on)}


def upgrade() -> None:
    \${upgrades if upgrades else "pass"}


def downgrade() -> None:
    \${downgrades if downgrades else "pass"}
`,
    },
    {
      path: `migrations/versions/${rev}.py`,
      content: `"""initial schema

Revision ID: ${rev}
Create Date: 2024-01-01 00:00:00.000000
"""
from alembic import op

revision = ${JSON.stringify(rev)}
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
${upLines.map((l) => `    op.execute(${JSON.stringify(l)})`).join("\n") || "    pass"}


def downgrade() -> None:
${downLines.map((l) => `    op.execute(${JSON.stringify(l)})`).join("\n") || "    pass"}
`,
    },
  ];
}

// ─── Rust (sqlx) ─────────────────────────────────────────────────────────────

function rustMigrationFiles(up: string, down: string): GeneratedFile[] {
  // sqlx migrate uses timestamped filenames. A fixed timestamp keeps
  // generated output deterministic; users can regenerate with `sqlx migrate add`.
  const ts = "20240101000001";
  return [
    { path: `migrations/${ts}_init.up.sql`, content: up },
    { path: `migrations/${ts}_init.down.sql`, content: down },
  ];
}

// ─── Java (Flyway) ───────────────────────────────────────────────────────────

function javaMigrationFiles(up: string): GeneratedFile[] {
  return [
    // Flyway picks up anything matching V<n>__<name>.sql under the classpath
    // db/migration dir; Spring Boot auto-runs it on startup once we add the
    // flyway-core dependency (see Phase 4.3 for pom.xml wiring).
    { path: "src/main/resources/db/migration/V1__init.sql", content: up },
  ];
}

// ─── Kotlin (Flyway) ─────────────────────────────────────────────────────────

function kotlinMigrationFiles(up: string): GeneratedFile[] {
  return [{ path: "src/main/resources/db/migration/V1__init.sql", content: up }];
}

// ─── TypeScript (Prisma seed) ────────────────────────────────────────────────

function typescriptMigrationFiles(entities: Entity[]): GeneratedFile[] {
  // Prisma owns migration files — we don't hand-write them. Instead we add a
  // seed script that users can extend, and rely on `prisma migrate dev` for
  // schema evolution (wired in package.json scripts elsewhere).
  const seedBody = entities
    .map((e) => {
      const varName = toSnake(e.name);
      return `  // await prisma.${varName[0].toLowerCase() + varName.slice(1)}.create({ data: { /* ... */ } });`;
    })
    .join("\n");

  return [
    {
      path: "prisma/seed.ts",
      content: `/**
 * Prisma seed script. Runs via \`npx prisma db seed\` after migrations.
 *
 * Uncomment and fill the examples below to insert dev fixtures. The generated
 * package.json wires this script via the \`prisma\` field so \`prisma db seed\`
 * picks it up automatically.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database…");
${seedBody}
  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
`,
    },
  ];
}

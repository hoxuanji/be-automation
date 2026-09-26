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
  const module = `github.com/your-username/${safeName(config.name)}`;
  // golang-migrate picks its database driver from the URL scheme, so map
  // DATABASE_URL onto the scheme of the driver we import.
  const dialect = dialectFor(config.database);
  const cockroach = config.database === "cockroach";
  const driver = dialect === "mysql" ? "mysql" : cockroach ? "cockroachdb" : "pgx/v5";
  const urlFn =
    dialect === "mysql"
      ? `
// migrateURL turns mysql://user:pass@host:3306/db?k=v (the .env.example form)
// into mysql://user:pass@tcp(host:3306)/db?k=v, which golang-migrate expects.
func migrateURL(raw string) (string, error) {
\tif !strings.HasPrefix(raw, "mysql://") || strings.Contains(raw, "@tcp(") {
\t\treturn raw, nil
\t}
\tu, err := url.Parse(raw)
\tif err != nil {
\t\treturn "", err
\t}
\tpass, _ := u.User.Password()
\tout := "mysql://" + u.User.Username() + ":" + pass + "@tcp(" + u.Host + ")" + u.Path
\tq := u.Query()${config.database === "planetscale" ? `
\tif q.Get("tls") == "" {
\t\tq.Set("tls", "true") // PlanetScale only accepts TLS connections
\t}` : ""}
\tif len(q) > 0 {
\t\tout += "?" + q.Encode()
\t}
\treturn out, nil
}
`
      : cockroach
        ? `
// migrateURL swaps postgres:// for cockroachdb:// so golang-migrate uses its
// CockroachDB driver (the postgres driver's advisory locks are unsupported).
func migrateURL(raw string) (string, error) {
\tif _, rest, ok := strings.Cut(raw, "://"); ok {
\t\treturn "cockroachdb://" + rest, nil
\t}
\treturn raw, nil
}
`
        : `
// migrateURL swaps the scheme for pgx5:// so golang-migrate connects with pgx,
// like the app does (lib/pq's sslmode=require default rejects a local Postgres).
func migrateURL(raw string) (string, error) {
\tif _, rest, ok := strings.Cut(raw, "://"); ok {
\t\treturn "pgx5://" + rest, nil
\t}
\treturn raw, nil
}
`;
  const base: GeneratedFile[] = [
    { path: "migrations/000001_init.up.sql", content: up },
    { path: "migrations/000001_init.down.sql", content: down },
    {
      // Embedded so the api binary carries its own schema: it migrates at
      // startup, with no file paths or extra step in compose, k8s or locally.
      path: "migrations/migrations.go",
      content: `// Package migrations embeds the SQL migrations into the binaries.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
`,
    },
  ];
  if (dialect === "sqlite") return [...base, ...goSqliteMigrateFiles(module)];
  return [
    ...base,
    {
      path: "internal/db/migrate.go",
      content: `package db

import (
\t"errors"
\t"fmt"
${dialect === "mysql" ? '\t"net/url"\n' : ""}\t"strings"

\t"github.com/golang-migrate/migrate/v4"
\t_ "github.com/golang-migrate/migrate/v4/database/${driver}"
\t"github.com/golang-migrate/migrate/v4/source/iofs"

\t"${module}/migrations"
)

// NewMigrate opens golang-migrate on the embedded migrations/*.sql.
func NewMigrate(databaseURL string) (*migrate.Migrate, error) {
\tdbURL, err := migrateURL(databaseURL)
\tif err != nil {
\t\treturn nil, fmt.Errorf("DATABASE_URL: %w", err)
\t}
\tsrc, err := iofs.New(migrations.FS, ".")
\tif err != nil {
\t\treturn nil, err
\t}
\treturn migrate.NewWithSourceInstance("iofs", src, dbURL)
}

// Migrate applies pending migrations; the api runs it before serving. Safe with
// many replicas: golang-migrate holds a database lock while migrating (advisory
// lock on Postgres, GET_LOCK on MySQL), so one replica applies the migrations
// and the others find nothing to do.
func Migrate(databaseURL string) error {
\tm, err := NewMigrate(databaseURL)
\tif err != nil {
\t\treturn err
\t}
\tdefer m.Close()
\tif err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
\t\treturn fmt.Errorf("migrate up: %w", err)
\t}
\treturn nil
}
${urlFn}`,
    },
    {
      path: "cmd/migrate/main.go",
      content: `package main

// Runs the embedded database migrations using golang-migrate. The api applies
// pending migrations itself at startup; use this to inspect or roll back.
//
// Usage:
//   go run ./cmd/migrate up       # apply all pending migrations
//   go run ./cmd/migrate down 1   # rollback the last migration
//   go run ./cmd/migrate version  # print current schema version

import (
\t"errors"
\t"log"
\t"os"
\t"strconv"

\t"github.com/golang-migrate/migrate/v4"

\t"${module}/internal/config"
\t"${module}/internal/db"
)

func main() {
\tcfg, err := config.Load()
\tif err != nil {
\t\tlog.Fatalf("config: %v", err)
\t}
\tif cfg.DatabaseURL == "" {
\t\tlog.Fatal("DATABASE_URL must be set to run migrations")
\t}

\tm, err := db.NewMigrate(cfg.DatabaseURL)
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

// golang-migrate's sqlite driver links modernc.org/sqlite, which registers the
// same database/sql name ("sqlite") as the app's glebarez driver, so the api
// would panic at init. SQLite is one file behind one process, so a small
// forward-only runner over the embedded files is enough.
function goSqliteMigrateFiles(module: string): GeneratedFile[] {
  return [
    {
      path: "internal/db/migrate.go",
      content: `package db

import (
\t"database/sql"
\t"fmt"
\t"io/fs"

\t"${module}/migrations"
)

// Migrate applies the embedded *.up.sql files not yet recorded in
// applied_migrations, in file-name order, each in its own transaction; the api
// runs it before serving.
func Migrate(databaseURL string) error {
\tconn, err := sql.Open("sqlite", databaseURL) // registered by glebarez/sqlite (gorm.go)
\tif err != nil {
\t\treturn err
\t}
\tdefer conn.Close()
\tif _, err := conn.Exec("CREATE TABLE IF NOT EXISTS applied_migrations (version TEXT PRIMARY KEY)"); err != nil {
\t\treturn fmt.Errorf("migrate: %w", err)
\t}
\tfiles, err := fs.Glob(migrations.FS, "*.up.sql")
\tif err != nil {
\t\treturn err
\t}
\tfor _, f := range files {
\t\tvar n int
\t\tif err := conn.QueryRow("SELECT COUNT(*) FROM applied_migrations WHERE version = ?", f).Scan(&n); err != nil {
\t\t\treturn fmt.Errorf("migrate: %w", err)
\t\t}
\t\tif n > 0 {
\t\t\tcontinue
\t\t}
\t\tbody, err := migrations.FS.ReadFile(f)
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t\ttx, err := conn.Begin()
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t\tif _, err := tx.Exec(string(body)); err != nil {
\t\t\t_ = tx.Rollback()
\t\t\treturn fmt.Errorf("migrate %s: %w", f, err)
\t\t}
\t\tif _, err := tx.Exec("INSERT INTO applied_migrations (version) VALUES (?)", f); err != nil {
\t\t\t_ = tx.Rollback()
\t\t\treturn fmt.Errorf("migrate %s: %w", f, err)
\t\t}
\t\tif err := tx.Commit(); err != nil {
\t\t\treturn fmt.Errorf("migrate %s: %w", f, err)
\t\t}
\t}
\treturn nil
}
`,
    },
    {
      path: "cmd/migrate/main.go",
      content: `package main

// Applies pending database migrations (the api also does this at startup).
// SQLite is forward-only here: roll back by running migrations/*.down.sql.

import (
\t"log"

\t"${module}/internal/config"
\t"${module}/internal/db"
)

func main() {
\tcfg, err := config.Load()
\tif err != nil {
\t\tlog.Fatalf("config: %v", err)
\t}
\tif err := db.Migrate(cfg.DatabaseURL); err != nil {
\t\tlog.Fatal(err)
\t}
\tlog.Println("migrations applied")
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

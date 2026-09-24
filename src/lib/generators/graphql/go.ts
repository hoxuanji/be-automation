import type { Entity, GeneratedFile, StackConfig } from "../types";
import { safeName, toSnake } from "../types";
import { primaryKey, pluralize } from "./schema";
import { fwImport, goImports, type GoFw } from "../go";

/**
 * Emits a Go GraphQL server skeleton built around gqlgen. We do NOT commit
 * gqlgen's generated code — users run `make gql` once after cloning. The
 * `graph/resolver.go` file contains hand-written resolver methods that read
 * from an in-memory store; gqlgen generates the surrounding scaffolding
 * (server types, exec.go, etc.) when the user runs codegen. This mirrors
 * the gRPC generator's "schema is committed, generated stubs are not" rule.
 */
export function goGraphqlFiles(
  config: StackConfig,
  entities: Entity[],
  rest: GeneratedFile[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const module = `github.com/your-username/${name}`;
  const fw = (["gin", "fiber", "echo", "chi"].includes(config.framework) ? config.framework : "gin") as GoFw;

  // `rest` is the REST tree built with no routes (cmd/api, config, server +
  // middleware, tracing, monitoring). Mount GraphQL next to /health so every
  // middleware in server.New (rate limit, audit, tracing, metrics) applies.
  const health = /^\tr\.\w+\("\/health", s\.health\)$/m;
  const files = rest.map((f) => {
    if (f.path !== "internal/server/server.go") return f;
    if (!health.test(f.content)) throw new Error("graphql/go: REST server.go has no /health route to mount GraphQL beside");
    return { ...f, content: f.content.replace(health, "$&\n\tmountGraphQL(r)") };
  });

  files.push({ path: "internal/server/graphql.go", content: goGraphqlMount(module, fw) });
  files.push({ path: "graph/resolver.go", content: goGraphqlResolverRoot(entities) });
  files.push({ path: "graph/health.go", content: goGraphqlHealth() });
  files.push({ path: "gqlgen.yml", content: goGqlgenYaml(module) });
  files.push({ path: "Makefile", content: goGraphqlMakefile() });

  for (const entity of entities) {
    files.push({
      path: `graph/${toSnake(entity.name)}.resolvers.go`,
      content: goGraphqlEntityResolver(entity),
    });
  }

  return files;
}

function goGraphqlMount(module: string, fw: GoFw): string {
  const mount: Record<GoFw, string> = {
    gin: `func mountGraphQL(r *gin.Engine) {\n\tr.Any("/graphql", gin.WrapH(graphQLHandler()))\n\tr.GET("/", gin.WrapH(playground.Handler("GraphQL", "/graphql")))\n}`,
    fiber: `func mountGraphQL(r *fiber.App) {\n\tr.All("/graphql", adaptor.HTTPHandler(graphQLHandler()))\n\tr.Get("/", adaptor.HTTPHandler(playground.Handler("GraphQL", "/graphql")))\n}`,
    echo: `func mountGraphQL(r *echo.Echo) {\n\tr.Any("/graphql", echo.WrapHandler(graphQLHandler()))\n\tr.GET("/", echo.WrapHandler(playground.Handler("GraphQL", "/graphql")))\n}`,
    chi: `func mountGraphQL(r chi.Router) {\n\tr.Handle("/graphql", graphQLHandler())\n\tr.Handle("/", playground.Handler("GraphQL", "/graphql"))\n}`,
  };
  const code = `// graphQLHandler serves the gqlgen executable schema. Run \`make gql\` once
// before \`go build\` so graph/generated.go and graph/models_gen.go exist.
func graphQLHandler() http.Handler {
\treturn handler.NewDefaultServer(graph.NewExecutableSchema(graph.Config{Resolvers: graph.NewResolver()}))
}

// mountGraphQL is called from New, after the middleware chain is installed.
${mount[fw]}
`;
  return `package server

${goImports(code, [["http", "net/http"]], [
    [fw, fwImport[fw]],
    ["adaptor", "github.com/gofiber/fiber/v2/middleware/adaptor"],
    ["handler", "github.com/99designs/gqlgen/graphql/handler"],
    ["playground", "github.com/99designs/gqlgen/graphql/playground"],
    ["graph", `${module}/graph`],
  ])}

${code}`;
}

function goGqlgenYaml(module: string): string {
  return `# gqlgen v0.17 config. Run \`make gql\` to (re)generate scaffolding.
# Schema lives outside the gqlgen tree so the same SDL serves the server
# and any external client codegen.
schema:
  - graphql/schema.graphql

exec:
  filename: graph/generated.go
  package: graph

model:
  filename: graph/models_gen.go
  package: graph

resolver:
  layout: follow-schema
  dir: graph
  package: graph
  filename_template: "{name}.resolvers.go"

autobind:
  - "${module}/graph"

models:
  ID:
    model:
      - github.com/99designs/gqlgen/graphql.ID
  DateTime:
    model:
      - github.com/99designs/gqlgen/graphql.Time
  JSON:
    model:
      - github.com/99designs/gqlgen/graphql.Any
`;
}

function goGraphqlMakefile(): string {
  return `.PHONY: gql gql-init run

# Run gqlgen against gqlgen.yml. Regenerates graph/generated.go and
# graph/models_gen.go from graphql/schema.graphql.
gql:
\tgo run github.com/99designs/gqlgen generate

# One-time bootstrap if you change scalars or model bindings.
gql-init:
\tgo run github.com/99designs/gqlgen init

run:
\tgo run ./cmd/api
`;
}

function goGraphqlResolverRoot(entities: Entity[]): string {
  // The resolver root is what gqlgen attaches Query/Mutation methods to
  // (those live in the per-entity *.resolvers.go files). Per-entity stores
  // are sync.Map values keyed by primary key string.
  const stores = entities.length === 0
    ? "\t// No entities — only the health resolver is defined."
    : entities
        .map((e) => `\t${storeFieldName(e.name)} sync.Map // map[string]*${e.name}`)
        .join("\n");

  return `package graph

// Resolver is the root resolver gqlgen attaches Query/Mutation methods to.
// Per-entity CRUD lives in <entity>.resolvers.go. We use sync.Map for the
// in-memory store so resolver methods can be called concurrently without
// extra locking. Replace these with real DB calls when wiring persistence.
${entities.length > 0 ? '\nimport "sync"\n' : ""}
type Resolver struct {
${stores}
}

func NewResolver() *Resolver {
\treturn &Resolver{}
}
`;
}

function goGraphqlHealth(): string {
  return `package graph

import "context"

// Health is hand-written rather than generated so we don't fight gqlgen's
// schema-first layout. The resolver method has the exact signature gqlgen
// expects from the Query type when "health: String!" is in the schema.
func (r *queryResolver) Health(ctx context.Context) (string, error) {
\treturn "ok", nil
}
`;
}

function goGraphqlEntityResolver(entity: Entity): string {
  const name = entity.name;
  const pk = primaryKey(entity);
  const store = storeFieldName(name);
  const plural = pluralize(name);

  // Note: these method signatures must match what gqlgen generates from the
  // SDL. queryResolver / mutationResolver are produced by `make gql`; we
  // attach methods to them here so the generated file is the schema's
  // single source of truth and our hand-written code is the behavior.
  return `package graph

// CRUD resolvers for ${name}. The signatures here must match what gqlgen
// generates from graphql/schema.graphql — if you change the schema, run
// \`make gql\` and update these methods accordingly.

import (
\t"context"
\t"fmt"

\t"github.com/google/uuid"
)

func (r *queryResolver) List${plural}(ctx context.Context, page *int, pageSize *int) (*${plural}Page, error) {
\tp := 1
\tps := 20
\tif page != nil {
\t\tp = *page
\t}
\tif pageSize != nil {
\t\tps = *pageSize
\t}
\tif p < 1 {
\t\tp = 1
\t}
\tif ps < 1 || ps > 100 {
\t\tps = 20
\t}

\titems := make([]*${name}, 0)
\tr.Resolver.${store}.Range(func(_, v any) bool {
\t\tif row, ok := v.(*${name}); ok {
\t\t\titems = append(items, row)
\t\t}
\t\treturn true
\t})
\tstart := (p - 1) * ps
\tif start > len(items) {
\t\tstart = len(items)
\t}
\tend := start + ps
\tif end > len(items) {
\t\tend = len(items)
\t}
\treturn &${plural}Page{
\t\tItems:    items[start:end],
\t\tTotal:    len(items),
\t\tPage:     p,
\t\tPageSize: ps,
\t}, nil
}

func (r *queryResolver) Get${name}(ctx context.Context, ${pk.name} string) (*${name}, error) {
\tif v, ok := r.Resolver.${store}.Load(${pk.name}); ok {
\t\treturn v.(*${name}), nil
\t}
\treturn nil, nil
}

func (r *mutationResolver) Create${name}(ctx context.Context, input Create${name}Input) (*${name}, error) {
\trow := mapCreate${name}(input)
\tif row.${goField(pk.name)} == "" {
\t\trow.${goField(pk.name)} = uuid.NewString()
\t}
\tr.Resolver.${store}.Store(row.${goField(pk.name)}, row)
\treturn row, nil
}

func (r *mutationResolver) Update${name}(ctx context.Context, input Update${name}Input) (*${name}, error) {
\tif _, ok := r.Resolver.${store}.Load(input.${goField(pk.name)}); !ok {
\t\treturn nil, fmt.Errorf("${name} %s not found", input.${goField(pk.name)})
\t}
\trow := mapUpdate${name}(input)
\tr.Resolver.${store}.Store(row.${goField(pk.name)}, row)
\treturn row, nil
}

func (r *mutationResolver) Delete${name}(ctx context.Context, ${pk.name} string) (bool, error) {
\t_, existed := r.Resolver.${store}.LoadAndDelete(${pk.name})
\treturn existed, nil
}

// mapCreate${name} / mapUpdate${name} convert generated input types to the
// model struct. Stub implementations — gqlgen will generate the input types
// alongside the model, so adapt these accordingly after \`make gql\`.
func mapCreate${name}(input Create${name}Input) *${name} {
\trow := &${name}{}
\t_ = input
\treturn row
}

func mapUpdate${name}(input Update${name}Input) *${name} {
\trow := &${name}{}
\t_ = input
\treturn row
}
`;
}

function storeFieldName(entityName: string): string {
  return entityName.toLowerCase() + "Store";
}

function goField(name: string): string {
  // gqlgen capitalizes the first letter for Go struct field names.
  return name[0].toUpperCase() + name.slice(1);
}

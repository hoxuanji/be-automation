import type { Entity, EntityField, GeneratedFile, StackConfig } from "../types";
import { safeName, toPascal, toSnake } from "../types";
import { primaryKey, pluralize } from "./schema";
import { fwImport, goImports, type GoFw } from "../go";

/**
 * Emits a Go GraphQL server built around gqlgen. We do NOT commit gqlgen's
 * generated code (graph/generated.go, graph/models_gen.go) — users run
 * `make gql` once after cloning, mirroring the gRPC "schema is committed,
 * generated stubs are not" rule.
 *
 * Resolvers persist through the same DB layer as the REST server: GORM +
 * internal/models on SQL databases, db.DocStore (MongoDB, or the in-memory
 * fallback) otherwise. gqlgen models and DB models are mapped explicitly in
 * graph/<entity>.go.
 */
export function goGraphqlFiles(
  config: StackConfig,
  entities: Entity[],
  rest: GeneratedFile[]
): GeneratedFile[] {
  const name = safeName(config.name);
  const module = `github.com/your-username/${name}`;
  const fw = (["gin", "fiber", "echo", "chi"].includes(config.framework) ? config.framework : "gin") as GoFw;

  // `rest` is the REST tree built with the entities but no endpoints: it opens
  // the database (gormDB / store) and ships the models, but its entity CRUD
  // handlers are replaced by GraphQL — drop them and their routes, then mount
  // GraphQL next to /health so every middleware in server.New applies.
  const backend: Backend =
    entities.length === 0 ? "none"
    : rest.some((f) => f.path === "internal/models/models.go") ? "gorm"
    : "docstore";
  const dbArg = backend === "gorm" ? "gormDB" : backend === "docstore" ? "store" : "";
  const health = /^\tr\.\w+\("\/health", s\.health\)$/m;
  const handlerRefs = entities.map((e) => new RegExp(`^.*\\b${lcFirst(e.name)}H\\b.*\\n`, "gm"));
  const files = rest
    .filter((f) => !f.path.startsWith("internal/handlers/"))
    .map((f) => {
      if (f.path !== "internal/server/server.go") return f;
      if (!health.test(f.content)) throw new Error("graphql/go: REST server.go has no /health route to mount GraphQL beside");
      let content = f.content
        .replace(health, `$&\n\tmountGraphQL(r${dbArg ? `, ${dbArg}` : ""})`)
        .replace(/^\t"[^"\n]*\/internal\/handlers"\n/m, "");
      for (const re of handlerRefs) content = content.replace(re, "");
      return { ...f, content: content.replace(/\n{3,}/g, "\n\n") };
    });

  files.push({ path: "internal/server/graphql.go", content: goGraphqlMount(module, fw, backend) });
  files.push({ path: "graph/resolver.go", content: goGraphqlResolverRoot(module, backend) });
  files.push({ path: "graph/schema.resolvers.go", content: goGraphqlResolvers(module, entities, backend) });
  files.push({ path: "gqlgen.yml", content: goGqlgenYaml(module) });
  // Standard gqlgen tool pin: without an import, `go mod tidy` drops gqlgen's own
  // dependencies from go.sum and `go run github.com/99designs/gqlgen generate` fails.
  files.push({ path: "tools.go", content: "//go:build tools\n\npackage tools\n\nimport (\n\t_ \"github.com/99designs/gqlgen\"\n)\n" });
  files.push({ path: "Makefile", content: goGraphqlMakefile() });

  for (const entity of entities) {
    files.push({ path: `graph/${toSnake(entity.name)}.go`, content: goGraphqlEntityMapping(module, entity, backend) });
  }

  return files;
}

type Backend = "gorm" | "docstore" | "none";

function goGraphqlMount(module: string, fw: GoFw, backend: Backend): string {
  const param = backend === "gorm" ? ", db *gorm.DB" : backend === "docstore" ? ", store db.DocStore" : "";
  const arg = backend === "gorm" ? "db" : backend === "docstore" ? "store" : "";
  const mount: Record<GoFw, string> = {
    gin: `func mountGraphQL(r *gin.Engine${param}) {\n\tr.Any("/graphql", gin.WrapH(graphQLHandler(${arg})))\n\tr.GET("/", gin.WrapH(playground.Handler("GraphQL", "/graphql")))\n}`,
    fiber: `func mountGraphQL(r *fiber.App${param}) {\n\tr.All("/graphql", adaptor.HTTPHandler(graphQLHandler(${arg})))\n\tr.Get("/", adaptor.HTTPHandler(playground.Handler("GraphQL", "/graphql")))\n}`,
    echo: `func mountGraphQL(r *echo.Echo${param}) {\n\tr.Any("/graphql", echo.WrapHandler(graphQLHandler(${arg})))\n\tr.GET("/", echo.WrapHandler(playground.Handler("GraphQL", "/graphql")))\n}`,
    chi: `func mountGraphQL(r chi.Router${param}) {\n\tr.Handle("/graphql", graphQLHandler(${arg}))\n\tr.Handle("/", playground.Handler("GraphQL", "/graphql"))\n}`,
  };
  const code = `// graphQLHandler serves the gqlgen executable schema. Run \`make gql\` once
// before \`go build\` so graph/generated.go and graph/models_gen.go exist.
func graphQLHandler(${param.slice(2)}) http.Handler {
\treturn handler.NewDefaultServer(graph.NewExecutableSchema(graph.Config{Resolvers: graph.NewResolver(${arg})}))
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
    ["gorm", "gorm.io/gorm"],
    ["db", `${module}/internal/db`],
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

function goGraphqlResolverRoot(module: string, backend: Backend): string {
  if (backend === "none") {
    return `package graph

// Resolver is the root resolver gqlgen attaches Query/Mutation methods to.
// No entities are defined, so only the health resolver exists.
type Resolver struct{}

func NewResolver() *Resolver {
\treturn &Resolver{}
}
`;
  }
  const field = backend === "gorm" ? "db *gorm.DB" : "store db.DocStore";
  const code = `// Resolver is the root resolver gqlgen attaches Query/Mutation methods to
// (graph/schema.resolvers.go). It holds the same database handle the REST
// server opens in internal/server.
type Resolver struct {
\t${field}
}

func NewResolver(${field}) *Resolver {
\treturn &Resolver{${backend === "gorm" ? "db: db" : "store: store"}}
}

// gqlErr is a GraphQL error with an extensions.code clients can switch on.
func gqlErr(code, msg string) error {
\treturn &gqlerror.Error{Message: msg, Extensions: map[string]any{"code": code}}
}

func notFound(entity string, id any) error {
\treturn gqlErr("NOT_FOUND", fmt.Sprintf("%s %v not found", entity, id))
}

func badInput(msg string) error { return gqlErr("BAD_USER_INPUT", msg) }

// lookupErr maps a missing row to NOT_FOUND and passes other errors through.
func lookupErr(err error, entity string, id any) error {
\tif errors.Is(err, ${backend === "gorm" ? "gorm.ErrRecordNotFound" : "db.ErrNotFound"}) {
\t\treturn notFound(entity, id)
\t}
\treturn err
}

// pageArgs applies the SDL defaults (page 1, pageSize 20) and caps pageSize at 100.
func pageArgs(page, pageSize *int) (int, int) {
\tp, ps := 1, 20
\tif page != nil && *page > 0 {
\t\tp = *page
\t}
\tif pageSize != nil && *pageSize > 0 {
\t\tps = min(*pageSize, 100)
\t}
\treturn p, ps
}

func gqlPtr[T any](v T) *T { return &v }

func gqlDeref[T any](p *T) T {
\tvar v T
\tif p != nil {
\t\tv = *p
\t}
\treturn v
}
${backend === "docstore" ? `
// toDoc / fromDoc convert between gqlgen structs and DocStore documents via
// their JSON field names (the same shape the REST handlers store).
func toDoc(v any) (map[string]any, error) {
\tb, err := json.Marshal(v)
\tif err != nil {
\t\treturn nil, err
\t}
\tvar doc map[string]any
\treturn doc, json.Unmarshal(b, &doc)
}

func fromDoc(doc map[string]any, out any) error {
\tb, err := json.Marshal(doc)
\tif err != nil {
\t\treturn err
\t}
\treturn json.Unmarshal(b, out)
}

func docID(doc map[string]any) string { return fmt.Sprint(doc["id"]) }
` : ""}`;
  return `package graph

${goImports(code, [["json", "encoding/json"], ["errors", "errors"], ["fmt", "fmt"]], [
    ["gqlerror", "github.com/vektah/gqlparser/v2/gqlerror"],
    backend === "gorm" ? ["gorm", "gorm.io/gorm"] : ["db", `${module}/internal/db`],
  ])}

${code}`;
}

// ─── Resolvers ───────────────────────────────────────────────────────────────

// graph/schema.resolvers.go is exactly the file gqlgen's follow-schema layout
// writes for graphql/schema.graphql: `make gql` copies these method bodies
// through (and would move any non-resolver code into a commented-out block,
// which is why the mapping helpers live in graph/<entity>.go).
function goGraphqlResolvers(module: string, entities: Entity[], backend: Backend): string {
  const methods = [
    `// Health is the resolver for the health field.
func (r *queryResolver) Health(ctx context.Context) (string, error) {
\treturn "ok", nil
}`,
    ...entities.flatMap((e) => (backend === "gorm" ? gormResolvers(e) : docResolvers(e))),
    `// Query returns QueryResolver implementation.
func (r *Resolver) Query() QueryResolver { return &queryResolver{r} }`,
  ];
  if (entities.length > 0) {
    methods.push(`// Mutation returns MutationResolver implementation.
func (r *Resolver) Mutation() MutationResolver { return &mutationResolver{r} }`);
  }
  const types = entities.length > 0
    ? "type mutationResolver struct{ *Resolver }\ntype queryResolver struct{ *Resolver }"
    : "type queryResolver struct{ *Resolver }";
  const code = `${methods.join("\n\n")}\n\n${types}\n`;
  return `package graph

// Laid out the way gqlgen writes graph/schema.resolvers.go: \`make gql\`
// copies these method bodies through when it regenerates this file. Keep
// helpers out of it (see graph/<entity>.go) — gqlgen comments them out.

${goImports(code, [["context", "context"], ["errors", "errors"], ["fmt", "fmt"], ["sort", "sort"], ["time", "time"]],
    backend === "gorm" ? [["gorm", "gorm.io/gorm"], ["models", `${module}/internal/models`]] : [["db", `${module}/internal/db`]])}

${code}`;
}

type Names = {
  T: string; Page: string; Create: string; Update: string; lc: string; pk: EntityField; pkGo: string; pkType: string;
  list: string; get: string; create: string; update: string; del: string;
};

function names(e: Entity): Names {
  const pk = primaryKey(e);
  return {
    T: gqlgenName(e.name),
    Page: gqlgenName(`${pluralize(e.name)}Page`),
    Create: gqlgenName(`Create${e.name}Input`),
    Update: gqlgenName(`Update${e.name}Input`),
    lc: lcFirst(e.name),
    pk,
    pkGo: gqlgenName(pk.name),
    pkType: gqlGoType(pk.type, true),
    list: gqlgenName(`list${pluralize(e.name)}`),
    get: gqlgenName(`get${e.name}`),
    create: gqlgenName(`create${e.name}`),
    update: gqlgenName(`update${e.name}`),
    del: gqlgenName(`delete${e.name}`),
  };
}

function gormResolvers(e: Entity): string[] {
  const n = names(e);
  const where = `"${toSnake(n.pk.name)} = ?"`;
  return [
    `// ${n.list} is the resolver for the ${lcFirst(n.list)} field.
func (r *queryResolver) ${n.list}(ctx context.Context, page *int, pageSize *int) (*${n.Page}, error) {
\tp, ps := pageArgs(page, pageSize)
\tvar total int64
\tif err := r.db.WithContext(ctx).Model(&models.${e.name}{}).Count(&total).Error; err != nil {
\t\treturn nil, err
\t}
\tvar rows []models.${e.name}
\tif err := r.db.WithContext(ctx).Order("${toSnake(n.pk.name)}").Limit(ps).Offset((p - 1) * ps).Find(&rows).Error; err != nil {
\t\treturn nil, err
\t}
\titems := make([]*${n.T}, len(rows))
\tfor i := range rows {
\t\titems[i] = ${n.lc}ToGQL(&rows[i])
\t}
\treturn &${n.Page}{Items: items, Total: int(total), Page: p, PageSize: ps}, nil
}`,
    `// ${n.get} is the resolver for the ${lcFirst(n.get)} field.
func (r *queryResolver) ${n.get}(ctx context.Context, ${n.pk.name} ${n.pkType}) (*${n.T}, error) {
\tvar row models.${e.name}
\terr := r.db.WithContext(ctx).First(&row, ${where}, ${n.pk.name}).Error
\tif errors.Is(err, gorm.ErrRecordNotFound) {
\t\treturn nil, nil
\t}
\tif err != nil {
\t\treturn nil, err
\t}
\treturn ${n.lc}ToGQL(&row), nil
}`,
    `// ${n.create} is the resolver for the ${lcFirst(n.create)} field.
func (r *mutationResolver) ${n.create}(ctx context.Context, input ${n.Create}) (*${n.T}, error) {
\tif err := validate${n.Create}(input); err != nil {
\t\treturn nil, err
\t}
\tvar row models.${e.name}
\tapply${n.Create}(&row, input)
\tif err := r.db.WithContext(ctx).Create(&row).Error; err != nil {
\t\treturn nil, err
\t}
\treturn ${n.lc}ToGQL(&row), nil
}`,
    `// ${n.update} is the resolver for the ${lcFirst(n.update)} field.
func (r *mutationResolver) ${n.update}(ctx context.Context, input ${n.Update}) (*${n.T}, error) {
\tif err := validate${n.Update}(input); err != nil {
\t\treturn nil, err
\t}
\tvar row models.${e.name}
\tif err := r.db.WithContext(ctx).First(&row, ${where}, input.${n.pkGo}).Error; err != nil {
\t\treturn nil, lookupErr(err, "${e.name}", input.${n.pkGo})
\t}
\tapply${n.Update}(&row, input)
\tif err := r.db.WithContext(ctx).Save(&row).Error; err != nil {
\t\treturn nil, err
\t}
\treturn ${n.lc}ToGQL(&row), nil
}`,
    `// ${n.del} is the resolver for the ${lcFirst(n.del)} field.
func (r *mutationResolver) ${n.del}(ctx context.Context, ${n.pk.name} ${n.pkType}) (bool, error) {
\tres := r.db.WithContext(ctx).Delete(&models.${e.name}{}, ${where}, ${n.pk.name})
\tif res.Error != nil {
\t\treturn false, res.Error
\t}
\tif res.RowsAffected == 0 {
\t\treturn false, notFound("${e.name}", ${n.pk.name})
\t}
\treturn true, nil
}`,
  ];
}

function docResolvers(e: Entity): string[] {
  const n = names(e);
  const coll = `${n.lc}Collection`;
  const idOf = (v: string) => (n.pkType === "string" ? v : `fmt.Sprint(${v})`);
  return [
    `// ${n.list} is the resolver for the ${lcFirst(n.list)} field.
func (r *queryResolver) ${n.list}(ctx context.Context, page *int, pageSize *int) (*${n.Page}, error) {
\tp, ps := pageArgs(page, pageSize)
\tdocs, err := r.store.List(ctx, ${coll})
\tif err != nil {
\t\treturn nil, err
\t}
\t// ponytail: DocStore.List has no paging, so we page in memory; push skip/limit into the store for large collections.
\tsort.Slice(docs, func(i, j int) bool { return docID(docs[i]) < docID(docs[j]) })
\tstart := min((p-1)*ps, len(docs))
\tend := min(start+ps, len(docs))
\titems := make([]*${n.T}, 0, end-start)
\tfor _, doc := range docs[start:end] {
\t\titem, err := ${n.lc}FromDoc(doc)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\titems = append(items, item)
\t}
\treturn &${n.Page}{Items: items, Total: len(docs), Page: p, PageSize: ps}, nil
}`,
    `// ${n.get} is the resolver for the ${lcFirst(n.get)} field.
func (r *queryResolver) ${n.get}(ctx context.Context, ${n.pk.name} ${n.pkType}) (*${n.T}, error) {
\tdoc, err := r.store.Get(ctx, ${coll}, ${idOf(n.pk.name)})
\tif errors.Is(err, db.ErrNotFound) {
\t\treturn nil, nil
\t}
\tif err != nil {
\t\treturn nil, err
\t}
\treturn ${n.lc}FromDoc(doc)
}`,
    `// ${n.create} is the resolver for the ${lcFirst(n.create)} field.
func (r *mutationResolver) ${n.create}(ctx context.Context, input ${n.Create}) (*${n.T}, error) {
\tif err := validate${n.Create}(input); err != nil {
\t\treturn nil, err
\t}
\tdoc, err := ${n.lc}ToDoc(input)
\tif err != nil {
\t\treturn nil, err
\t}
\tdoc, err = r.store.Create(ctx, ${coll}, doc)
\tif err != nil {
\t\treturn nil, err
\t}
\treturn ${n.lc}FromDoc(doc)
}`,
    `// ${n.update} is the resolver for the ${lcFirst(n.update)} field.
func (r *mutationResolver) ${n.update}(ctx context.Context, input ${n.Update}) (*${n.T}, error) {
\tif err := validate${n.Update}(input); err != nil {
\t\treturn nil, err
\t}
\tdoc, err := ${n.lc}ToDoc(input)
\tif err != nil {
\t\treturn nil, err
\t}
\tdoc, err = r.store.Update(ctx, ${coll}, ${idOf(`input.${n.pkGo}`)}, doc)
\tif err != nil {
\t\treturn nil, lookupErr(err, "${e.name}", input.${n.pkGo})
\t}
\treturn ${n.lc}FromDoc(doc)
}`,
    `// ${n.del} is the resolver for the ${lcFirst(n.del)} field.
func (r *mutationResolver) ${n.del}(ctx context.Context, ${n.pk.name} ${n.pkType}) (bool, error) {
\tif err := r.store.Delete(ctx, ${coll}, ${idOf(n.pk.name)}); err != nil {
\t\treturn false, lookupErr(err, "${e.name}", ${n.pk.name})
\t}
\treturn true, nil
}`,
  ];
}

// ─── Mapping between gqlgen models and the DB layer ─────────────────────────

function goGraphqlEntityMapping(module: string, e: Entity, backend: Backend): string {
  const n = names(e);
  const pkServer = n.pk.primaryKey && n.pk.type === "uuid";
  const createFields = e.fields.filter((f) => !(pkServer && f === n.pk));
  const updateFields = e.fields.filter((f) => f !== n.pk);

  // Required "string" fields must be non-empty — the same rule as the REST
  // validators (z.string().min(1)). Types and nullability are enforced by gqlgen.
  const validate = (input: string, fields: EntityField[]) => {
    const checks = fields
      .filter((f) => f.required && f.type === "string")
      .map((f) => `\tif in.${gqlgenName(f.name)} == "" {\n\t\treturn badInput("${f.name} must not be empty")\n\t}`);
    return `func validate${input}(in ${input}) error {\n${checks.join("\n")}${checks.length ? "\n" : ""}\treturn nil\n}`;
  };

  let code: string;
  if (backend === "gorm") {
    const keyW = Math.max(...e.fields.map((f) => gqlgenName(f.name).length)) + 1; // gofmt aligns key: value
    const toGQL = e.fields.map((f) => `\t\t${(gqlgenName(f.name) + ":").padEnd(keyW)} ${gormToGql(f, `m.${toPascal(f.name)}`)},`);
    const apply = (input: string, fields: EntityField[]) =>
      `func apply${input}(m *models.${e.name}, in ${input}) {\n${fields.map((f) => `\tm.${toPascal(f.name)} = ${gqlToGorm(f, `in.${gqlgenName(f.name)}`)}`).join("\n")}\n}`;
    code = `// ${n.lc}ToGQL maps the GORM row (internal/models) to the gqlgen model.
func ${n.lc}ToGQL(m *models.${e.name}) *${n.T} {
\treturn &${n.T}{
${toGQL.join("\n")}
\t}
}

${apply(n.Create, createFields)}

${apply(n.Update, updateFields)}

${validate(n.Create, createFields)}

${validate(n.Update, updateFields)}
${e.fields.some((f) => f.type === "json") ? `
func jsonBytes(v any) datatypes.JSON {
\tb, _ := json.Marshal(v) // v came from the JSON scalar, so it always marshals
\treturn b
}

func jsonValue(b datatypes.JSON) any {
\tvar v any
\t_ = json.Unmarshal(b, &v)
\treturn v
}
` : ""}`;
  } else {
    // DocStore documents are keyed by "id"; a differently named primary key is mirrored into it.
    const mirror = n.pk.name === "id" ? "" : `\tdoc["${n.pk.name}"] = doc["id"]\n`;
    code = `const ${n.lc}Collection = "${toSnake(e.name)}s"

func ${n.lc}ToDoc(input any) (map[string]any, error) {
${n.pk.name === "id" ? "\treturn toDoc(input)" : `\tdoc, err := toDoc(input)\n\tif v, ok := doc["${n.pk.name}"]; ok {\n\t\tdoc["id"] = v\n\t}\n\treturn doc, err`}
}

func ${n.lc}FromDoc(doc map[string]any) (*${n.T}, error) {
${mirror}\tvar out ${n.T}
\treturn &out, fromDoc(doc, &out)
}

${validate(n.Create, createFields)}

${validate(n.Update, updateFields)}
`;
  }

  const imports = goImports(code, [["json", "encoding/json"]], [
    ["datatypes", "gorm.io/datatypes"],
    ["models", `${module}/internal/models`],
  ]);
  return `package graph\n\n${imports === "import (\n\n)" ? "" : `${imports}\n\n`}${code}`;
}

// gqlgen Go type for a Helios field type (gqlgen.yml binds ID → string,
// DateTime → time.Time, JSON → any). Nullable scalars become pointers.
function gqlGoType(t: EntityField["type"], required: boolean): string {
  const base = { uuid: "string", string: "string", text: "string", number: "float64", boolean: "bool", date: "time.Time", json: "any" }[t];
  return required || t === "json" ? base : `*${base}`;
}

// internal/models stores numbers as int64 and JSON as datatypes.JSON; everything else matches.
function gormToGql(f: EntityField, v: string): string {
  const conv = f.type === "number" ? `float64(${v})` : f.type === "json" ? `jsonValue(${v})` : v;
  return f.required || f.type === "json" ? conv : `gqlPtr(${conv})`;
}

function gqlToGorm(f: EntityField, v: string): string {
  if (f.type === "json") return `jsonBytes(${v})`;
  const val = f.required ? v : `gqlDeref(${v})`;
  return f.type === "number" ? `int64(${val})` : val;
}

function lcFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : "";
}

// Port of gqlgen's templates.ToGo (v0.17.55): the Go identifier gqlgen
// derives for a GraphQL name — e.g. "id" → "ID", "listUsers" → "ListUsers",
// "userUrl" → "UserURL". Resolver method and model field names must match it.
const GO_INITIALISMS = new Set(
  "ACL API ASCII CPU CSS CSV DNS EOF GUID HTML HTTP HTTPS ICMP ID IP JSON KVK LHS PDF PGP QPS QR RAM RHS RPC SLA SMTP SQL SSH SVG TCP TLS TTL UDP UI UID URI URL UTF8 UUID VM XML XMPP XSRF XSS AWS GCP".split(" ")
);

export function gqlgenName(name: string): string {
  const isDelim = (c: string) => c === "-" || c === "_" || /\s/.test(c);
  const isLower = (c: string | undefined) => !!c && c !== c.toUpperCase() && c === c.toLowerCase();
  const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
  const isDigit = (c: string) => /[0-9]/.test(c);
  const runes = [...name.replace(/^[-_\s]+|[-_\s]+$/g, "")];
  let out = "";
  let w = 0;
  let i = 0;
  let hasCommon = false;
  while (i + 1 <= runes.length) {
    let eow = false;
    if (i + 1 === runes.length) {
      eow = true;
    } else if (isDelim(runes[i + 1])) {
      eow = true;
      let n = 1;
      while (i + n + 1 < runes.length && isDelim(runes[i + n + 1])) n++;
      if (i + n + 1 < runes.length && isDigit(runes[i]) && isDigit(runes[i + n + 1])) n--;
      runes.splice(i + 1, n);
    } else if (isLower(runes[i]) && !isLower(runes[i + 1])) {
      eow = true;
    }
    i++;
    const word = runes.slice(w, i).join("");
    if (!eow && GO_INITIALISMS.has(word) && !isLower(runes[i])) {
      // split IDFoo → ID, Foo
    } else if (!eow) {
      if (GO_INITIALISMS.has(word)) hasCommon = true;
      continue;
    }
    let match = false;
    const upper = word.toUpperCase();
    if (GO_INITIALISMS.has(upper)) {
      const rem = runes.slice(w);
      if ((upper === "ID" || upper === "IP") && word === rem.slice(0, 2).join("") && !eow && rem.length > 3 && isUpper(rem[3])) {
        continue;
      }
      hasCommon = true;
      match = true;
    }
    if (match) out += upper;
    else if (!hasCommon && (upper === word || word.toLowerCase() === word)) out += word[0].toUpperCase() + word.slice(1).toLowerCase();
    else out += word;
    hasCommon = false;
    w = i;
  }
  return out;
}

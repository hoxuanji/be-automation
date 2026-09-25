import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab, toCamel } from "./types";
import { needsAuth } from "./auth/providers";
import { springPath, methodAnnotation, handlerMethodName } from "./java";
import {
  ktInfra, type KtInfra, ktorInfraDeps, ktorWorkerTask, ktorModuleParams, ktorModuleInstalls, ktorModuleTail, ktorHealthRoute,
  ktorInfraFiles, ktorTestFakes, springKtInfraDeps, springKtInfraProps, springKtInfraTestProps, springKtInfraFiles, springKtInfraTestFiles,
} from "./kotlin-infra";

const isMysql = (db: string) => /mysql|planetscale/.test(db);

// Endpoint stubs are emitted only when no entity CRUD routes own the paths
// (same rule as Spring Java); /health is always served by the template.
function stubEndpoints(endpoints: Endpoint[], entities: Entity[]): Endpoint[] {
  return entities.length === 0 ? endpoints.filter((e) => e.path !== "/health") : [];
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function kotlinFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  if (config.framework === "spring-kt") {
    return springKtFiles(config, endpoints, entities);
  }
  return ktorFiles(config, endpoints, entities);
}

// ─── Ktor generator ───────────────────────────────────────────────────────────

function ktorFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  const safe = safeName(config.name);
  const files: GeneratedFile[] = [];
  const withAuth = needsAuth(config, endpoints.some((e) => e.auth));
  const mysql = isMysql(config.database);
  const metrics = config.monitoring === "grafana";
  const infra = ktInfra(config);

  files.push({ path: "build.gradle.kts", content: ktorBuildGradle(safe, withAuth, mysql, metrics, infra) });
  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${safe}"\n` });
  files.push({ path: "Dockerfile", content: ktorDockerfile() });
  files.push({
    path: "src/main/kotlin/Application.kt",
    content: ktorApplication(entities, stubEndpoints(endpoints, entities), withAuth, metrics, infra),
  });
  files.push(...ktorInfraFiles(infra, safe, withAuth));
  files.push({ path: "src/main/kotlin/Database.kt", content: ktorDatabase(safe, entities, mysql) });
  if (withAuth) {
    files.push({ path: "src/main/kotlin/Auth.kt", content: ktorAuth() });
  }
  files.push({ path: "src/test/kotlin/TestSupport.kt", content: ktorTestSupport(withAuth, mysql, infra) });
  files.push({
    path: "src/test/kotlin/ApplicationTest.kt",
    content: ktorApplicationTest(entities, stubEndpoints(endpoints, entities), withAuth, infra),
  });

  for (const entity of entities) {
    files.push({
      path: `src/main/kotlin/models/${toPascal(entity.name)}.kt`,
      content: ktorModel(entity),
    });
    files.push({
      path: `src/main/kotlin/routes/${toSnake(entity.name)}Routes.kt`,
      content: ktorRoutes(entity, infra),
    });
    files.push({
      path: `src/test/kotlin/${toPascal(entity.name)}RouteTest.kt`,
      content: ktorTest(entity, withAuth),
    });
  }

  return files;
}

// ─── build.gradle.kts ────────────────────────────────────────────────────────

function ktorBuildGradle(safeName: string, withAuth: boolean, mysql: boolean, metrics: boolean, infra: KtInfra): string {
  void safeName;
  const authDeps = withAuth
    ? `    // JWT verification against the provider's JWKS (see Auth.kt).
    implementation("io.ktor:ktor-server-auth:\$ktor_version")
    implementation("io.ktor:ktor-server-auth-jwt:\$ktor_version")
`
    : "";
  const metricsDeps = metrics
    ? `    // Prometheus metrics at /metrics.
    implementation("io.ktor:ktor-server-metrics-micrometer:\$ktor_version")
    implementation("io.micrometer:micrometer-registry-prometheus:1.12.5")
`
    : "";
  return `plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("com.gradleup.shadow") version "8.3.5"
    application
}

application { mainClass.set("ApplicationKt") }

repositories { mavenCentral() }

val ktor_version = "2.3.12"
val exposed_version = "0.55.0"

dependencies {
    implementation("io.ktor:ktor-server-core:\$ktor_version")
    implementation("io.ktor:ktor-server-netty:\$ktor_version")
    implementation("io.ktor:ktor-server-content-negotiation:\$ktor_version")
    implementation("io.ktor:ktor-serialization-kotlinx-json:\$ktor_version")
    implementation("io.ktor:ktor-server-status-pages:\$ktor_version")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.exposed:exposed-core:\$exposed_version")
    implementation("org.jetbrains.exposed:exposed-dao:\$exposed_version")
    implementation("org.jetbrains.exposed:exposed-jdbc:\$exposed_version")
    implementation("org.jetbrains.exposed:exposed-java-time:\$exposed_version")
    implementation("${mysql ? "com.mysql:mysql-connector-j:8.4.0" : "org.postgresql:postgresql:42.7.4"}")
    implementation("com.zaxxer:HikariCP:5.1.0")
    implementation("ch.qos.logback:logback-classic:1.5.8")
${authDeps}${metricsDeps}${ktorInfraDeps(infra)}    testImplementation("io.ktor:ktor-server-test-host:\$ktor_version")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")
    // In-memory stand-in for Postgres/MySQL so \`gradle test\` needs no services (see TestSupport.kt).
    testImplementation("com.h2database:h2:2.3.232")
}
${ktorWorkerTask(infra)}`;
}

// ─── Dockerfile ──────────────────────────────────────────────────────────────

function ktorDockerfile(): string {
  return `FROM gradle:8.10-jdk21 AS build
WORKDIR /src
COPY build.gradle.kts settings.gradle.kts ./
RUN gradle dependencies --no-daemon -q 2>/dev/null || true
COPY src ./src
RUN gradle shadowJar --no-daemon -q

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app
COPY --from=build --chown=app:app /src/build/libs/*-all.jar app.jar
EXPOSE 8080
USER app
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
}

// ─── Application.kt ──────────────────────────────────────────────────────────

function ktorApplication(entities: Entity[], stubs: Endpoint[], withAuth: boolean, metrics: boolean, infra: KtInfra): string {
  const stub = (e: Endpoint, indent: string) => {
    const fn = ["get", "post", "put", "patch", "delete"].includes(e.method.toLowerCase()) ? e.method.toLowerCase() : "get";
    return `${indent}${fn}(${JSON.stringify(springPath(e.path))}) { call.respond(mapOf("op" to "${e.method} ${e.path}")) }`;
  };
  const routeArgs = [infra.redis && "cache", infra.queue && "queue"].filter(Boolean).join(", ");
  const entityCalls = (indent: string) => entities.map((e) => `${indent}${toCamel(e.name)}Routes(${routeArgs})`);

  const lines: string[] = [];
  lines.push(...stubs.filter((e) => !(withAuth && e.auth)).map((e) => stub(e, "        ")));
  if (withAuth) {
    const inner = [
      ...stubs.filter((e) => e.auth).map((e) => stub(e, "            ")),
      ...entityCalls("            "),
    ];
    if (inner.length > 0) {
      lines.push(`        authenticate("auth-jwt") {\n${inner.join("\n")}\n        }`);
    }
  } else {
    lines.push(...entityCalls("        "));
  }
  if (metrics) {
    lines.push(`        get("/metrics") { call.respond(appMicrometerRegistry.scrape()) }`);
  }
  const routeCallsBlock = lines.length > 0 ? `\n${lines.join("\n")}` : "";
  const imports = [
    withAuth ? "import io.ktor.server.auth.*" : "",
    metrics ? "import io.ktor.server.metrics.micrometer.*\nimport io.micrometer.prometheus.PrometheusConfig\nimport io.micrometer.prometheus.PrometheusMeterRegistry" : "",
  ].filter(Boolean).map((l) => l + "\n").join("");
  const installs = [
    ...ktorModuleInstalls(infra),
    withAuth ? "    configureAuth(jwtVerifier)" : "",
    metrics ? "    install(MicrometerMetrics) { registry = appMicrometerRegistry }" : "",
  ].filter(Boolean).map((l) => l + "\n").join("");

  const params = [withAuth && "jwtVerifier: JWTVerifier? = null", ...ktorModuleParams(infra)].filter(Boolean).join(", ");
  const tail = ktorModuleTail(infra);
  return `${withAuth ? "import com.auth0.jwt.interfaces.JWTVerifier\n" : ""}import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.routing.*
import io.ktor.server.response.*
${imports}import kotlinx.serialization.json.Json
${metrics ? "\nval appMicrometerRegistry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)\n" : ""}
fun main() {
    initDatabase()
    embeddedServer(Netty, port = System.getenv("PORT")?.toIntOrNull() ?: 8080, module = Application::module)
        .start(wait = true)
}

// Plugins + routing live here so tests can load them via testApplication { application { module() } }.
${withAuth ? "// jwtVerifier = null verifies against the provider's JWKS (env); tests pass a local-key verifier.\n" : ""}${infra.redis || infra.queue ? "// cache / queue default to the real clients (env); tests pass in-memory fakes (TestSupport.kt).\n" : ""}fun Application.module(${params}) {
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; coerceInputValues = true })
    }
${installs}    routing {
${ktorHealthRoute(infra)}${routeCallsBlock}
    }
${tail ? tail + "\n" : ""}}
`;
}

// ─── Database.kt ─────────────────────────────────────────────────────────────

function ktorDatabase(appName: string, entities: Entity[], mysql = false): string {
  const tableList = entities.map((e) => toPascal(e.name) + "s").join(", ");
  const schemaArg = tableList ? tableList : "/* no tables */";

  return `import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction

/**
 * Connect to the database with retry-on-startup. Kubernetes pods often boot
 * before the DB accepts connections; HikariCP would otherwise fail fast
 * and crash the app, triggering a pod restart loop.
 */
fun initDatabase() {
    val url = System.getenv("DATABASE_URL") ?: "${mysql ? `jdbc:mysql://localhost:3306/${appName}` : `jdbc:postgresql://localhost:5432/${appName}`}"
    val config = HikariConfig().apply {
        jdbcUrl = url
        maximumPoolSize = 20
        minimumIdle = 2
        connectionTimeout = 10_000
        idleTimeout = 600_000
        maxLifetime = 1_800_000
        validationTimeout = 5_000
    }

    var delay = 200L
    var lastErr: Throwable? = null
    for (attempt in 1..6) {
        try {
            val ds = HikariDataSource(config)
            Database.connect(ds)
            createSchema()
            return
        } catch (e: Throwable) {
            lastErr = e
            println("db: connect attempt \${attempt}/6 failed: \${e.message} — retrying in \${delay}ms")
            Thread.sleep(delay)
            delay = minOf(delay * 2, 5_000L)
        }
    }
    throw IllegalStateException("db: could not connect after retries", lastErr)
}

/** Readiness check: the database answers a trivial query. */
fun dbReady(): Boolean = runCatching { transaction { exec("SELECT 1") } }.isSuccess

/** Creates missing tables on the current connection. Shared with tests (TestSupport.kt). */
fun createSchema() {
    transaction {
        SchemaUtils.createMissingTablesAndColumns(${schemaArg})
    }
}
`;
}

// ─── Auth.kt ─────────────────────────────────────────────────────────────────

function ktorAuth(): string {
  return `import com.auth0.jwk.JwkProviderBuilder
import com.auth0.jwt.interfaces.JWTVerifier
import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.auth.jwt.*
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Verifies Bearer JWTs against the provider's JWKS (AUTH_JWKS_URL): signature,
 * exp, iss (AUTH_ISSUER) and — when set — aud (AUTH_AUDIENCE). Protected
 * routes sit inside \`authenticate("auth-jwt") { ... }\`.
 *
 * Pass \`jwtVerifier\` to trust a fixed key instead (tests do; see TestSupport.kt).
 */
fun Application.configureAuth(jwtVerifier: JWTVerifier? = null) {
    install(Authentication) {
        jwt("auth-jwt") {
            if (jwtVerifier != null) {
                verifier(jwtVerifier)
            } else {
                val issuer = requireNotNull(System.getenv("AUTH_ISSUER")) { "AUTH_ISSUER must be set" }
                val jwksUrl = requireNotNull(System.getenv("AUTH_JWKS_URL")) { "AUTH_JWKS_URL must be set" }
                val audience = System.getenv("AUTH_AUDIENCE")?.takeIf { it.isNotBlank() }
                val jwkProvider = JwkProviderBuilder(URI(jwksUrl).toURL())
                    .cached(10, 24, TimeUnit.HOURS)
                    .rateLimited(10, 1, TimeUnit.MINUTES)
                    .build()
                verifier(jwkProvider, issuer) {
                    acceptLeeway(3)
                    if (audience != null) withAudience(audience)
                }
            }
            validate { credential -> JWTPrincipal(credential.payload) }
        }
    }
}
`;
}

// ─── Field type helpers ───────────────────────────────────────────────────────

function ktDataClassType(field: EntityField): string {
  // UUID fields in @Serializable data classes are stored as String
  switch (field.type as FieldType) {
    case "uuid":    return "String";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "Double";
    case "boolean": return "Boolean";
    case "date":    return "String"; // ISO-8601 string for serialization simplicity
    case "json":    return "String"; // stored as JSON string
  }
}

function ktExposedColumn(field: EntityField): string {
  const col = toSnake(field.name);
  switch (field.type as FieldType) {
    case "uuid":    return `uuid("${col}").autoGenerate()`;
    case "string":  return `varchar("${col}", 255)`;
    case "text":    return `text("${col}")`;
    case "number":  return `double("${col}")`;
    case "boolean": return `bool("${col}")`;
    case "date":    return `timestamp("${col}")`;
    case "json":    return `text("${col}")`;
  }
}

function ktResultRowExtract(field: EntityField, tableObj: string): string {
  const camelName = toCamel(field.name);
  const colRef = `${tableObj}.${camelName}`;
  switch (field.type as FieldType) {
    case "uuid":    return `${camelName} = this[${colRef}].toString()`;
    case "string":  return `${camelName} = this[${colRef}]`;
    case "text":    return `${camelName} = this[${colRef}]`;
    case "number":  return `${camelName} = this[${colRef}]`;
    case "boolean": return `${camelName} = this[${colRef}]`;
    case "date":    return `${camelName} = this[${colRef}].toString()`;
    case "json":    return `${camelName} = this[${colRef}]`;
  }
}

// ─── models/{Pascal}.kt ───────────────────────────────────────────────────────

function ktorModel(entity: Entity): string {
  const pascal = toPascal(entity.name);
  const tableObj = pascal + "s";
  const tableName = toSnake(entity.name) + "s";

  const pkField = entity.fields.find((f) => f.primaryKey);
  const nonPkFields = entity.fields.filter((f) => !f.primaryKey);

  // Build exposed Table object columns
  const pkLine = pkField
    ? `    val ${toCamel(pkField.name)} = ${ktExposedColumn(pkField)}`
    : `    val id = uuid("id").autoGenerate()`;

  const nonPkLines = nonPkFields.map((f) => {
    let line = `    val ${toCamel(f.name)} = ${ktExposedColumn(f)}`;
    if (f.unique) line += ".uniqueIndex()";
    if (!f.required) line += ".nullable()"; // data class field is `T? = null`
    if (f.type === "json") line += " // JSON stored as text";
    return line;
  });

  const pkColName = pkField ? toCamel(pkField.name) : "id";

  const tableLines = [pkLine, ...nonPkLines].join("\n");

  // Build @Serializable data class fields
  const pkClassField = pkField
    ? `    val ${toCamel(pkField.name)}: String, // UUID serialized as String`
    : `    val id: String, // UUID serialized as String`;

  const nonPkClassFields = nonPkFields.map((f) => {
    const type = ktDataClassType(f);
    const nullable = !f.required ? "?" : "";
    const defaultVal = !f.required ? " = null" : "";
    const comment = f.type === "json" ? " // JSON string" : "";
    return `    val ${toCamel(f.name)}: ${type}${nullable}${defaultVal},${comment}`;
  });

  const dataClassFields = [pkClassField, ...nonPkClassFields].join("\n");

  // Build Create DTO (non-PK fields, required ones are non-nullable)
  const createFields = nonPkFields.map((f) => {
    const type = ktDataClassType(f);
    const nullable = !f.required ? "?" : "";
    const defaultVal = !f.required ? " = null" : "";
    const comment = f.type === "json" ? " // JSON string" : "";
    return `    val ${toCamel(f.name)}: ${type}${nullable}${defaultVal},${comment}`;
  });

  // Build Update DTO (all non-PK fields are nullable with defaults)
  const updateFields = nonPkFields.map((f) => {
    const type = ktDataClassType(f);
    const comment = f.type === "json" ? " // JSON string" : "";
    return `    val ${toCamel(f.name)}: ${type}? = null,${comment}`;
  });

  // Build ResultRow extension
  const rowExtractLines = [
    pkField
      ? `    ${toCamel(pkField.name)} = this[${tableObj}.${toCamel(pkField.name)}].toString()`
      : `    id = this[${tableObj}.id].toString()`,
    ...nonPkFields.map((f) => `    ${ktResultRowExtract(f, tableObj)}`),
  ].join(",\n");

  const needsTimestamp = nonPkFields.some((f) => f.type === "date");

  const timestampImport = needsTimestamp
    ? `import org.jetbrains.exposed.sql.javatime.timestamp\n`
    : "";

  const createDtoBlock =
    createFields.length > 0
      ? `@Serializable\ndata class Create${pascal}(\n${createFields.join("\n")}\n)`
      : `@Serializable\ndata class Create${pascal}(val placeholder: String? = null)`;

  const updateDtoBlock =
    updateFields.length > 0
      ? `@Serializable\ndata class Update${pascal}(\n${updateFields.join("\n")}\n)`
      : `@Serializable\ndata class Update${pascal}(val placeholder: String? = null)`;

  return `import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.Table
${timestampImport}
object ${tableObj} : Table("${tableName}") {
${tableLines}
    override val primaryKey = PrimaryKey(${pkColName})
}

@Serializable
data class ${pascal}(
${dataClassFields}
)

${createDtoBlock}

${updateDtoBlock}

fun org.jetbrains.exposed.sql.ResultRow.to${pascal}() = ${pascal}(
${rowExtractLines},
)
`;
}

// ─── routes/{snake}Routes.kt ──────────────────────────────────────────────────

function ktorRoutes(entity: Entity, infra: KtInfra): string {
  const pascal = toPascal(entity.name);
  const camelFn = toCamel(entity.name);
  const kebab = toKebab(entity.name);
  const tableObj = pascal + "s";

  const pkField = entity.fields.find((f) => f.primaryKey);
  const pkCol = pkField ? toCamel(pkField.name) : "id";

  const nonPkFields = entity.fields.filter((f) => !f.primaryKey);

  // DTOs carry uuid/date as String; the columns want UUID/Instant.
  const parse = (f: EntityField, v: string) =>
    f.type === "uuid" ? `UUID.fromString(${v})` : f.type === "date" ? `java.time.Instant.parse(${v})` : v;
  const needsParse = (f: EntityField) => f.type === "uuid" || f.type === "date";

  // Build insert body lines
  const insertLines = nonPkFields.map((f) => {
    const camelF = toCamel(f.name);
    const value = !needsParse(f) ? `body.${camelF}`
      : f.required ? parse(f, `body.${camelF}`)
      : `body.${camelF}?.let { v -> ${parse(f, "v")} }`;
    return `                    it[${camelF}] = ${value}`;
  });

  // Build update body lines
  const updateLines = nonPkFields.map((f) => {
    const camelF = toCamel(f.name);
    return `                    body.${camelF}?.let { v -> it[${camelF}] = ${parse(f, "v")} }`;
  });

  const insertBlock = insertLines.length > 0
    ? insertLines.join("\n")
    : `                    // no fields`;

  const updateBlock = updateLines.length > 0
    ? updateLines.join("\n")
    : `                    // no fields`;

  const cache = infra.redis;
  const params = [cache && "cache: Cache", infra.queue && "queue: JobQueue"].filter(Boolean).join(", ");
  const cacheKey = `"${kebab}s:$id"`;
  const getById = cache
    ? `            // Cache-aside: serve from Redis, else read the DB and populate it (60s TTL; writes evict).
            cache.get(${cacheKey})?.let { return@get call.respondText(it, ContentType.Application.Json) }
            val item = transaction {
                ${tableObj}.selectAll().where { ${tableObj}.${pkCol} eq id }.singleOrNull()?.to${pascal}()
            }
            if (item == null) call.respond(HttpStatusCode.NotFound)
            else {
                cache.set(${cacheKey}, Json.encodeToString(item))
                call.respond(item)
            }`
    : `            val item = transaction {
                ${tableObj}.selectAll().where { ${tableObj}.${pkCol} eq id }.singleOrNull()?.to${pascal}()
            }
            if (item == null) call.respond(HttpStatusCode.NotFound)
            else call.respond(item)`;
  const publish = infra.queue
    ? `\n            queue.publish("""{"event":"${kebab}.created","id":"\${item.${pkCol}}"}""")`
    : "";
  const evict = cache ? `\n            cache.delete(${cacheKey})` : "";

  return `import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
${cache ? "import kotlinx.serialization.encodeToString\nimport kotlinx.serialization.json.Json\n" : ""}import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

fun Route.${camelFn}Routes(${params}) {
    route("/${kebab}s") {
        get {
            val items = transaction { ${tableObj}.selectAll().map { it.to${pascal}() } }
            call.respond(items)
        }

        get("/{id}") {
            val id = call.parameters["id"]?.runCatching { UUID.fromString(this) }?.getOrNull()
                ?: return@get call.respond(HttpStatusCode.BadRequest)
${getById}
        }

        post {
            val body = call.receive<Create${pascal}>()
            val item = transaction {
                ${tableObj}.insert {
${insertBlock}
                }.resultedValues!!.single().to${pascal}() // no RETURNING: portable to MySQL and H2 (tests)
            }${publish}
            call.respond(HttpStatusCode.Created, item)
        }

        put("/{id}") {
            val id = call.parameters["id"]?.runCatching { UUID.fromString(this) }?.getOrNull()
                ?: return@put call.respond(HttpStatusCode.BadRequest)
            val body = call.receive<Update${pascal}>()
            val updated = transaction {
                val count = ${tableObj}.update({ ${tableObj}.${pkCol} eq id }) {
${updateBlock}
                }
                if (count == 0) null
                else ${tableObj}.selectAll().where { ${tableObj}.${pkCol} eq id }.single().to${pascal}()
            }${evict}
            if (updated == null) call.respond(HttpStatusCode.NotFound)
            else call.respond(updated)
        }

        delete("/{id}") {
            val id = call.parameters["id"]?.runCatching { UUID.fromString(this) }?.getOrNull()
                ?: return@delete call.respond(HttpStatusCode.BadRequest)
            val deleted = transaction { ${tableObj}.deleteWhere { ${tableObj}.${pkCol} eq id } }${evict}
            if (deleted == 0) call.respond(HttpStatusCode.NotFound)
            else call.respond(HttpStatusCode.NoContent)
        }
    }
}
`;
}

// ─── Test pattern ─────────────────────────────────────────────────────────────

function ktTestBody(entity: Entity): string {
  const nonPkRequired = entity.fields.filter((f) => !f.primaryKey && f.required);
  if (nonPkRequired.length === 0) {
    return `"""{}"""`;
  }
  const pairs = nonPkRequired.slice(0, 4).map((f) => {
    const name = toCamel(f.name);
    switch (f.type as FieldType) {
      case "string":  return `"${name}":"test"`;
      case "text":    return `"${name}":"test"`;
      case "number":  return `"${name}":1`;
      case "boolean": return `"${name}":true`;
      case "uuid":    return `"${name}":"00000000-0000-0000-0000-000000000001"`;
      case "date":    return `"${name}":"2024-01-01T00:00:00Z"`;
      case "json":    return `"${name}":"{}"`;
    }
  });
  return `"""{${pairs.join(",")}}"""`;
}

function ktorTest(entity: Entity, withAuth: boolean): string {
  const pascal = toPascal(entity.name);
  const kebab = toKebab(entity.name);
  const createBody = ktTestBody(entity);
  // Entity routes sit inside authenticate("auth-jwt") when auth is on.
  const authHeader = withAuth ? "\n            header(HttpHeaders.Authorization, \"Bearer \${TestAuth.token()}\")" : "";

  return `import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlin.test.*

class ${pascal}RouteTest {
    @Test
    fun testList${pascal}s() = testApplication {
        application { testModule() }
        val response = client.get("/${kebab}s") {${authHeader}
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun testCreate${pascal}() = testApplication {
        application { testModule() }
        val response = client.post("/${kebab}s") {${authHeader}
            contentType(ContentType.Application.Json)
            setBody(${createBody})
        }
        assertEquals(HttpStatusCode.Created, response.status)
    }
}
`;
}

// ─── src/test/kotlin/TestSupport.kt + ApplicationTest.kt ─────────────────────

function ktorTestSupport(withAuth: boolean, mysql: boolean, infra: KtInfra): string {
  const fakes = ktorTestFakes(infra);
  const moduleArgs = [withAuth && "jwtVerifier = TestAuth.verifier", ...fakes.args].filter(Boolean).join(", ");
  const mode = mysql ? "MySQL" : "PostgreSQL";
  const authImports = withAuth
    ? `import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.auth0.jwt.interfaces.JWTVerifier
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date
`
    : "";
  const authBlock = withAuth
    ? `
/** RS256 keypair generated per test run; the app trusts it instead of the provider's JWKS. */
object TestAuth {
    private const val ISSUER = "https://issuer.test"
    private val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val algorithm = Algorithm.RSA256(keys.public as RSAPublicKey, keys.private as RSAPrivateKey)

    val verifier: JWTVerifier = JWT.require(algorithm).withIssuer(ISSUER).build()

    fun token(): String = JWT.create()
        .withIssuer(ISSUER)
        .withSubject("test-user")
        .withExpiresAt(Date(System.currentTimeMillis() + 60_000))
        .sign(algorithm)
}
`
    : "";
  return `${authImports}${fakes.imports}import io.ktor.server.application.*
import org.jetbrains.exposed.sql.Database

/**
 * Tests run against in-memory H2 (${mode} mode) with the production schema,
 * so \`gradle test\` needs no database${withAuth ? " and no network for JWKS" : ""}${fakes.args.length ? " (cache / queue are in-memory fakes below)" : ""}.
 */
fun initTestDatabase() {
    Database.connect("jdbc:h2:mem:test;MODE=${mode};DB_CLOSE_DELAY=-1", driver = "org.h2.Driver")
    createSchema()
}

/** The production module wired to test infrastructure. */
fun Application.testModule() {
    initTestDatabase()
    module(${moduleArgs})
}
${authBlock}${fakes.body}`;
}

function ktorApplicationTest(entities: Entity[], stubs: Endpoint[], withAuth: boolean, infra: KtInfra): string {
  // One protected route proves the token path end to end: 401 without, 200 with.
  const stub = stubs.find((e) => e.auth);
  const target = entities.length > 0
    ? { method: "Get", path: `/${toKebab(entities[0].name)}s` }
    : stub
      ? { method: toPascal(stub.method.toLowerCase()), path: springPath(stub.path).replace(/\{[^}]+\}/g, "1") }
      : null;
  const authTests = withAuth && target
    ? `
    @Test
    fun protectedRouteRejectsMissingToken() = testApplication {
        application { testModule() }
        val response = client.request("${target.path}") { method = HttpMethod.${target.method} }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun protectedRouteAcceptsSignedToken() = testApplication {
        application { testModule() }
        val response = client.request("${target.path}") {
            method = HttpMethod.${target.method}
            header(HttpHeaders.Authorization, "Bearer \${TestAuth.token()}")
        }
        assertEquals(HttpStatusCode.OK, response.status)
    }
`
    : "";
  const auth = withAuth ? `\n            header(HttpHeaders.Authorization, "Bearer \${TestAuth.token()}")` : "";
  const entity = entities[0];
  const base = entity ? `/${toKebab(entity.name)}s` : "";
  const create = entity
    ? `val created = client.post("${base}") {${auth}
            contentType(ContentType.Application.Json)
            setBody(${ktContractBody(entity)})
        }
        assertEquals(HttpStatusCode.Created, created.status)`
    : "";
  const infraTests = [
    `
    @Test
    fun readinessChecksDependencies() = testApplication {
        application { testModule() }
        val response = client.get("/health?ready=1")
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue("\\"db\\":true" in response.bodyAsText())
    }
`,
    infra.rateLimit && `
    @Test
    fun rateLimitRejectsTheSixtyFirstRequestPerMinute() = testApplication {
        application { testModule() }
        repeat(60) { assertEquals(HttpStatusCode.OK, client.get("/health").status) }
        assertEquals(HttpStatusCode.TooManyRequests, client.get("/health").status)
    }
`,
    infra.queue && entity && `
    @Test
    fun createPublishesAnEvent() = testApplication {
        application { testModule() }
        ${create}
        val id = Json.parseToJsonElement(created.bodyAsText()).jsonObject["${toCamel(entity.fields.find((f) => f.primaryKey)?.name ?? "id")}"]!!.jsonPrimitive.content
        assertTrue(TestQueue.published.any { "\\"${toKebab(entity.name)}.created\\"" in it && id in it })
    }
`,
    infra.redis && entity && `
    @Test
    fun getByIdPopulatesTheCache() = testApplication {
        application { testModule() }
        ${create}
        val id = Json.parseToJsonElement(created.bodyAsText()).jsonObject["${toCamel(entity.fields.find((f) => f.primaryKey)?.name ?? "id")}"]!!.jsonPrimitive.content
        assertEquals(HttpStatusCode.OK, client.get("${base}/$id") {${auth}
        }.status)
        assertNotNull(TestCache.get("${toKebab(entity.name)}s:$id"), "first read is cached")
    }
`,
  ].filter(Boolean).join("");
  const needsJson = (infra.queue || infra.redis) && entity;
  return `import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
${needsJson ? "import kotlinx.serialization.json.*\n" : ""}import kotlin.test.*

class ApplicationTest {${needsJson ? `
    private fun unique() = "test-" + java.util.UUID.randomUUID()
` : ""}
    @Test
    fun healthIsOk() = testApplication {
        application { testModule() }
        assertEquals(HttpStatusCode.OK, client.get("/health").status)
    }
${authTests}${infraTests}}
`;
}

// ─── Spring Kotlin generator ──────────────────────────────────────────────────

function springKtFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  const safe = safeName(config.name);
  const pkg = springKtPkg(config);
  const files: GeneratedFile[] = [];
  const anyProtected = endpoints.some((e) => e.auth);
  const withAuth = needsAuth(config, anyProtected);
  const mysql = isMysql(config.database);
  const metrics = config.monitoring === "grafana";
  const infra = ktInfra(config);
  const dir = `src/main/kotlin/${pkgPath(pkg)}`;

  files.push({ path: "build.gradle.kts", content: springKtBuildGradle(safe, withAuth, mysql, metrics, infra) });
  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${safe}"\n` });
  files.push({ path: "Dockerfile", content: springKtDockerfile() });
  files.push({
    path: "src/main/resources/logback-spring.xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!-- JSON logging via logstash-logback-encoder. Spring Boot auto-loads this file. -->
<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <includeCallerData>false</includeCallerData>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="STDOUT"/>
  </root>
</configuration>
`,
  });
  files.push({
    path: `src/main/kotlin/${pkgPath(pkg)}/Application.kt`,
    content: springKtApplication(pkg),
  });

  // Spring Boot looks for application.properties on the classpath; emit one
  // that wires the OAuth2 resource server when auth is enabled.
  files.push({
    path: "src/main/resources/application.properties",
    content: springKtAppProperties(safe, withAuth, mysql, metrics, infra),
  });
  files.push(...springKtInfraFiles(infra, pkg, dir));
  files.push(...springKtInfraTestFiles(infra, pkg, `src/test/kotlin/${pkgPath(pkg)}`, withAuth));

  if (withAuth) {
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/SecurityConfig.kt`,
      content: springKtSecurityConfig(pkg, springPublicStubs(stubEndpoints(endpoints, entities))),
    });
  }

  for (const entity of entities) {
    const pascal = toPascal(entity.name);
    const kebab = toKebab(entity.name);

    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}.kt`,
      content: springKtEntity(pkg, entity, infra.redis),
    });
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}Repository.kt`,
      content: springKtRepository(pkg, entity, infra.redis),
    });
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}Controller.kt`,
      content: springKtController(pkg, pascal, kebab, entity, !!infra.queue),
    });
    // Per-entity smoke test mirrors what the Spring (Java) path emits —
    // wires up MockMvc against the auto-loaded Spring context so a missing
    // bean / wiring regression fails `gradle test` immediately.
    files.push({
      path: `src/test/kotlin/${pkgPath(pkg)}/${pascal}ControllerTest.kt`,
      content: springKtControllerTest(pkg, pascal, kebab, withAuth),
    });
  }

  // Tests activate the "test" profile: in-memory H2, schema from the entities, no Flyway,
  // so `gradle test` needs no database.
  files.push({ path: "src/test/resources/application-test.properties", content: springKtTestProperties(mysql, infra) });

  const stubs = stubEndpoints(endpoints, entities);
  if (stubs.length > 0) {
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/ApiController.kt`,
      content: springKtApiController(pkg, stubs),
    });
  }

  return files;
}

function springKtPkg(config: StackConfig): string {
  return `dev.helios.${safeName(config.name).replace(/-/g, "_")}`;
}

function pkgPath(pkg: string): string {
  return pkg.replace(/\./g, "/");
}

function springKtBuildGradle(appName: string, withAuth: boolean, mysql: boolean, metrics: boolean, infra: KtInfra): string {
  const metricsDeps = metrics
    ? `    // Prometheus metrics at /actuator/prometheus.
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-registry-prometheus")
`
    : "";
  void appName;
  const authDeps = withAuth
    ? `    // OAuth2 Resource Server — validates inbound JWTs against the configured
    // JWKS. Works with Clerk, Auth0, Cognito, Firebase, Keycloak, Supabase Auth.
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-oauth2-resource-server")
    // jwt() request post-processor for MockMvc tests of protected routes.
    testImplementation("org.springframework.security:spring-security-test")
`
    : "";
  return `plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.spring") version "2.0.21"
    kotlin("plugin.jpa") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("org.springframework.boot") version "3.3.4"
    id("io.spring.dependency-management") version "1.1.6"
}

repositories { mavenCentral() }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    // Flyway auto-runs migrations from src/main/resources/db/migration/ on startup.
    implementation("org.flywaydb:flyway-core")
    implementation("org.flywaydb:${mysql ? "flyway-mysql" : "flyway-database-postgresql"}")
    // JSON logging — logstash-logback-encoder hooks into Spring's Logback.
    implementation("net.logstash.logback:logstash-logback-encoder:8.0")
${authDeps}${metricsDeps}${springKtInfraDeps(infra, metrics)}    runtimeOnly("${mysql ? "com.mysql:mysql-connector-j" : "org.postgresql:postgresql:42.7.4"}")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("com.h2database:h2")
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    compilerOptions {
        freeCompilerArgs.addAll("-Xjsr305=strict")
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

tasks.withType<Test> { useJUnitPlatform() }
`;
}

function springKtAppProperties(appName: string, withAuth: boolean, mysql: boolean, metrics: boolean, infra: KtInfra): string {
  const metricsProps = metrics
    ? `
# Prometheus scrape endpoint: /actuator/prometheus
management.endpoints.web.exposure.include=health,prometheus
`
    : "";
  const authProps = withAuth
    ? `
# ─── OAuth2 Resource Server ──────────────────────────────────────────────────
spring.security.oauth2.resourceserver.jwt.issuer-uri=\${AUTH_ISSUER:}
spring.security.oauth2.resourceserver.jwt.jwk-set-uri=\${AUTH_JWKS_URL:}
auth.expected-audience=\${AUTH_AUDIENCE:}
`
    : "";
  return `spring.application.name=${appName}
spring.datasource.url=\${DATABASE_URL:${mysql ? `jdbc:mysql://localhost:3306/${appName}` : `jdbc:postgresql://localhost:5432/${appName}`}}
spring.datasource.driver-class-name=${mysql ? "com.mysql.cj.jdbc.Driver" : "org.postgresql.Driver"}
spring.jpa.hibernate.ddl-auto=validate${mysql ? `
# Migrations store UUIDs as CHAR(36); Hibernate defaults to BINARY(16) on MySQL.
spring.jpa.properties.hibernate.type.preferred_uuid_jdbc_type=CHAR` : ""}
spring.jpa.show-sql=false

spring.datasource.hikari.maximum-pool-size=20
spring.datasource.hikari.minimum-idle=2
spring.datasource.hikari.connection-timeout=10000

spring.flyway.enabled=true
spring.flyway.baseline-on-migrate=true
${authProps}${metricsProps}${springKtInfraProps(infra)}
server.port=\${PORT:8080}
`;
}

function springKtTestProperties(mysql: boolean, infra: KtInfra): string {
  return `spring.datasource.url=jdbc:h2:mem:test;MODE=${mysql ? "MySQL" : "PostgreSQL"};DB_CLOSE_DELAY=-1
spring.datasource.driver-class-name=org.h2.Driver
spring.datasource.username=sa
spring.datasource.password=
spring.jpa.hibernate.ddl-auto=create-drop
spring.flyway.enabled=false
${springKtInfraTestProps(infra)}`;
}

function springKtApiController(pkg: string, endpoints: Endpoint[]): string {
  const methods = endpoints.map((e) =>
    `    @${methodAnnotation(e.method)}(${JSON.stringify(springPath(e.path))})
    fun ${handlerMethodName(e)}(): Map<String, Any> = mapOf("ok" to true, "op" to "${e.method} ${e.path}")`
  ).join("\n\n");
  return `package ${pkg}

import org.springframework.web.bind.annotation.*

@RestController
class ApiController {

${methods}
}
`;
}

function springKtSecurityConfig(pkg: string, publicStubs: Endpoint[] = []): string {
  const permits = publicStubs
    .map((e) => `\n                  .requestMatchers(HttpMethod.${ktMethod(e.method)}, ${JSON.stringify(springPath(e.path))}).permitAll()`)
    .join("");
  return `package ${pkg}

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
${permits ? "import org.springframework.http.HttpMethod\n" : ""}import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.JwtValidators
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder
import org.springframework.security.web.SecurityFilterChain

/**
 * OAuth2 Resource Server. Spring validates JWT signature, iss, and exp
 * automatically; we layer an optional audience check on top.
 *
 * /health${permits ? " and endpoints marked public" : ""} stay public; everything else requires a valid Bearer token.
 */
@Configuration
class SecurityConfig(
    @Value("\\\${spring.security.oauth2.resourceserver.jwt.jwk-set-uri:}") private val jwkSetUri: String,
    @Value("\\\${spring.security.oauth2.resourceserver.jwt.issuer-uri:}") private val issuerUri: String,
    @Value("\\\${auth.expected-audience:}") private val expectedAudience: String,
) {
    @Bean
    fun filterChain(http: HttpSecurity): SecurityFilterChain {
        http
            .authorizeHttpRequests {
                it.requestMatchers("/health", "/actuator/**").permitAll()${permits}
                  .anyRequest().authenticated()
            }
            .csrf { it.disable() }
            .oauth2ResourceServer { rs -> rs.jwt { } }
        return http.build()
    }

    @Bean
    fun jwtDecoder(): JwtDecoder {
        val decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build()
        val defaultValidator = JwtValidators.createDefaultWithIssuer(issuerUri)
        decoder.setJwtValidator(
            if (expectedAudience.isBlank()) defaultValidator
            else AudienceValidator(defaultValidator, expectedAudience)
        )
        return decoder
    }

    private class AudienceValidator(
        private val delegate: OAuth2TokenValidator<Jwt>,
        private val audience: String,
    ) : OAuth2TokenValidator<Jwt> {
        override fun validate(jwt: Jwt): OAuth2TokenValidatorResult {
            val base = delegate.validate(jwt)
            if (base.hasErrors()) return base
            return if (jwt.audience?.contains(audience) == true) OAuth2TokenValidatorResult.success()
            else OAuth2TokenValidatorResult.failure(
                OAuth2Error("invalid_token", "audience mismatch", null)
            )
        }
    }
}
`;
}

function springKtDockerfile(): string {
  return `FROM gradle:8.10-jdk21 AS build
WORKDIR /src
COPY build.gradle.kts settings.gradle.kts ./
RUN gradle dependencies --no-daemon -q 2>/dev/null || true
COPY src ./src
RUN gradle bootJar --no-daemon -q

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app
COPY --from=build --chown=app:app /src/build/libs/*.jar app.jar
EXPOSE 8080
USER app
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
}

function springKtApplication(pkg: string): string {
  return `package ${pkg}

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}
`;
}

function springKtEntity(pkg: string, entity: Entity, cached = false): string {
  const pascal = toPascal(entity.name);
  const tableName = toSnake(entity.name) + "s";

  const pkField = entity.fields.find((f) => f.primaryKey);
  const nonPkFields = entity.fields.filter((f) => !f.primaryKey);

  const pkLine = pkField
    ? [
        `    @Id`,
        `    @GeneratedValue(strategy = GenerationType.UUID)`,
        `    val ${toCamel(pkField.name)}: java.util.UUID? = null,`,
      ].join("\n")
    : [
        `    @Id`,
        `    @GeneratedValue(strategy = GenerationType.UUID)`,
        `    val id: java.util.UUID? = null,`,
      ].join("\n");

  const fieldLines = nonPkFields.map((f) => {
    const type = springKtFieldType(f.type as FieldType);
    const nullable = !f.required ? "?" : "";
    const defaultVal = !f.required ? " = null" : "";
    const columnAnnotation = f.unique ? `    @Column(unique = true)\n` : `    @Column\n`;
    return `${columnAnnotation}    val ${toCamel(f.name)}: ${type}${nullable}${defaultVal},`;
  });

  const allLines = [pkLine, ...fieldLines].join("\n");

  return `package ${pkg}

import jakarta.persistence.*

@Entity
@Table(name = "${tableName}")
data class ${pascal}(
${allLines}
)${cached ? " : java.io.Serializable // cached in Redis (JDK serialization)" : ""}
`;
}

function springKtFieldType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "java.util.UUID";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "Double";
    case "boolean": return "Boolean";
    case "date":    return "java.time.Instant";
    case "json":    return "String"; // stored as JSON string
  }
}

function springKtRepository(pkg: string, entity: Entity, cached = false): string {
  const pascal = toPascal(entity.name);
  if (!cached) {
    return `package ${pkg}

import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface ${pascal}Repository : JpaRepository<${pascal}, UUID>
`;
  }
  const cacheName = `${toKebab(entity.name)}s`;
  const pk = toCamel(entity.fields.find((f) => f.primaryKey)?.name ?? "id");
  return `package ${pkg}

import org.springframework.cache.annotation.CacheEvict
import org.springframework.cache.annotation.Cacheable
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

/** Cache-aside on reads by id (Redis, 60s TTL); saves and deletes evict the entry. */
interface ${pascal}Repository : JpaRepository<${pascal}, UUID> {
    @Cacheable("${cacheName}", key = "#p0", unless = "#result == null")
    override fun findById(id: UUID): Optional<${pascal}>

    @CacheEvict("${cacheName}", key = "#p0.${pk}", condition = "#p0.${pk} != null")
    override fun <S : ${pascal}> save(entity: S): S

    @CacheEvict("${cacheName}", key = "#p0")
    override fun deleteById(id: UUID)
}
`;
}

function springKtController(
  pkg: string,
  pascal: string,
  kebab: string,
  entity: Entity,
  publishes = false,
): string {
  const camelRepo = toCamel(pascal) + "Repository";

  const pkField = entity.fields.find((f) => f.primaryKey);
  const pkCol = pkField ? toCamel(pkField.name) : "id";

  return `package ${pkg}

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/${kebab}s")
class ${pascal}Controller(private val ${camelRepo}: ${pascal}Repository${publishes ? ", private val jobs: JobPublisher" : ""}) {

    @GetMapping
    fun list(): List<${pascal}> = ${camelRepo}.findAll()

    @GetMapping("/{id}")
    fun getById(@PathVariable id: UUID): ResponseEntity<${pascal}> {
        val item = ${camelRepo}.findById(id).orElse(null)
            ?: return ResponseEntity.notFound().build()
        return ResponseEntity.ok(item)
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@RequestBody body: ${pascal}): ${pascal} = ${camelRepo}.save(body)${publishes
      ? `
        .also { jobs.publish("""{"event":"${kebab}.created","id":"\${it.${pkCol}}"}""") }`
      : ""}

    @PutMapping("/{id}")
    fun update(@PathVariable id: UUID, @RequestBody body: ${pascal}): ResponseEntity<${pascal}> {
        if (!${camelRepo}.existsById(id)) return ResponseEntity.notFound().build()
        val updated = body.copy(${pkCol} = id)
        return ResponseEntity.ok(${camelRepo}.save(updated))
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable id: UUID) {
        if (!${camelRepo}.existsById(id)) throw org.springframework.web.server.ResponseStatusException(
            org.springframework.http.HttpStatus.NOT_FOUND
        )
        ${camelRepo}.deleteById(id)
    }
}
`;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function springKtControllerTest(pkg: string, pascal: string, kebab: string, withAuth = false): string {
  return `package ${pkg}

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
${withAuth ? "import org.springframework.boot.test.mock.mockito.MockBean\n" : ""}import org.springframework.http.MediaType
${withAuth ? "import org.springframework.security.oauth2.jwt.JwtDecoder\nimport org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt\n" : ""}import org.springframework.test.context.ActiveProfiles
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ${pascal}ControllerTest {

    @Autowired
    lateinit var mvc: MockMvc
${withAuth ? `
    // Routes require a Bearer JWT; jwt() injects an authenticated principal and
    // the mocked decoder keeps the context from needing a live JWKS endpoint.
    @MockBean
    lateinit var jwtDecoder: JwtDecoder
` : ""}
    @Test
    fun \`list returns ok\`() {
        mvc.perform(get("/${kebab}s")${withAuth ? ".with(jwt())" : ""})
            .andExpect(status().isOk)
    }

    @Test
    fun \`create is reachable\`() {
        mvc.perform(
            post("/${kebab}s")${withAuth ? "\n                .with(jwt())" : ""}
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}")
        ).andExpect(status().is4xxClientError) // empty body fails @NotNull validation; route is wired
    }
}
`;
}

// ─── Contract tests (src/test/kotlin/**/ApiContractTest.kt) ──────────────────

const KT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ktMethod = (m: string) => (KT_METHODS.includes(m) ? m : "GET"); // same fallback as the stub routes

// Spring's URL matchers can't tell "/users/{id}" from "/users/search", so a public
// templated stub that could also match a protected stub stays protected (fail closed).
function shadowsProtected(pub: Endpoint, stubs: Endpoint[]): boolean {
  const segs = (p: string) => p.split("/").filter(Boolean);
  const a = segs(pub.path);
  return stubs.some((s) => {
    if (!s.auth || ktMethod(s.method) !== ktMethod(pub.method)) return false;
    const b = segs(s.path);
    return a.length === b.length && a.every((x, i) => x === b[i] || x.startsWith(":") || b[i].startsWith(":"));
  });
}

function springPublicStubs(stubs: Endpoint[]): Endpoint[] {
  return stubs.filter((e) => !e.auth && !shadowsProtected(e, stubs));
}

type KtContractCase = {
  label: string;      // "GET users by id"
  method: string;
  path: string;       // concrete request path
  protected: boolean;
  status: number;     // expected status with a valid token (or with no auth at all)
  body?: string;      // Kotlin raw-string JSON body
  json?: "object" | "array";
  keys?: string[];    // top-level keys the response object must carry
};

// Required fields get fresh values per request: the in-memory DB is shared across
// test classes, so a fixed value for a unique column would collide.
function ktContractBody(entity: Entity): string {
  const pairs = entity.fields.filter((f) => !f.primaryKey && f.required).map((f) => {
    const name = toCamel(f.name);
    switch (f.type as FieldType) {
      case "string":
      case "text":    return `"${name}":"\${unique()}"`;
      case "number":  return `"${name}":1`;
      case "boolean": return `"${name}":true`;
      case "uuid":    return `"${name}":"\${java.util.UUID.randomUUID()}"`;
      case "date":    return `"${name}":"2024-01-01T00:00:00Z"`;
      case "json":    return `"${name}":"{}"`;
    }
  });
  return `"""{${pairs.join(",")}}"""`;
}

function ktContractCases(stubs: Endpoint[], entities: Entity[], withAuth: boolean, spring: boolean): KtContractCase[] {
  const cases: KtContractCase[] = [];
  const publicSpring = springPublicStubs(stubs);
  for (const e of stubs) {
    const method = ktMethod(e.method);
    cases.push({
      label: `${method} ${e.path}`,
      method,
      path: springPath(e.path).replace(/\{[^}]+\}/g, "1"),
      protected: withAuth && (spring ? !publicSpring.includes(e) : e.auth),
      status: 200,
      body: ["POST", "PUT", "PATCH"].includes(method) ? `"""{}"""` : undefined,
      json: "object",
      keys: ["op"],
    });
  }
  for (const entity of entities) {
    const base = `/${toKebab(entity.name)}s`;
    const body = ktContractBody(entity);
    const pk = toCamel(entity.fields.find((f) => f.primaryKey)?.name ?? "id");
    const keys = [pk, ...entity.fields.filter((f) => !f.primaryKey && f.required).map((f) => toCamel(f.name))];
    // By-id routes get a malformed id: 400 proves the route is wired (a missing route is 404).
    const bad = `${base}/not-a-uuid`;
    cases.push(
      { label: `GET ${base}`, method: "GET", path: base, protected: withAuth, status: 200, json: "array" },
      { label: `POST ${base}`, method: "POST", path: base, protected: withAuth, status: 201, body, json: "object", keys },
      { label: `GET ${base}/:id`, method: "GET", path: bad, protected: withAuth, status: 400 },
      { label: `PUT ${base}/:id`, method: "PUT", path: bad, protected: withAuth, status: 400, body },
      { label: `DELETE ${base}/:id`, method: "DELETE", path: bad, protected: withAuth, status: 400 },
    );
  }
  return cases;
}

// JVM method names can't contain / . ; [ ] < > : so "GET /users/:id" → `GET users by id`.
function ktTestNames(): (c: KtContractCase, suffix: string) => string {
  const seen = new Map<string, number>();
  return (c, suffix) => {
    const words = c.label
      .split("/")
      .filter(Boolean)
      .map((s) => (s.trim().startsWith(":") ? `by ${s.trim().slice(1)}` : s))
      .join(" ")
      .replace(/[^A-Za-z0-9 _-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const name = `${words} ${suffix}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} ${n}`;
  };
}

const ktStr = (s: string) => JSON.stringify(s).replace(/\$/g, "\\$");
const verb = (c: KtContractCase) => (c.status === 400 ? "rejects a malformed id" : `returns ${c.status}`);

function ktorContractTest(cases: KtContractCase[]): string {
  const name = ktTestNames();
  const call = (c: KtContractCase, token: boolean) => {
    const lines = [`method = HttpMethod.${toPascal(c.method.toLowerCase())}`];
    if (token) lines.push(`header(HttpHeaders.Authorization, "Bearer \${TestAuth.token()}")`);
    if (c.body) lines.push("contentType(ContentType.Application.Json)", `setBody(${c.body})`);
    return `val response = client.request(${ktStr(c.path)}) {\n${lines.map((l) => `            ${l}`).join("\n")}\n        }`;
  };
  const shape = (c: KtContractCase) => {
    if (!c.json) return "";
    const lines = [`        assertEquals(ContentType.Application.Json, response.contentType()?.withoutParameters())`];
    if (c.json === "array") lines.push(`        Json.parseToJsonElement(response.bodyAsText()).jsonArray`);
    else {
      lines.push(`        val body = Json.parseToJsonElement(response.bodyAsText()).jsonObject`);
      if (c.keys?.length) lines.push(`        for (key in listOf(${c.keys.map(ktStr).join(", ")})) assertTrue(key in body, "response is missing \\"\$key\\"")`);
    }
    return "\n" + lines.join("\n");
  };
  const test = (fn: string, c: KtContractCase, token: boolean, status: number, withShape: boolean) => `
    @Test
    fun \`${fn}\`() = testApplication {
        application { testModule() }
        ${call(c, token)}
        assertEquals(HttpStatusCode.fromValue(${status}), response.status)${withShape ? shape(c) : ""}
    }
`;
  const tests = cases.map((c) =>
    c.protected
      ? test(name(c, "returns 401 without token"), c, false, 401, false) +
        test(name(c, `${verb(c)} with token`), c, true, c.status, true)
      : test(name(c, verb(c)), c, false, c.status, true)
  ).join("");
  return `import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import kotlin.test.*

/**
 * Contract tests: every route is served (not 404), protected routes reject a
 * missing token and accept a signed one, and JSON responses carry the expected shape.
 * Runs on the in-memory test module (TestSupport.kt) — no database or network.
 */
class ApiContractTest {
    private fun unique() = "test-" + java.util.UUID.randomUUID()
${tests}}
`;
}

function springKtContractTest(pkg: string, cases: KtContractCase[], withAuth: boolean): string {
  const name = ktTestNames();
  const perform = (c: KtContractCase, token: boolean) => {
    const parts = [`request(HttpMethod.${c.method}, ${ktStr(c.path)})`];
    if (token) parts.push(".with(jwt())");
    if (c.body) parts.push(".contentType(MediaType.APPLICATION_JSON)", `.content(${c.body})`);
    return `mvc.perform(\n            ${parts.join("\n                ")}\n        )`;
  };
  const shape = (c: KtContractCase) => {
    if (!c.json) return "";
    const lines = [`.andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))`];
    if (c.json === "array") lines.push(`.andExpect(jsonPath("\\$").isArray)`);
    for (const k of c.keys ?? []) lines.push(`.andExpect(jsonPath(${ktStr(`$.${k}`)}).exists())`);
    return lines.map((l) => `\n            ${l}`).join("");
  };
  const test = (fn: string, c: KtContractCase, token: boolean, status: number, withShape: boolean) => `
    @Test
    fun \`${fn}\`() {
        ${perform(c, token)}
            .andExpect(status().\`is\`(${status}))${withShape ? shape(c) : ""}
    }
`;
  const tests = cases.map((c) =>
    c.protected
      ? test(name(c, "returns 401 without token"), c, false, 401, false) +
        test(name(c, `${verb(c)} with token`), c, true, c.status, true)
      : test(name(c, verb(c)), c, false, c.status, true)
  ).join("");
  return `package ${pkg}

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
${withAuth ? "import org.springframework.boot.test.mock.mockito.MockBean\n" : ""}import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
${withAuth ? "import org.springframework.security.oauth2.jwt.JwtDecoder\nimport org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt\n" : ""}import org.springframework.test.context.ActiveProfiles
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.content
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * Contract tests: every route is served (not 404), protected routes reject a
 * missing token and accept an authenticated one, and JSON responses carry the
 * expected shape. The "test" profile uses in-memory H2 — no database or network.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ApiContractTest {

    @Autowired
    lateinit var mvc: MockMvc
${withAuth ? `
    // jwt() supplies the authenticated principal; the mock keeps the context off the JWKS endpoint.
    @MockBean
    lateinit var jwtDecoder: JwtDecoder
` : ""}
    private fun unique() = "test-" + java.util.UUID.randomUUID()
${tests}}
`;
}

/** ApiContractTest.kt per framework; emitted from contract-tests.ts. */
export function kotlinContractTestFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const withAuth = needsAuth(config, endpoints.some((e) => e.auth));
  const spring = config.framework === "spring-kt";
  const cases = ktContractCases(stubEndpoints(endpoints, entities), entities, withAuth, spring);
  if (cases.length === 0) return [];
  if (!spring) return [{ path: "src/test/kotlin/ApiContractTest.kt", content: ktorContractTest(cases) }];
  const pkg = springKtPkg(config);
  return [{ path: `src/test/kotlin/${pkgPath(pkg)}/ApiContractTest.kt`, content: springKtContractTest(pkg, cases, withAuth) }];
}

function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

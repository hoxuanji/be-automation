import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab, toCamel } from "./types";

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

  files.push({ path: "build.gradle.kts", content: ktorBuildGradle(safe) });
  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${safe}"\n` });
  files.push({ path: "Dockerfile", content: ktorDockerfile() });
  files.push({ path: "src/main/kotlin/Application.kt", content: ktorApplication(entities) });
  files.push({ path: "src/main/kotlin/Database.kt", content: ktorDatabase(safe, entities) });

  for (const entity of entities) {
    files.push({
      path: `src/main/kotlin/models/${toPascal(entity.name)}.kt`,
      content: ktorModel(entity),
    });
    files.push({
      path: `src/main/kotlin/routes/${toSnake(entity.name)}Routes.kt`,
      content: ktorRoutes(entity),
    });
    files.push({
      path: `src/test/kotlin/${toPascal(entity.name)}RouteTest.kt`,
      content: ktorTest(entity),
    });
  }

  // suppress unused-variable warnings for endpoints — they inform the health route comment
  void endpoints;

  return files;
}

// ─── build.gradle.kts ────────────────────────────────────────────────────────

function ktorBuildGradle(safeName: string): string {
  void safeName;
  return `plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("com.github.johnrengelman.shadow") version "8.1.1"
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
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("com.zaxxer:HikariCP:5.1.0")
    implementation("ch.qos.logback:logback-classic:1.5.8")
    testImplementation("io.ktor:ktor-server-test-host:\$ktor_version")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")
}
`;
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
COPY --from=build /src/build/libs/*-all.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
}

// ─── Application.kt ──────────────────────────────────────────────────────────

function ktorApplication(entities: Entity[]): string {
  const routeCalls = entities
    .map((e) => `            ${toCamel(e.name)}Routes()`)
    .join("\n");

  const routeCallsBlock = routeCalls
    ? `\n${routeCalls}`
    : "";

  return `import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.routing.*
import io.ktor.server.response.*
import kotlinx.serialization.json.Json

fun main() {
    initDatabase()
    embeddedServer(Netty, port = System.getenv("PORT")?.toIntOrNull() ?: 8080) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true; coerceInputValues = true })
        }
        routing {
            get("/health") { call.respond(mapOf("ok" to true)) }${routeCallsBlock}
        }
    }.start(wait = true)
}
`;
}

// ─── Database.kt ─────────────────────────────────────────────────────────────

function ktorDatabase(appName: string, entities: Entity[]): string {
  const tableList = entities.map((e) => toPascal(e.name) + "s").join(", ");
  const schemaArg = tableList ? tableList : "/* no tables */";

  return `import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction

fun initDatabase() {
    val url = System.getenv("DATABASE_URL") ?: "jdbc:postgresql://localhost:5432/${appName}"
    val config = HikariConfig().apply {
        jdbcUrl = url
        maximumPoolSize = 20
    }
    Database.connect(HikariDataSource(config))
    transaction {
        SchemaUtils.createMissingTablesAndColumns(${schemaArg})
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
    case "number":  return "Long";
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
    case "number":  return `long("${col}")`;
    case "boolean": return `bool("${col}")`;
    case "date":    return `timestamp("${col}")`;
    case "json":    return `text("${col}") // JSON stored as text`;
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
    return `    val ${toCamel(f.name)}: ${type}${nullable},${comment}${defaultVal}`;
  });

  const dataClassFields = [pkClassField, ...nonPkClassFields].join("\n");

  // Build Create DTO (non-PK fields, required ones are non-nullable)
  const createFields = nonPkFields.map((f) => {
    const type = ktDataClassType(f);
    const nullable = !f.required ? "?" : "";
    const defaultVal = !f.required ? " = null" : "";
    const comment = f.type === "json" ? " // JSON string" : "";
    return `    val ${toCamel(f.name)}: ${type}${nullable},${comment}${defaultVal}`;
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

function ktorRoutes(entity: Entity): string {
  const pascal = toPascal(entity.name);
  const camelFn = toCamel(entity.name);
  const kebab = toKebab(entity.name);
  const tableObj = pascal + "s";

  const pkField = entity.fields.find((f) => f.primaryKey);
  const pkCol = pkField ? toCamel(pkField.name) : "id";

  const nonPkFields = entity.fields.filter((f) => !f.primaryKey);

  // Build insert body lines
  const insertLines = nonPkFields.map((f) => {
    const camelF = toCamel(f.name);
    return `                    it[${camelF}] = body.${camelF}`;
  });

  // Build update body lines
  const updateLines = nonPkFields.map((f) => {
    const camelF = toCamel(f.name);
    return `                    body.${camelF}?.let { v -> it[${camelF}] = v }`;
  });

  const insertBlock = insertLines.length > 0
    ? insertLines.join("\n")
    : `                    // no fields`;

  const updateBlock = updateLines.length > 0
    ? updateLines.join("\n")
    : `                    // no fields`;

  return `import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction
import java.util.UUID

fun Route.${camelFn}Routes() {
    route("/${kebab}s") {
        get {
            val items = transaction { ${tableObj}.selectAll().map { it.to${pascal}() } }
            call.respond(items)
        }

        get("/{id}") {
            val id = call.parameters["id"]?.runCatching { UUID.fromString(this) }?.getOrNull()
                ?: return@get call.respond(HttpStatusCode.BadRequest)
            val item = transaction {
                ${tableObj}.selectAll().where { ${tableObj}.${pkCol} eq id }.singleOrNull()?.to${pascal}()
            }
            if (item == null) call.respond(HttpStatusCode.NotFound)
            else call.respond(item)
        }

        post {
            val body = call.receive<Create${pascal}>()
            val item = transaction {
                ${tableObj}.insertReturning {
${insertBlock}
                }.single().to${pascal}()
            }
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
            }
            if (updated == null) call.respond(HttpStatusCode.NotFound)
            else call.respond(updated)
        }

        delete("/{id}") {
            val id = call.parameters["id"]?.runCatching { UUID.fromString(this) }?.getOrNull()
                ?: return@delete call.respond(HttpStatusCode.BadRequest)
            val deleted = transaction { ${tableObj}.deleteWhere { ${tableObj}.${pkCol} eq id } }
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
      case "string":  return `\\"${name}\\":\\"test\\"`;
      case "text":    return `\\"${name}\\":\\"test\\"`;
      case "number":  return `\\"${name}\\":1`;
      case "boolean": return `\\"${name}\\":true`;
      case "uuid":    return `\\"${name}\\":\\"00000000-0000-0000-0000-000000000001\\"`;
      case "date":    return `\\"${name}\\":\\"2024-01-01T00:00:00Z\\"`;
      case "json":    return `\\"${name}\\":\\"{}\\"`;
    }
  });
  return `"""{${pairs.join(",")}}"""`;
}

function ktorTest(entity: Entity): string {
  const pascal = toPascal(entity.name);
  const kebab = toKebab(entity.name);
  const createBody = ktTestBody(entity);

  return `import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlin.test.*

class ${pascal}RouteTest {
    @Test
    fun testList${pascal}s() = testApplication {
        val response = client.get("/${kebab}s")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun testCreate${pascal}() = testApplication {
        val response = client.post("/${kebab}s") {
            contentType(ContentType.Application.Json)
            setBody(${createBody})
        }
        assertEquals(HttpStatusCode.Created, response.status)
    }
}
`;
}

// ─── Spring Kotlin generator ──────────────────────────────────────────────────

function springKtFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  const safe = safeName(config.name);
  const pkg = `dev.helios.${safe.replace(/-/g, "_")}`;
  const files: GeneratedFile[] = [];

  files.push({ path: "build.gradle.kts", content: springKtBuildGradle(safe) });
  files.push({ path: "settings.gradle.kts", content: `rootProject.name = "${safe}"\n` });
  files.push({ path: "Dockerfile", content: springKtDockerfile() });
  files.push({
    path: `src/main/kotlin/${pkgPath(pkg)}/Application.kt`,
    content: springKtApplication(pkg),
  });

  for (const entity of entities) {
    const pascal = toPascal(entity.name);
    const kebab = toKebab(entity.name);

    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}.kt`,
      content: springKtEntity(pkg, entity),
    });
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}Repository.kt`,
      content: springKtRepository(pkg, pascal),
    });
    files.push({
      path: `src/main/kotlin/${pkgPath(pkg)}/${pascal}Controller.kt`,
      content: springKtController(pkg, pascal, kebab, entity),
    });
  }

  // suppress unused-variable warning for endpoints
  void endpoints;

  return files;
}

function pkgPath(pkg: string): string {
  return pkg.replace(/\./g, "/");
}

function springKtBuildGradle(appName: string): string {
  void appName;
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
    runtimeOnly("org.postgresql:postgresql:42.7.4")
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

function springKtDockerfile(): string {
  return `FROM gradle:8.10-jdk21 AS build
WORKDIR /src
COPY build.gradle.kts settings.gradle.kts ./
RUN gradle dependencies --no-daemon -q 2>/dev/null || true
COPY src ./src
RUN gradle bootJar --no-daemon -q

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/build/libs/*.jar app.jar
EXPOSE 8080
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

function springKtEntity(pkg: string, entity: Entity): string {
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
    return `${columnAnnotation}    val ${toCamel(f.name)}: ${type}${nullable},${defaultVal}`;
  });

  const allLines = [pkLine, ...fieldLines].join("\n");

  return `package ${pkg}

import jakarta.persistence.*

@Entity
@Table(name = "${tableName}")
data class ${pascal}(
${allLines}
)
`;
}

function springKtFieldType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "java.util.UUID";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "Long";
    case "boolean": return "Boolean";
    case "date":    return "java.time.Instant";
    case "json":    return "String"; // stored as JSON string
  }
}

function springKtRepository(pkg: string, pascal: string): string {
  return `package ${pkg}

import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface ${pascal}Repository : JpaRepository<${pascal}, UUID>
`;
}

function springKtController(
  pkg: string,
  pascal: string,
  kebab: string,
  entity: Entity
): string {
  const camelRepo = toCamel(pascal) + "Repository";
  const camelVar = toCamel(entity.name);

  const pkField = entity.fields.find((f) => f.primaryKey);
  const pkCol = pkField ? toCamel(pkField.name) : "id";

  return `package ${pkg}

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/${kebab}s")
class ${pascal}Controller(private val ${camelRepo}: ${pascal}Repository) {

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
    fun create(@RequestBody body: ${pascal}): ${pascal} = ${camelRepo}.save(body)

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

function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

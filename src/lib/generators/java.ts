import type { Endpoint, Entity, EntityField, FieldType, GeneratedFile, StackConfig } from "./types";
import { toPascal, toSnake, toKebab, toCamel } from "./types";
import { needsAuth } from "./auth/providers";
import { springInfra, quarkusInfra, javaQueue, type JavaInfra } from "./java-infra";

// ─── Public entry point ───────────────────────────────────────────────────────

export function javaFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  if (config.framework === "quarkus") {
    return quarkusFiles(config, endpoints, entities);
  }
  return springFiles(config, endpoints, entities);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isMysql = (db: string) => /mysql|planetscale/.test(db);

function safe(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

/** Short type for use inside method bodies / generics */
function javaShortType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "UUID";
    case "string":  return "String";
    case "text":    return "String";
    case "number":  return "Double"; // migrations create DOUBLE PRECISION; Hibernate validate rejects Long
    case "boolean": return "Boolean";
    case "date":    return "Instant";
    case "json":    return "JsonNode";
  }
}

/** Collect imports needed for a given field type */
function importsForType(t: FieldType): string[] {
  switch (t) {
    case "uuid":    return ["java.util.UUID"];
    case "date":    return ["java.time.Instant"];
    case "json":    return ["com.fasterxml.jackson.databind.JsonNode"];
    default:        return [];
  }
}

/** Spring-style path: :id → {id} */
export function springPath(p: string): string {
  return p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

/** Build @Column annotation for a non-PK field */
function columnAnnotation(field: EntityField, mysql = false): string {
  const parts: string[] = [];
  if (field.unique)    parts.push("unique = true");
  if (field.required)  parts.push("nullable = false");
  if (field.type === "text") parts.push('columnDefinition = "TEXT"');
  if (field.type === "json") parts.push(`columnDefinition = "${mysql ? "json" : "jsonb"}"`);
  if (parts.length === 0) return "@Column";
  return `@Column(${parts.join(", ")})`;
}

/** Determine the primary-key field (explicit or first UUID field) */
function pkField(entity: Entity): EntityField | undefined {
  return entity.fields.find(f => f.primaryKey) ?? entity.fields.find(f => f.type === "uuid");
}

/** Test value for a field in JSON bodies */
function testValue(field: EntityField): string {
  switch (field.type) {
    case "string":
    case "text":    return `"test-value"`;
    case "number":  return `1`;
    case "boolean": return `true`;
    case "uuid":    return `"00000000-0000-0000-0000-000000000001"`;
    case "date":    return `"2024-01-01T00:00:00Z"`;
    case "json":    return `{}`;
  }
}

// ─── Spring Boot ──────────────────────────────────────────────────────────────

function springFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  const artifact = safe(config.name);
  const files: GeneratedFile[] = [];
  const anyProtected = endpoints.some((e) => e.auth);
  const withAuth = needsAuth(config, anyProtected);
  const mysql = isMysql(config.database);
  const metrics = config.monitoring === "grafana";
  const infra = springInfra(config);

  files.push({ path: "pom.xml",    content: springPom(artifact, withAuth, mysql, metrics, infra.deps) });
  files.push({ path: "Dockerfile", content: springDockerfile() });
  files.push({
    path: "src/main/resources/logback-spring.xml",
    content: springLogbackJson(),
  });
  files.push({
    path: "src/main/java/dev/helios/app/Application.java",
    content: springApplication(),
  });
  files.push({
    path: "src/main/java/dev/helios/app/HealthController.java",
    content: healthController(),
  });
  files.push({
    path: "src/main/resources/application.properties",
    content: springAppProperties(config.name, withAuth, mysql, metrics) + infra.props,
  });
  // Tests run on in-memory H2 with brokers / Redis / exporters switched off (@ActiveProfiles("test")).
  files.push({
    path: "src/test/resources/application-test.properties",
    content: springTestProperties(mysql) + infra.testProps,
  });
  files.push(...infra.files);

  if (withAuth) {
    files.push({
      path: "src/main/java/dev/helios/app/SecurityConfig.java",
      content: springSecurityConfig(),
    });
  }

  // Scaffold-only endpoint controller when no entities but there are custom endpoints
  if (entities.length === 0 && endpoints.length > 0) {
    files.push({
      path: "src/main/java/dev/helios/app/ApiController.java",
      content: scaffoldApiController(endpoints.filter((e) => e.path !== "/health"), infra.publisher),
    });
  }

  for (const entity of entities) {
    const pascal = toPascal(entity.name);
    files.push({
      path: `src/main/java/dev/helios/app/model/${pascal}.java`,
      content: entityClass(entity, mysql, infra.cache),
    });
    files.push({
      path: `src/main/java/dev/helios/app/repository/${pascal}Repository.java`,
      content: repositoryInterface(entity),
    });
    files.push({
      path: `src/main/java/dev/helios/app/service/${pascal}Service.java`,
      content: serviceClass(entity, infra.cache),
    });
    files.push({
      path: `src/main/java/dev/helios/app/controller/${pascal}Controller.java`,
      content: controllerClass(entity, infra.publisher),
    });
    files.push({
      path: `src/test/java/dev/helios/app/${pascal}ControllerTest.java`,
      content: controllerTest(entity, withAuth, infra.publisher),
    });
  }

  return files;
}

function springPom(artifactId: string, withAuth = false, mysql = false, metrics = false, extraDeps = ""): string {
  const driver = mysql
    ? `    <dependency>
      <groupId>com.mysql</groupId>
      <artifactId>mysql-connector-j</artifactId>
      <scope>runtime</scope>
    </dependency>`
    : `    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <scope>runtime</scope>
    </dependency>`;
  const metricsDeps = metrics
    ? `    <!-- Prometheus metrics at /actuator/prometheus. -->
    <dependency>
      <groupId>io.micrometer</groupId>
      <artifactId>micrometer-registry-prometheus</artifactId>
    </dependency>
`
    : "";
  const authDeps = withAuth
    ? `    <!-- Spring Security + OAuth2 Resource Server validates JWTs via JWKS,
         gated by \`spring.security.oauth2.resourceserver.jwt.issuer-uri\` in
         application.properties. Works with Clerk, Auth0, Cognito, Firebase,
         Keycloak, and Supabase Auth. -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
    </dependency>
    <!-- jwt() request post-processor for MockMvc tests of protected routes. -->
    <dependency>
      <groupId>org.springframework.security</groupId>
      <artifactId>spring-security-test</artifactId>
      <scope>test</scope>
    </dependency>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
    <relativePath/>
  </parent>
  <groupId>dev.helios</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>0.1.0</version>
  <properties>
    <java.version>21</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
${driver}
    <!-- Flyway runs src/main/resources/db/migration/*.sql on Spring Boot startup. -->
    <dependency>
      <groupId>org.flywaydb</groupId>
      <artifactId>flyway-core</artifactId>
    </dependency>
    <dependency>
      <groupId>org.flywaydb</groupId>
      <artifactId>${mysql ? "flyway-mysql" : "flyway-database-postgresql"}</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <!-- Health indicators (database, Redis, broker) behind /health?ready=1. -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
${authDeps}${metricsDeps}${extraDeps}    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>com.h2database</groupId>
      <artifactId>h2</artifactId>
      <scope>test</scope>
    </dependency>
    <!-- JSON logging via logstash-logback-encoder — produces one JSON
         object per log line, parseable by Loki / Datadog / CloudWatch. -->
    <dependency>
      <groupId>net.logstash.logback</groupId>
      <artifactId>logstash-logback-encoder</artifactId>
      <version>8.0</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

// Quarkus packages a fast-jar directory (target/quarkus-app), not a single runnable jar.
function quarkusDockerfile(): string {
  return `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn dependency:go-offline -q 2>/dev/null || true
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app
COPY --from=build --chown=app:app /src/target/quarkus-app/ ./
EXPOSE 8080
USER app
ENTRYPOINT ["java", "-jar", "quarkus-run.jar"]
`;
}

function springDockerfile(): string {
  return `FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn dependency:go-offline -q 2>/dev/null || true
COPY src ./src
RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN groupadd --system --gid 1001 app \\
 && useradd --system --uid 1001 --gid app --home /home/app --shell /bin/false app
COPY --from=build --chown=app:app /src/target/*.jar app.jar
EXPOSE 8080
USER app
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
}

function springLogbackJson(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  Logback config. Uses logstash-logback-encoder to emit one JSON object per
  line — log aggregators (Loki, Datadog, CloudWatch) parse this natively.
  Spring Boot auto-loads this file because it's named logback-spring.xml.
-->
<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
      <!-- Drop noisy caller-class metadata; keep everything else default. -->
      <includeCallerData>false</includeCallerData>
    </encoder>
  </appender>

  <root level="INFO">
    <appender-ref ref="STDOUT"/>
  </root>

  <!-- Hide Spring's startup banner lines unless DEBUG is enabled. -->
  <logger name="org.springframework.boot.StartupInfoLogger" level="INFO"/>
</configuration>
`;
}

function springApplication(): string {
  return `package dev.helios.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
`;
}

function healthController(): string {
  return `package dev.helios.app;

import org.springframework.boot.actuate.health.HealthEndpoint;
import org.springframework.boot.actuate.health.Status;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import java.util.Map;

/**
 * Liveness: GET /health. Readiness: GET /health?ready=1 aggregates every
 * actuator health indicator (database, Redis, message broker) and answers 503
 * while any of them is down, so Kubernetes stops routing traffic here.
 */
@RestController
public class HealthController {

    private final HealthEndpoint healthEndpoint;

    public HealthController(HealthEndpoint healthEndpoint) {
        this.healthEndpoint = healthEndpoint;
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health(@RequestParam(required = false) String ready) {
        if (ready == null) return ResponseEntity.ok(Map.of("ok", true));
        Status status = healthEndpoint.health().getStatus();
        boolean up = Status.UP.equals(status);
        return ResponseEntity.status(up ? 200 : 503).body(Map.of("ok", up, "status", status.getCode()));
    }
}
`;
}

function springTestProperties(mysql: boolean): string {
  return `spring.datasource.url=jdbc:h2:mem:test;MODE=${mysql ? "MySQL" : "PostgreSQL"};DB_CLOSE_DELAY=-1
spring.datasource.driver-class-name=org.h2.Driver
spring.datasource.username=sa
spring.datasource.password=
spring.jpa.hibernate.ddl-auto=create-drop
spring.flyway.enabled=false
`;
}

function springAppProperties(appName: string, withAuth = false, mysql = false, metrics = false): string {
  const metricsProps = metrics
    ? `
# Prometheus scrape endpoint: /actuator/prometheus
management.endpoints.web.exposure.include=health,prometheus
`
    : "";
  const authProps = withAuth
    ? `
# ─── OAuth2 Resource Server ──────────────────────────────────────────────────
# Spring Security validates inbound JWTs against this JWKS / issuer. Point
# AUTH_ISSUER + AUTH_JWKS_URL at Clerk, Auth0, Cognito, Firebase, Keycloak, or
# Supabase Auth — the same config shape handles all of them.
spring.security.oauth2.resourceserver.jwt.issuer-uri=\${AUTH_ISSUER:}
spring.security.oauth2.resourceserver.jwt.jwk-set-uri=\${AUTH_JWKS_URL:}
# Optional: when set, SecurityConfig wires a custom OAuth2TokenValidator that
# checks the \`aud\` claim against this value.
auth.expected-audience=\${AUTH_AUDIENCE:}
`
    : "";
  return `spring.application.name=${appName}
spring.datasource.url=\${DATABASE_URL:${mysql ? `jdbc:mysql://localhost:3306/${appName}` : `jdbc:postgresql://localhost:5432/${appName}`}}
spring.datasource.driver-class-name=${mysql ? "com.mysql.cj.jdbc.Driver" : "org.postgresql.Driver"}
# JPA: Flyway handles schema so \`ddl-auto=validate\` is safer than \`update\`.
spring.jpa.hibernate.ddl-auto=validate${mysql ? `
# Migrations store UUIDs as CHAR(36); Hibernate defaults to BINARY(16) on MySQL.
spring.jpa.properties.hibernate.type.preferred_uuid_jdbc_type=CHAR` : ""}
spring.jpa.show-sql=false

# HikariCP — sized for a single-container deployment. Tune when scaling out
# or when fronted by PgBouncer.
spring.datasource.hikari.maximum-pool-size=20
spring.datasource.hikari.minimum-idle=2
spring.datasource.hikari.connection-timeout=10000
spring.datasource.hikari.idle-timeout=600000
spring.datasource.hikari.max-lifetime=1800000
spring.datasource.hikari.validation-timeout=5000

# Flyway auto-runs src/main/resources/db/migration/V*.sql on startup.
spring.flyway.enabled=true
spring.flyway.baseline-on-migrate=true
${authProps}${metricsProps}
server.port=\${PORT:8080}
`;
}

function springSecurityConfig(): string {
  return `package dev.helios.app;

import java.util.List;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Spring Security config: treat the app as an OAuth2 Resource Server. Spring
 * fetches the JWKS lazily, caches keys per RFC 7517, and validates signature
 * + iss + exp by default. We add an optional audience check on top.
 *
 * /health stays public; everything else requires an authenticated JWT.
 */
@Configuration
public class SecurityConfig {

    @Value("\${spring.security.oauth2.resourceserver.jwt.jwk-set-uri:}")
    private String jwkSetUri;

    @Value("\${spring.security.oauth2.resourceserver.jwt.issuer-uri:}")
    private String issuerUri;

    @Value("\${auth.expected-audience:}")
    private String expectedAudience;

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers("/health", "/actuator/**").permitAll()
                .anyRequest().authenticated())
            // Stateless API — disable CSRF since we don't use cookie-based sessions.
            .csrf(csrf -> csrf.disable())
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> {}));
        return http.build();
    }

    @Bean
    JwtDecoder jwtDecoder() {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(jwkSetUri).build();
        OAuth2TokenValidator<Jwt> defaultValidator = JwtValidators.createDefaultWithIssuer(issuerUri);
        if (expectedAudience == null || expectedAudience.isBlank()) {
            decoder.setJwtValidator(defaultValidator);
        } else {
            decoder.setJwtValidator(new DelegatingAudienceValidator(defaultValidator, expectedAudience));
        }
        return decoder;
    }

    private static final class DelegatingAudienceValidator implements OAuth2TokenValidator<Jwt> {
        private final OAuth2TokenValidator<Jwt> delegate;
        private final String audience;

        DelegatingAudienceValidator(OAuth2TokenValidator<Jwt> delegate, String audience) {
            this.delegate = delegate;
            this.audience = audience;
        }

        @Override
        public OAuth2TokenValidatorResult validate(Jwt jwt) {
            OAuth2TokenValidatorResult base = delegate.validate(jwt);
            if (base.hasErrors()) return base;
            List<String> audList = jwt.getAudience();
            if (audList != null && audList.contains(audience)) {
                return OAuth2TokenValidatorResult.success();
            }
            return OAuth2TokenValidatorResult.failure(
                new OAuth2Error("invalid_token", "audience mismatch", null));
        }
    }
}
`;
}

function scaffoldApiController(endpoints: Endpoint[], withPublisher = false): string {
  const publishes = (e: Endpoint) => withPublisher && e.pattern === "send_notification";
  const anyPublish = endpoints.some(publishes);
  const methods = endpoints.map(e => {
    const mapping = methodAnnotation(e.method);
    const name = handlerMethodName(e);
    if (publishes(e)) {
      // send_notification: hand the JSON body to the queue and acknowledge with 202.
      return `    @${mapping}(${JSON.stringify(springPath(e.path))})
    public ResponseEntity<Map<String, Object>> ${name}(@RequestBody String payload) {
        publisher.publish(payload);
        return ResponseEntity.accepted().body(Map.of("queued", true));
    }`;
    }
    return `    @${mapping}(${JSON.stringify(springPath(e.path))})
    public Map<String, Object> ${name}() {
        return Map.of("ok", true, "op", "${e.method} ${e.path}");
    }`;
  }).join("\n\n");

  return `package dev.helios.app;

${anyPublish ? "import dev.helios.app.messaging.NotificationPublisher;\nimport org.springframework.http.ResponseEntity;\n" : ""}import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
public class ApiController {
${anyPublish ? `
    private final NotificationPublisher publisher;

    public ApiController(NotificationPublisher publisher) {
        this.publisher = publisher;
    }
` : ""}
${methods}
}
`;
}

export function methodAnnotation(method: string): string {
  switch (method) {
    case "GET":    return "GetMapping";
    case "POST":   return "PostMapping";
    case "PUT":    return "PutMapping";
    case "PATCH":  return "PatchMapping";
    case "DELETE": return "DeleteMapping";
    default:       return "GetMapping";
  }
}

export function handlerMethodName(e: Endpoint): string {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map(p => p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p));
  return e.method.toLowerCase() + parts.join("");
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

// ─── Entity class ─────────────────────────────────────────────────────────────

function entityClass(entity: Entity, mysql = false, cached = false): string {
  const pascal = toPascal(entity.name);
  const tableName = toSnake(entity.name);
  const pk = pkField(entity);

  // Collect all needed imports
  const importSet = new Set<string>();
  importSet.add("jakarta.persistence.*");
  importSet.add("org.hibernate.annotations.CreationTimestamp");

  for (const f of entity.fields) {
    for (const imp of importsForType(f.type)) {
      importSet.add(imp);
    }
  }

  const importLines = [...importSet].map(i => `import ${i};`).join("\n");

  // Field declarations
  const fieldDeclarations = entity.fields.map(f => {
    const lines: string[] = [];
    if (f.primaryKey || f === pk) {
      lines.push("    @Id");
      lines.push("    @GeneratedValue(strategy = GenerationType.UUID)");
    } else if (f.name === "createdAt") {
      // One @Column: it isn't repeatable, so updatable=false merges into the field's own attributes.
      const col = columnAnnotation(f, mysql);
      lines.push(`    ${col === "@Column" ? "@Column(updatable = false)" : col.replace(/\)$/, ", updatable = false)")}`);
      lines.push("    @CreationTimestamp");
    } else {
      lines.push(`    ${columnAnnotation(f, mysql)}`);
    }
    lines.push(`    private ${javaShortType(f.type)} ${toCamel(f.name)};`);
    return lines.join("\n");
  }).join("\n\n");

  // Getters and setters
  const gettersSetters = entity.fields.map(f => {
    const fieldName = toCamel(f.name);
    const typeName = javaShortType(f.type);
    const capName = toPascal(f.name);
    return [
      `    public ${typeName} get${capName}() { return ${fieldName}; }`,
      `    public void set${capName}(${typeName} ${fieldName}) { this.${fieldName} = ${fieldName}; }`,
    ].join("\n");
  }).join("\n\n");

  // Inner DTO for create requests
  const dtoFields = entity.fields
    .filter(f => !f.primaryKey && f !== pk)
    .map(f => {
      const lines: string[] = [];
      const isString = f.type === "string" || f.type === "text";
      if (f.required) {
        lines.push(isString ? "        @NotBlank" : "        @NotNull");
      }
      lines.push(`        private ${javaShortType(f.type)} ${toCamel(f.name)};`);
      return lines.join("\n");
    }).join("\n\n");

  const dtoGettersSetters = entity.fields
    .filter(f => !f.primaryKey && f !== pk)
    .map(f => {
      const fieldName = toCamel(f.name);
      const typeName = javaShortType(f.type);
      const capName = toPascal(f.name);
      return [
        `        public ${typeName} get${capName}() { return ${fieldName}; }`,
        `        public void set${capName}(${typeName} ${fieldName}) { this.${fieldName} = ${fieldName}; }`,
      ].join("\n");
    }).join("\n\n");

  const validationImports = entity.fields
    .filter(f => !f.primaryKey && f !== pk && f.required)
    .some(f => f.type === "string" || f.type === "text")
    ? "import jakarta.validation.constraints.NotBlank;\nimport jakarta.validation.constraints.NotNull;"
    : entity.fields.filter(f => !f.primaryKey && f !== pk && f.required).length > 0
    ? "import jakarta.validation.constraints.NotNull;"
    : "";

  return `package dev.helios.app.model;

${importLines}
${validationImports ? validationImports + "\n" : ""}
@Entity
@Table(name = "${tableName}s")
public class ${pascal}${cached ? " implements java.io.Serializable" : ""} {

${fieldDeclarations}

    // No-args constructor (required by JPA)
    public ${pascal}() {}

${gettersSetters}

    // ─── Create request DTO ───────────────────────────────────────────────────

    public static class Create${pascal}Request {

${dtoFields}

${dtoGettersSetters}
    }
}
`;
}

// ─── Repository interface ─────────────────────────────────────────────────────

function repositoryInterface(entity: Entity): string {
  const pascal = toPascal(entity.name);
  const pk = pkField(entity);
  const idType = pk ? javaShortType(pk.type) : "UUID";
  const idImport = pk && pk.type === "number" ? "" : "import java.util.UUID;";

  return `package dev.helios.app.repository;

import dev.helios.app.model.${pascal};
import org.springframework.data.jpa.repository.JpaRepository;
${idImport}

public interface ${pascal}Repository extends JpaRepository<${pascal}, ${idType}> {}
`;
}

// ─── Service class ────────────────────────────────────────────────────────────

function serviceClass(entity: Entity, cached = false): string {
  const pascal = toPascal(entity.name);
  const pk = pkField(entity);
  const idType = pk ? javaShortType(pk.type) : "UUID";
  const idImport = pk && pk.type === "uuid"
    ? "import java.util.UUID;"
    : "import java.util.UUID;";

  const nonPkFields = entity.fields.filter(f => !f.primaryKey && f !== pk);
  // Redis cache-aside via Spring's cache abstraction: reads hit Redis first,
  // writes evict so the next read reloads from the database.
  const cacheName = `${toCamel(entity.name)}s`;
  const cacheable = cached ? `    @Cacheable(cacheNames = "${cacheName}", key = "#id", unless = "#result == null")\n` : "";
  const evict = cached ? `    @CacheEvict(cacheNames = "${cacheName}", key = "#id")\n` : "";
  const nullChecks = nonPkFields.map(f => {
    const capName = toPascal(f.name);
    return `            if (updates.get${capName}() != null) existing.set${capName}(updates.get${capName}());`;
  }).join("\n");

  return `package dev.helios.app.service;

import dev.helios.app.model.${pascal};
import dev.helios.app.repository.${pascal}Repository;
${cached ? "import org.springframework.cache.annotation.CacheEvict;\nimport org.springframework.cache.annotation.Cacheable;\n" : ""}import org.springframework.stereotype.Service;
${idImport}
import java.util.List;
import java.util.Optional;

@Service
public class ${pascal}Service {

    private final ${pascal}Repository repo;

    public ${pascal}Service(${pascal}Repository repo) {
        this.repo = repo;
    }

    public List<${pascal}> findAll() {
        return repo.findAll();
    }

${cacheable}    public Optional<${pascal}> findById(${idType} id) {
        return repo.findById(id);
    }

    public ${pascal} create(${pascal} ${toCamel(entity.name)}) {
        return repo.save(${toCamel(entity.name)});
    }

${evict}    public Optional<${pascal}> update(${idType} id, ${pascal} updates) {
        return repo.findById(id).map(existing -> {
${nullChecks}
            return repo.save(existing);
        });
    }

${evict}    public boolean delete(${idType} id) {
        if (!repo.existsById(id)) return false;
        repo.deleteById(id);
        return true;
    }
}
`;
}

// ─── Controller class ─────────────────────────────────────────────────────────

/** Java expression for the "<entity>.created" event body, matching Kotlin's. */
function createdEvent(entity: Entity, idExpr: string): string {
  return `"{\\"event\\":\\"${toKebab(entity.name)}.created\\",\\"id\\":\\"" + ${idExpr} + "\\"}"`;
}

function controllerClass(entity: Entity, publisher = false): string {
  const pascal = toPascal(entity.name);
  const kebab = toKebab(entity.name);
  const camel = toCamel(entity.name);
  const pk = pkField(entity);
  const idType = pk ? javaShortType(pk.type) : "UUID";
  const idImport = pk && pk.type === "uuid"
    ? "import java.util.UUID;"
    : "import java.util.UUID;";

  return `package dev.helios.app.controller;

${publisher ? "import dev.helios.app.messaging.NotificationPublisher;\n" : ""}import dev.helios.app.model.${pascal};
import dev.helios.app.service.${pascal}Service;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
${idImport}
import java.util.List;

@RestController
@RequestMapping("/${kebab}s")
public class ${pascal}Controller {

    private final ${pascal}Service service;${publisher ? "\n    private final NotificationPublisher publisher;" : ""}

    public ${pascal}Controller(${pascal}Service service${publisher ? ", NotificationPublisher publisher" : ""}) {
        this.service = service;${publisher ? "\n        this.publisher = publisher;" : ""}
    }

    @GetMapping
    public List<${pascal}> list() {
        return service.findAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<${pascal}> getById(@PathVariable ${idType} id) {
        return service.findById(id)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    public ResponseEntity<${pascal}> create(@RequestBody ${pascal} ${camel}) {${publisher ? `
        ${pascal} saved = service.create(${camel});
        publisher.publish(${createdEvent(entity, `saved.get${toPascal(pk?.name ?? "id")}()`)});
        return ResponseEntity.status(HttpStatus.CREATED).body(saved);` : `
        return ResponseEntity.status(HttpStatus.CREATED).body(service.create(${camel}));`}
    }

    @PutMapping("/{id}")
    public ResponseEntity<${pascal}> update(@PathVariable ${idType} id, @RequestBody ${pascal} updates) {
        return service.update(id, updates)
            .map(ResponseEntity::ok)
            .orElse(ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable ${idType} id) {
        return service.delete(id)
            ? ResponseEntity.noContent().<Void>build()
            : ResponseEntity.notFound().<Void>build();
    }
}
`;
}

// ─── Controller test ──────────────────────────────────────────────────────────

/** Brokers are down in unit tests, so tests that create entities mock the publisher. */
const SPRING_PUBLISHER_MOCK = `
    @MockBean
    dev.helios.app.messaging.NotificationPublisher publisher;
`;
const QUARKUS_PUBLISHER_MOCK = `
    @io.quarkus.test.InjectMock
    dev.helios.app.messaging.NotificationPublisher publisher;
`;

function controllerTest(entity: Entity, withAuth = false, publisher = false): string {
  const pascal = toPascal(entity.name);
  const kebab = toKebab(entity.name);

  const requiredNonPk = entity.fields.filter(f => !f.primaryKey && f !== pkField(entity) && f.required);
  // Escape the value's quotes too: the pairs are embedded in a Java string literal.
  const bodyPairs = requiredNonPk.slice(0, 5).map(f => `\\"${toCamel(f.name)}\\": ${testValue(f).replace(/"/g, '\\"')}`).join(", ");
  const createBody = requiredNonPk.length > 0
    ? `"{${bodyPairs}}"`
    : `"{}"`;

  return `package dev.helios.app;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
${withAuth || publisher ? "import org.springframework.boot.test.mock.mockito.MockBean;\n" : ""}import org.springframework.http.MediaType;
${withAuth ? "import org.springframework.security.oauth2.jwt.JwtDecoder;\n" : ""}import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
${withAuth ? "import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;\n" : ""}import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ${pascal}ControllerTest {

    @Autowired
    MockMvc mvc;
${withAuth ? `
    // Routes require a Bearer JWT; jwt() injects an authenticated principal and
    // the mocked decoder keeps the context from needing a live JWKS endpoint.
    @MockBean
    JwtDecoder jwtDecoder;
` : ""}${publisher ? SPRING_PUBLISHER_MOCK : ""}
    @Test
    void list${pascal}s_returnsOk() throws Exception {
        mvc.perform(get("/${kebab}s")${withAuth ? ".with(jwt())" : ""})
           .andExpect(status().isOk());
    }

    @Test
    void create${pascal}_returnsCreated() throws Exception {
        String body = ${createBody};
        mvc.perform(post("/${kebab}s")${withAuth ? "\n                .with(jwt())" : ""}
                .contentType(MediaType.APPLICATION_JSON)
                .content(body))
           .andExpect(status().isCreated());
    }
}
`;
}

// ─── Quarkus (minimal path) ───────────────────────────────────────────────────

function quarkusFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[]
): GeneratedFile[] {
  const artifact = safe(config.name);
  const files: GeneratedFile[] = [];
  const withAuth = needsAuth(config, endpoints.some((e) => e.auth));
  const mysql = isMysql(config.database);
  const metrics = config.monitoring === "grafana";
  const infra = quarkusInfra(config);

  files.push({ path: "pom.xml",    content: quarkusPom(artifact, withAuth, mysql, metrics, infra) });
  files.push({ path: "Dockerfile", content: quarkusDockerfile() });
  files.push({
    path: "src/main/resources/application.properties",
    content: quarkusAppProperties(config.name, withAuth, mysql) + infra.props,
  });
  // Always served — the K8s probes and docker-compose healthcheck hit /health.
  files.push({
    path: "src/main/java/dev/helios/app/HealthResource.java",
    content: quarkusHealthResource(),
  });
  files.push(...infra.files);

  for (const entity of entities) {
    const pascal = toPascal(entity.name);
    const kebab = toKebab(entity.name);
    files.push({
      path: `src/main/java/dev/helios/app/${pascal}.java`,
      content: quarkusEntity(entity, mysql),
    });
    files.push({
      path: `src/main/java/dev/helios/app/${pascal}Resource.java`,
      content: quarkusResource(entity, pascal, kebab, withAuth, infra.cache, infra.publisher),
    });
    // Smoke test mirrors what the Spring path emits — list returns 200,
    // create returns 201. Real assertion logic is left to the user, who
    // knows the domain. The test exists so `mvn test` exercises the
    // route table, which is enough to catch missing dependencies and
    // reflectively-broken Panache bindings.
    files.push({
      path: `src/test/java/dev/helios/app/${pascal}ResourceTest.java`,
      content: quarkusResourceTest(entity, pascal, kebab, withAuth, infra.publisher),
    });
  }

  // Same rule as Spring: endpoint stubs only when no entity CRUD owns the paths.
  const stubs = endpoints.filter((e) => e.path !== "/health");
  if (entities.length === 0 && stubs.length > 0) {
    files.push({
      path: "src/main/java/dev/helios/app/ApiResource.java",
      content: quarkusApiResource(stubs, withAuth, infra.publisher),
    });
  }

  return files;
}

function quarkusApiResource(endpoints: Endpoint[], withAuth: boolean, withPublisher = false): string {
  const publishes = (e: Endpoint) => withPublisher && e.pattern === "send_notification";
  const anyPublish = endpoints.some(publishes);
  const methods = endpoints.map((e) => {
    const verb = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(e.method) ? e.method : "GET";
    const auth = withAuth && e.auth ? "\n    @Authenticated" : "";
    if (publishes(e)) {
      // send_notification: hand the JSON body to the queue and acknowledge with 202.
      return `    @${verb}
    @Path(${JSON.stringify(springPath(e.path))})${auth}
    @Consumes(MediaType.APPLICATION_JSON)
    public Response ${handlerMethodName(e)}(String payload) {
        publisher.publish(payload);
        return Response.accepted(Map.of("queued", true)).build();
    }`;
    }
    return `    @${verb}
    @Path(${JSON.stringify(springPath(e.path))})${auth}
    public Map<String, Object> ${handlerMethodName(e)}() {
        return Map.of("ok", true, "op", "${e.method} ${e.path}");
    }`;
  }).join("\n\n");

  return `package dev.helios.app;

${anyPublish ? "import dev.helios.app.messaging.NotificationPublisher;\n" : ""}${withAuth ? "import io.quarkus.security.Authenticated;\n" : ""}${anyPublish ? "import jakarta.inject.Inject;\n" : ""}import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
${anyPublish ? "import jakarta.ws.rs.core.Response;\n" : ""}import java.util.Map;

@Path("/")
@Produces(MediaType.APPLICATION_JSON)
public class ApiResource {
${anyPublish ? `
    @Inject
    NotificationPublisher publisher;
` : ""}
${methods}
}
`;
}

function quarkusPom(artifactId: string, withAuth = false, mysql = false, metrics = false, infra?: JavaInfra): string {
  const extra = [
    // SmallRye JWT verifies Bearer tokens against AUTH_JWKS_URL (see application.properties).
    withAuth ? "quarkus-smallrye-jwt" : "",
    // Micrometer + Prometheus registry → /q/metrics.
    metrics ? "quarkus-micrometer-registry-prometheus" : "",
    // /q/health/ready checks (datasource, Redis, broker) behind /health?ready=1.
    "quarkus-smallrye-health",
  ]
    .filter(Boolean)
    .map((a) => `    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>${a}</artifactId>
    </dependency>
`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.helios</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>0.1.0</version>
  <properties>
    <quarkus.platform.version>3.15.1</quarkus.platform.version>
    <maven.compiler.source>21</maven.compiler.source>
    <maven.compiler.target>21</maven.compiler.target>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>io.quarkus.platform</groupId>
        <artifactId>quarkus-bom</artifactId>
        <version>\${quarkus.platform.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
${infra?.boms ?? ""}    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-resteasy-reactive-jackson</artifactId>
    </dependency>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-hibernate-orm-panache</artifactId>
    </dependency>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>${mysql ? "quarkus-jdbc-mysql" : "quarkus-jdbc-postgresql"}</artifactId>
    </dependency>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-smallrye-openapi</artifactId>
    </dependency>
${extra}${infra?.deps ?? ""}    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-junit5</artifactId>
      <scope>test</scope>
    </dependency>
${infra?.publisher ? `    <!-- @InjectMock: tests run without a broker, so the publisher is mocked. -->
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-junit5-mockito</artifactId>
      <scope>test</scope>
    </dependency>
` : ""}    <dependency>
      <groupId>io.rest-assured</groupId>
      <artifactId>rest-assured</artifactId>
      <scope>test</scope>
    </dependency>
${withAuth ? `    <!-- @TestSecurity: contract tests call protected routes as an authenticated user. -->
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-test-security</artifactId>
      <scope>test</scope>
    </dependency>
` : ""}    <!-- Tests run on in-memory H2 (%test profile) instead of a live database. -->
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-jdbc-h2</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>io.quarkus.platform</groupId>
        <artifactId>quarkus-maven-plugin</artifactId>
        <version>\${quarkus.platform.version}</version>
        <executions>
          <execution>
            <goals><goal>build</goal><goal>generate-code</goal></goals>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function quarkusAppProperties(appName: string, withAuth = false, mysql = false): string {
  const authProps = withAuth
    ? `
# SmallRye JWT: signature via the provider's JWKS, plus iss/aud checks.
# An unset AUTH_JWKS_URL leaves no verification key, so protected routes return 401.
mp.jwt.verify.publickey.location=\${AUTH_JWKS_URL:}
mp.jwt.verify.issuer=\${AUTH_ISSUER:}
mp.jwt.verify.audiences=\${AUTH_AUDIENCE:}
# SmallRye JWT refuses to start with an empty issuer / key location; tests never
# present a token, so placeholders are enough (keys are only fetched to verify one).
%test.mp.jwt.verify.issuer=https://issuer.test
%test.mp.jwt.verify.publickey.location=https://issuer.test/.well-known/jwks.json
`
    : "";
  return `quarkus.application.name=${appName}
quarkus.datasource.db-kind=${mysql ? "mysql" : "postgresql"}
quarkus.datasource.jdbc.url=\${DATABASE_URL:${mysql ? `jdbc:mysql://localhost:3306/${appName}` : `jdbc:postgresql://localhost:5432/${appName}`}}
quarkus.hibernate-orm.database.generation=update
# snake_case columns (createdAt → created_at), matching db/migration/V1__init.sql and Spring.
quarkus.hibernate-orm.physical-naming-strategy=org.hibernate.boot.model.naming.CamelCaseToUnderscoresNamingStrategy
quarkus.http.port=\${PORT:8080}
# Tests use in-memory H2 so \`mvn test\` needs no database.
%test.quarkus.datasource.db-kind=h2
%test.quarkus.datasource.jdbc.url=jdbc:h2:mem:test;DB_CLOSE_DELAY=-1
${authProps}`;
}

function quarkusEntity(entity: Entity, mysql = false): string {
  const pascal = toPascal(entity.name);
  const tableName = toSnake(entity.name);

  const importSet = new Set<string>();
  importSet.add("jakarta.persistence.*");
  importSet.add("io.quarkus.hibernate.orm.panache.PanacheEntityBase");

  for (const f of entity.fields) {
    for (const imp of importsForType(f.type)) {
      importSet.add(imp);
    }
  }

  const importLines = [...importSet].map(i => `import ${i};`).join("\n");
  const pk = pkField(entity);

  const fieldDeclarations = entity.fields.map(f => {
    const lines: string[] = [];
    if (f.primaryKey || f === pk) {
      lines.push("    @Id");
      lines.push("    @GeneratedValue(strategy = GenerationType.UUID)");
    } else {
      lines.push(`    ${columnAnnotation(f, mysql)}`);
    }
    lines.push(`    public ${javaShortType(f.type)} ${toCamel(f.name)};`);
    return lines.join("\n");
  }).join("\n\n");

  return `package dev.helios.app;

${importLines}

@Entity
@Table(name = "${tableName}s")
public class ${pascal} extends PanacheEntityBase {

${fieldDeclarations}
}
`;
}

function quarkusResource(entity: Entity, pascal: string, kebab: string, withAuth = false, cached = false, publisher = false): string {
  const pk = pkField(entity);
  // Redis cache-aside (JsonCache): get-by-id reads Redis first; update/delete evict.
  const key = `"${kebab}s:" + id`;
  const evict = cached ? `\n        cache.evict(${key});` : "";
  const idType = pk ? javaShortType(pk.type) : "UUID";
  const idImport = "import java.util.UUID;";
  // Same merge as the Spring service: every writable field the body carries replaces the
  // stored value; the managed entity is flushed when the @Transactional method commits.
  const merge = entity.fields.filter(f => !f.primaryKey && f !== pk).map(f => {
    const n = toCamel(f.name);
    return `        if (updates.${n} != null) existing.${n} = updates.${n};`;
  }).join("\n");

  return `package dev.helios.app;

${cached ? "import dev.helios.app.infra.JsonCache;\n" : ""}${publisher ? "import dev.helios.app.messaging.NotificationPublisher;\n" : ""}${withAuth ? "import io.quarkus.security.Authenticated;\n" : ""}${cached || publisher ? "import jakarta.inject.Inject;\n" : ""}import jakarta.transaction.Transactional;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
${idImport}
import java.util.List;

@Path("/${kebab}s")${withAuth ? "\n@Authenticated" : ""}
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class ${pascal}Resource {
${cached ? `
    @Inject
    JsonCache cache;
` : ""}${publisher ? `
    @Inject
    NotificationPublisher publisher;
` : ""}
    @GET
    public List<${pascal}> list() {
        return ${pascal}.listAll();
    }

    @GET
    @Path("/{id}")
    public Response getById(@PathParam("id") ${idType} id) {${cached ? `
        ${pascal} cached = cache.get(${key}, ${pascal}.class);
        if (cached != null) return Response.ok(cached).build();` : ""}
        ${pascal} entity = ${pascal}.findById(id);
        if (entity == null) return Response.status(Response.Status.NOT_FOUND).build();${cached ? `
        cache.put(${key}, entity);` : ""}
        return Response.ok(entity).build();
    }

    @POST
    @Transactional
    public Response create(${pascal} entity) {
        entity.persist();${publisher ? `
        publisher.publish(${createdEvent(entity, `entity.${toCamel(pk?.name ?? "id")}`)});` : ""}
        return Response.status(Response.Status.CREATED).entity(entity).build();
    }

    @PUT
    @Path("/{id}")
    @Transactional
    public Response update(@PathParam("id") ${idType} id, ${pascal} updates) {
        ${pascal} existing = ${pascal}.findById(id);
        if (existing == null) return Response.status(Response.Status.NOT_FOUND).build();
${merge}${evict}
        return Response.ok(existing).build();
    }

    @DELETE
    @Path("/{id}")
    @Transactional
    public Response delete(@PathParam("id") ${idType} id) {
        boolean deleted = ${pascal}.deleteById(id);${evict}
        return deleted
            ? Response.noContent().build()
            : Response.status(Response.Status.NOT_FOUND).build();
    }
}
`;
}

function quarkusHealthResource(): string {
  return `package dev.helios.app;

import io.smallrye.health.SmallRyeHealth;
import io.smallrye.health.SmallRyeHealthReporter;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.Map;

/**
 * Liveness: GET /health. Readiness: GET /health?ready=1 runs every SmallRye
 * readiness check (datasource, Redis, message broker) and answers 503 while
 * any of them is down, so Kubernetes stops routing traffic here.
 */
@Path("/health")
public class HealthResource {

    @Inject
    SmallRyeHealthReporter reporter;

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response health(@QueryParam("ready") String ready) {
        if (ready == null) return Response.ok(Map.of("ok", true)).build();
        SmallRyeHealth readiness = reporter.getReadiness();
        boolean up = !readiness.isDown();
        return Response.status(up ? 200 : 503).entity(Map.of("ok", up)).build();
    }
}
`;
}

function quarkusResourceTest(entity: Entity, pascal: string, kebab: string, withAuth = false, publisher = false): string {
  // A valid body (required fields filled, unique values fresh): "{}" violates the
  // NOT NULL columns and answers 500 once auth is off. ApiContractTest covers the rest of CRUD.
  // PUT once answered 200 without touching the row: prove a field actually changes and sticks.
  const pk = pkField(entity);
  const str = entity.fields.find(f => !f.primaryKey && f !== pk && (f.type === "string" || f.type === "text"));
  const updateTest = withAuth || !str ? "" : `
    @Test
    void update${pascal}_appliesBody() {
        String id = given().contentType("application/json").body(${javaEntityBody(entity)})
               .when().post("/${kebab}s")
               .then().statusCode(201).extract().path("${toCamel(pk?.name ?? "id")}");
        String changed = unique();
        given().contentType("application/json").body("{\\"${toCamel(str.name)}\\":\\"" + changed + "\\"}")
               .when().put("/${kebab}s/" + id)
               .then().statusCode(200).body("${toCamel(str.name)}", org.hamcrest.Matchers.equalTo(changed));
        given().when().get("/${kebab}s/" + id)
               .then().statusCode(200).body("${toCamel(str.name)}", org.hamcrest.Matchers.equalTo(changed));
    }
`;
  return `package dev.helios.app;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;

@QuarkusTest
class ${pascal}ResourceTest {
${publisher ? QUARKUS_PUBLISHER_MOCK : ""}
    private static String unique() {
        return "test-" + java.util.UUID.randomUUID();
    }

    @Test
    void list${pascal}s_${withAuth ? "rejectsMissingToken" : "returnsOk"}() {
        given().when().get("/${kebab}s")
               .then().statusCode(${withAuth ? 401 : 200});
    }

    @Test
    void create${pascal}_${withAuth ? "rejectsMissingToken" : "returnsCreated"}() {
        given().contentType("application/json").body(${javaEntityBody(entity)})
               .when().post("/${kebab}s")
               .then().statusCode(${withAuth ? 401 : 201});
    }
${updateTest}}
`;
}

// ─── API contract tests (emitted from contract-tests.ts) ──────────────────────

type JavaContractCase = {
  name: string;       // Java identifier stem, e.g. getUsersById
  method: string;
  path: string;       // Java expression for the request path
  protected: boolean;
  status: number;     // expected status with a principal (or with auth off)
  body?: string;      // Java expression for a JSON body
  createFor?: string; // entity pascal: the test first creates a row and binds `id`
  json?: "object" | "array";
  keys?: string[];    // top-level keys the response object must carry
  // ponytail: publish stubs get a request rejected before the broker is touched
  // (Spring: missing body → 400, Quarkus: wrong media type → 415). That proves the
  // route is wired and authorized without a live queue during `mvn test`.
  rejectBody?: boolean;
};

const javaStr = (s: string) => JSON.stringify(s);

/** Required fields get fresh values per request so unique columns never collide across tests. */
function javaEntityBody(entity: Entity): string {
  const pk = pkField(entity);
  const json = "{" + entity.fields.filter((f) => !f.primaryKey && f !== pk && f.required).map((f) => {
    const k = `"${toCamel(f.name)}":`;
    switch (f.type) {
      case "string":
      case "text": return `${k}"\u0000unique()\u0000"`;
      case "uuid": return `${k}"\u0000java.util.UUID.randomUUID()\u0000"`;
      default:     return k + testValue(f);
    }
  }).join(",") + "}";
  // Odd segments (between \0 markers) are Java expressions, even ones JSON text.
  return json.split("\u0000").map((seg, i) => (i % 2 ? seg : javaStr(seg))).join(" + ");
}

function javaContractCases(config: StackConfig, endpoints: Endpoint[], entities: Entity[], withAuth: boolean, spring: boolean): JavaContractCase[] {
  const publisher = javaQueue(config.queue) !== null;
  const cases: JavaContractCase[] = [
    { name: "getHealth", method: "GET", path: javaStr("/health"), protected: false, status: 200, json: "object", keys: ["ok"] },
  ];
  // Same rule as the generators: stubs only when no entity CRUD owns the paths.
  const stubs = entities.length === 0 ? endpoints.filter((e) => e.path !== "/health") : [];
  for (const e of stubs) {
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(e.method) ? e.method : "GET";
    const publishes = publisher && e.pattern === "send_notification";
    cases.push({
      name: handlerMethodName(e),
      method,
      path: javaStr(springPath(e.path).replace(/\{[^}]+\}/g, "1")),
      // Spring's SecurityConfig protects every route but /health; Quarkus marks stubs @Authenticated one by one.
      protected: withAuth && (spring || e.auth),
      status: publishes ? (spring ? 400 : 415) : 200,
      body: ["POST", "PUT", "PATCH"].includes(method) ? javaStr("{}") : undefined,
      rejectBody: publishes,
      json: publishes ? undefined : "object",
      keys: publishes ? undefined : ["op"],
    });
  }
  for (const entity of entities) {
    const pascal = toPascal(entity.name);
    const base = `/${toKebab(entity.name)}s`;
    const pk = pkField(entity);
    const pkName = toCamel(pk?.name ?? "id");
    const keys = [pkName, ...entity.fields.filter((f) => !f.primaryKey && f !== pk && f.required).map((f) => toCamel(f.name))];
    const body = `body${pascal}()`;
    const byId = `${javaStr(`${base}/`)} + id`;
    const n = (m: string, suffix = "") => `${m.toLowerCase()}${pascal}s${suffix}`;
    cases.push(
      { name: n("GET"), method: "GET", path: javaStr(base), protected: withAuth, status: 200, json: "array" },
      { name: n("POST"), method: "POST", path: javaStr(base), protected: withAuth, status: 201, body, json: "object", keys },
      { name: n("GET", "ById"), method: "GET", path: byId, protected: withAuth, status: 200, createFor: pascal, json: "object", keys: [pkName] },
      { name: n("PUT", "ById"), method: "PUT", path: byId, protected: withAuth, status: 200, createFor: pascal, body, json: "object", keys: [pkName] },
      { name: n("DELETE", "ById"), method: "DELETE", path: byId, protected: withAuth, status: 204, createFor: pascal },
    );
  }
  return cases;
}

/** Unique, valid Java method names: stem_suffix, then stem_suffix2, … */
function javaTestNames(): (stem: string, suffix: string) => string {
  const seen = new Map<string, number>();
  return (stem, suffix) => {
    const base = `${stem.replace(/[^A-Za-z0-9_]/g, "") || "route"}_${suffix}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  };
}

type JavaRender = (fn: string, c: JavaContractCase, principal: boolean, status: number) => string;

// Protected routes get a 401-without-principal test plus a with-principal test.
function javaContractMethods(cases: JavaContractCase[], render: JavaRender): string {
  const name = javaTestNames();
  return cases.map((c) =>
    c.protected
      // The 401 check needs no row: a random id keeps it independent of the database.
      ? render(name(c.name, "returns401WithoutToken"), { ...c, createFor: undefined, path: c.path.replace(/ \+ id$/, " + java.util.UUID.randomUUID()") }, false, 401) +
        render(name(c.name, `returns${c.status}WithToken`), c, true, c.status)
      : render(name(c.name, `returns${c.status}`), c, false, c.status)
  ).join("");
}

function springContractTest(cases: JavaContractCase[], entities: Entity[], withAuth: boolean, publisher: boolean): string {
  const jwt = (principal: boolean) => (principal ? ".with(jwt())" : "");
  const render: JavaRender = (fn, c, principal, status) => {
    const req = [`request(HttpMethod.${c.method}, ${c.path})${jwt(principal)}`];
    if (c.body && !(status !== 401 && c.rejectBody)) req.push(".contentType(MediaType.APPLICATION_JSON)", `.content(${c.body})`);
    const expects = [`.andExpect(status().is(${status}))`];
    if (status !== 401 && c.json) {
      expects.push(".andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))");
      if (c.json === "array") expects.push('.andExpect(jsonPath("$").isArray())');
      for (const k of c.keys ?? []) expects.push(`.andExpect(jsonPath(${javaStr(`$.${k}`)}).exists())`);
    }
    return `
    @Test
    void ${fn}() throws Exception {
${c.createFor ? `        String id = create${c.createFor}();\n` : ""}        mvc.perform(${req.join("\n                ")})
            ${expects.join("\n            ")};
    }
`;
  };
  const helpers = entities.map((e) => {
    const pascal = toPascal(e.name);
    return `
    private static String body${pascal}() {
        return ${javaEntityBody(e)};
    }

    private String create${pascal}() throws Exception {
        String json = mvc.perform(post(${javaStr(`/${toKebab(e.name)}s`)})${jwt(withAuth)}
                .contentType(MediaType.APPLICATION_JSON)
                .content(body${pascal}()))
            .andExpect(status().isCreated())
            .andReturn().getResponse().getContentAsString();
        Object id = JsonPath.read(json, ${javaStr(`$.${toCamel(pkField(e)?.name ?? "id")}`)});
        return id.toString();
    }
`;
  }).join("");
  return `package dev.helios.app;

${entities.length ? "import com.jayway.jsonpath.JsonPath;\n" : ""}import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
${withAuth || publisher ? "import org.springframework.boot.test.mock.mockito.MockBean;\n" : ""}import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
${withAuth ? "import org.springframework.security.oauth2.jwt.JwtDecoder;\n" : ""}import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

${withAuth ? "import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;\n" : ""}import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * Contract tests: every route is served (not 404), protected routes reject a
 * missing token and accept an authenticated principal, JSON responses carry the
 * expected shape, and entity CRUD round-trips. The "test" profile runs on
 * in-memory H2 with brokers and exporters off, so no external services are needed.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ApiContractTest {

    @Autowired
    MockMvc mvc;
${withAuth ? `
    // jwt() supplies the authenticated principal; the mock keeps the context off the JWKS endpoint.
    @MockBean
    JwtDecoder jwtDecoder;
` : ""}${publisher ? SPRING_PUBLISHER_MOCK : ""}
    private static String unique() {
        return "test-" + java.util.UUID.randomUUID();
    }
${helpers}${javaContractMethods(cases, render)}}
`;
}

function quarkusContractTest(cases: JavaContractCase[], entities: Entity[], withAuth: boolean, publisher: boolean): string {
  const render: JavaRender = (fn, c, principal, status) => {
    const given = ["given()"];
    if (status !== 401 && c.rejectBody) given.push('.contentType(ContentType.TEXT).body("not json")');
    else if (c.body) given.push(".contentType(ContentType.JSON)", `.body(${c.body})`);
    const then = [`.statusCode(${status})`];
    if (status !== 401 && c.json) {
      then.push(".contentType(ContentType.JSON)");
      if (c.json === "array") then.push('.body("$", instanceOf(java.util.List.class))');
      for (const k of c.keys ?? []) then.push(`.body("$", hasKey(${javaStr(k)}))`);
    }
    return `
    @Test${principal ? `\n    @TestSecurity(user = "test")` : ""}
    void ${fn}() {
${c.createFor ? `        String id = create${c.createFor}();\n` : ""}        ${given.join("")}
            .when().request(${javaStr(c.method)}, ${c.path})
            .then()${then.join("")};
    }
`;
  };
  const helpers = entities.map((e) => {
    const pascal = toPascal(e.name);
    return `
    private static String body${pascal}() {
        return ${javaEntityBody(e)};
    }

${withAuth ? "    // Runs inside the calling test, so it inherits that test's @TestSecurity principal.\n" : ""}    private static String create${pascal}() {
        Object id = given().contentType(ContentType.JSON).body(body${pascal}())
            .when().post(${javaStr(`/${toKebab(e.name)}s`)})
            .then().statusCode(201)
            .extract().path(${javaStr(toCamel(pkField(e)?.name ?? "id"))});
        return id.toString();
    }
`;
  }).join("");
  return `package dev.helios.app;

import io.quarkus.test.junit.QuarkusTest;
${withAuth ? "import io.quarkus.test.security.TestSecurity;\n" : ""}import io.restassured.http.ContentType;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

/**
 * Contract tests: every route is served (not 404), protected routes reject a
 * missing token and accept an authenticated principal (@TestSecurity), JSON
 * responses carry the expected shape, and entity CRUD round-trips. The %test
 * profile runs on in-memory H2 with brokers and exporters off.
 */
@QuarkusTest
class ApiContractTest {
${publisher ? QUARKUS_PUBLISHER_MOCK : ""}
    private static String unique() {
        return "test-" + java.util.UUID.randomUUID();
    }
${helpers}${javaContractMethods(cases, render)}}
`;
}

/** ApiContractTest.java per framework; emitted from contract-tests.ts. */
export function javaContractTestFiles(config: StackConfig, endpoints: Endpoint[], entities: Entity[]): GeneratedFile[] {
  const withAuth = needsAuth(config, endpoints.some((e) => e.auth));
  const spring = config.framework !== "quarkus";
  const publisher = javaQueue(config.queue) !== null;
  const cases = javaContractCases(config, endpoints, entities, withAuth, spring);
  return [{
    path: "src/test/java/dev/helios/app/ApiContractTest.java",
    content: spring ? springContractTest(cases, entities, withAuth, publisher) : quarkusContractTest(cases, entities, withAuth, publisher),
  }];
}

// ─── Suppress unused-import warnings for re-exported symbols ─────────────────
// EntityField is referenced in function signatures indirectly via Entity.fields
void (null as unknown as EntityField);

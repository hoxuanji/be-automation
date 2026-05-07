import type { Endpoint, GeneratedFile, StackConfig } from "./types";

export function rustFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const routes = endpoints
    .map((e) => {
      const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
      return `        .route("${path}", ${axumMethod(e.method)}(|| async { Json(json!({"ok": true, "op": "${e.method} ${e.path}"})) }))`;
    })
    .join("\n");
  return [
    {
      path: "Cargo.toml",
      content: `[package]
name = "${config.name.replace(/[^a-zA-Z0-9_]/g, "_")}"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tower-http = { version = "0.6", features = ["trace"] }
tracing-subscriber = "0.3"
`,
    },
    {
      path: "Dockerfile",
      content: `# syntax=docker/dockerfile:1
FROM rust:1.82 AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM gcr.io/distroless/cc
COPY --from=build /src/target/release/* /api
EXPOSE 8080
ENTRYPOINT ["/api"]
`,
    },
    {
      path: "src/main.rs",
      content: `use axum::{routing::{get, post, put, patch, delete}, Json, Router};
use serde_json::json;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
${routes};

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
`,
    },
  ];
}

function axumMethod(m: string) {
  return m.toLowerCase();
}

export function javaFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const routes = endpoints
    .map((e) => {
      const mapping =
        e.method === "GET"
          ? "GetMapping"
          : e.method === "POST"
          ? "PostMapping"
          : e.method === "PUT"
          ? "PutMapping"
          : e.method === "PATCH"
          ? "PatchMapping"
          : "DeleteMapping";
      return `    @${mapping}(${JSON.stringify(springPath(e.path))})
    public Map<String, Object> ${handlerName(e)}() {
        return Map.of("ok", true, "op", "${e.method} ${e.path}");
    }`;
    })
    .join("\n\n");
  return [
    {
      path: "pom.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.4</version>
  </parent>
  <groupId>dev.helios</groupId>
  <artifactId>${config.name.replace(/[^a-zA-Z0-9]/g, "-")}</artifactId>
  <version>0.1.0</version>
  <properties><java.version>21</java.version></properties>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
  </dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>
`,
    },
    {
      path: "Dockerfile",
      content: `FROM eclipse-temurin:21-jre
WORKDIR /app
COPY target/*.jar /app/api.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/api.jar"]
`,
    },
    {
      path: "src/main/java/dev/helios/app/Application.java",
      content: `package dev.helios.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class Application {
  public static void main(String[] args) { SpringApplication.run(Application.class, args); }
}
`,
    },
    {
      path: "src/main/java/dev/helios/app/ApiController.java",
      content: `package dev.helios.app;

import org.springframework.web.bind.annotation.*;
import java.util.Map;

@RestController
public class ApiController {

    @GetMapping("/health")
    public Map<String, Object> health() { return Map.of("ok", true); }

${routes}
}
`,
    },
  ];
}

export function kotlinFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const routes = endpoints
    .map((e) => {
      const path = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
      return `        ${ktorMethod(e.method)}(${JSON.stringify(path)}) {
            call.respond(mapOf("ok" to true, "op" to "${e.method} ${e.path}"))
        }`;
    })
    .join("\n\n");
  return [
    {
      path: "build.gradle.kts",
      content: `plugins { kotlin("jvm") version "2.0.0"; application }
application { mainClass.set("MainKt") }
dependencies {
    implementation("io.ktor:ktor-server-core:2.3.12")
    implementation("io.ktor:ktor-server-netty:2.3.12")
    implementation("io.ktor:ktor-server-content-negotiation:2.3.12")
    implementation("io.ktor:ktor-serialization-jackson:2.3.12")
}
`,
    },
    {
      path: "Dockerfile",
      content: `FROM eclipse-temurin:21-jre
WORKDIR /app
COPY build/libs/*.jar /app/api.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/api.jar"]
`,
    },
    {
      path: "src/main/kotlin/Main.kt",
      content: `import io.ktor.serialization.jackson.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun main() {
    embeddedServer(Netty, port = 8080) {
        install(ContentNegotiation) { jackson() }
        routing {
            get("/health") { call.respond(mapOf("ok" to true)) }
${routes}
        }
    }.start(wait = true)
}
`,
    },
  ];
}

function springPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

function ktorMethod(m: string) {
  return m.toLowerCase();
}

function handlerName(e: import("./types").Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p)));
  return e.method.toLowerCase() + parts.join("");
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

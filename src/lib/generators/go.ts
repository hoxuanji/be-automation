import type { Endpoint, GeneratedFile, StackConfig } from "./types";
import { safeName } from "./types";

export function goFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const module = `github.com/your-org/${safeName(config.name)}`;
  const files: GeneratedFile[] = [];

  files.push({ path: "go.mod", content: goMod(module, config.framework) });
  files.push({ path: "Dockerfile", content: goDockerfile() });
  files.push({
    path: "cmd/api/main.go",
    content: goMain(module),
  });
  files.push({
    path: "internal/config/config.go",
    content: goConfig(),
  });
  files.push({
    path: "internal/server/server.go",
    content: goServer(module, config, endpoints),
  });
  files.push({
    path: "internal/server/middleware.go",
    content: goMiddleware(config),
  });
  files.push({
    path: "internal/server/health.go",
    content: goHealth(config.framework),
  });

  if (/postgres|neon|supabase|cockroach|planetscale/.test(config.database) || config.database === "mysql") {
    files.push({
      path: "internal/db/sql.go",
      content: goSQLDB(config.database),
    });
  }
  if (config.cache === "redis" || config.cache === "upstash" || config.cache === "dragonfly") {
    files.push({ path: "internal/cache/redis.go", content: goRedis() });
  }

  return files;
}

function goMod(module: string, framework: string) {
  const frameworkDep: Record<string, string> = {
    gin: "\tgithub.com/gin-gonic/gin v1.10.0",
    fiber: "\tgithub.com/gofiber/fiber/v2 v2.52.0",
    echo: "\tgithub.com/labstack/echo/v4 v4.12.0",
    chi: "\tgithub.com/go-chi/chi/v5 v5.1.0",
  };
  return `module ${module}

go 1.23

require (
${frameworkDep[framework] ?? frameworkDep.gin}
\tgithub.com/caarlos0/env/v11 v11.2.2
)
`;
}

function goDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/api /api
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/api"]
`;
}

function goMain(module: string) {
  return `package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"${module}/internal/config"
	"${module}/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config", "err", err)
		os.Exit(1)
	}

	srv := server.New(cfg, logger)

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go func() {
		if err := srv.Run(); err != nil {
			logger.Error("serve", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}
`;
}

function goConfig() {
  return `package config

import env "github.com/caarlos0/env/v11"

type Config struct {
	AppName  string \`env:"APP_NAME" envDefault:"app"\`
	Port     string \`env:"PORT" envDefault:"8080"\`
	LogLevel string \`env:"LOG_LEVEL" envDefault:"info"\`

	DatabaseURL string \`env:"DATABASE_URL"\`
	RedisURL    string \`env:"REDIS_URL"\`
	JWTSecret   string \`env:"JWT_SECRET"\`
}

func Load() (*Config, error) {
	c := &Config{}
	if err := env.Parse(c); err != nil {
		return nil, err
	}
	return c, nil
}
`;
}

function goServer(module: string, config: StackConfig, endpoints: Endpoint[]) {
  const importDB = /postgres|mysql|neon|supabase|cockroach|planetscale/.test(
    config.database
  )
    ? `\t"${module}/internal/db"\n`
    : "";
  const importCache = /redis|upstash|dragonfly/.test(config.cache)
    ? `\t"${module}/internal/cache"\n`
    : "";

  if (config.framework === "gin") return ginServer(module, config, endpoints, importDB, importCache);
  if (config.framework === "fiber") return fiberServer(module, config, endpoints, importDB, importCache);
  if (config.framework === "echo") return echoServer(module, config, endpoints, importDB, importCache);
  return chiServer(module, config, endpoints, importDB, importCache);
}

function ginServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  importDB: string,
  importCache: string
) {
  const routes = endpoints
    .map(
      (e) =>
        `\tr.${e.method}("${goPath(e.path)}", ${e.auth ? "authRequired, " : ""}handle${handlerName(e)})`
    )
    .join("\n");
  const handlers = endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c *gin.Context) {
\tc.JSON(200, gin.H{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  return `package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"${module}/internal/config"
${importDB}${importCache})

type Server struct {
	cfg    *config.Config
	log    *slog.Logger
	srv    *http.Server
	engine *gin.Engine
}

func New(cfg *config.Config, log *slog.Logger) *Server {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

	r.GET("/health", healthHandler)
${routes}

	return &Server{cfg: cfg, log: log, engine: r, srv: &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}}
}

func (s *Server) Run() error {
	s.log.Info("listening", "addr", s.srv.Addr)
	return s.srv.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }

${handlers}
`;
}

function fiberServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  importDB: string,
  importCache: string
) {
  const routes = endpoints
    .map(
      (e) =>
        `\tapp.${fiberMethod(e.method)}("${goPath(e.path)}", ${e.auth ? "authRequired, " : ""}handle${handlerName(e)})`
    )
    .join("\n");
  const handlers = endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c *fiber.Ctx) error {
\treturn c.JSON(fiber.Map{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  return `package server

import (
	"context"
	"log/slog"

	"github.com/gofiber/fiber/v2"

	"${module}/internal/config"
${importDB}${importCache})

type Server struct {
	cfg *config.Config
	log *slog.Logger
	app *fiber.App
}

func New(cfg *config.Config, log *slog.Logger) *Server {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

	app.Get("/health", healthHandler)
${routes}

	return &Server{cfg: cfg, log: log, app: app}
}

func (s *Server) Run() error { return s.app.Listen(":" + s.cfg.Port) }
func (s *Server) Shutdown(ctx context.Context) error { return s.app.ShutdownWithContext(ctx) }

${handlers}
`;
}

function echoServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  importDB: string,
  importCache: string
) {
  const routes = endpoints
    .map(
      (e) =>
        `\te.${e.method}("${goPath(e.path)}", handle${handlerName(e)}${e.auth ? ", authRequired" : ""})`
    )
    .join("\n");
  const handlers = endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c echo.Context) error {
\treturn c.JSON(200, map[string]any{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  return `package server

import (
	"context"
	"log/slog"

	"github.com/labstack/echo/v4"

	"${module}/internal/config"
${importDB}${importCache})

type Server struct {
	cfg *config.Config
	log *slog.Logger
	e   *echo.Echo
}

func New(cfg *config.Config, log *slog.Logger) *Server {
	e := echo.New()
	e.HideBanner = true
	e.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

	e.GET("/health", healthHandler)
${routes}

	return &Server{cfg: cfg, log: log, e: e}
}

func (s *Server) Run() error { return s.e.Start(":" + s.cfg.Port) }
func (s *Server) Shutdown(ctx context.Context) error { return s.e.Shutdown(ctx) }

${handlers}
`;
}

function chiServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  importDB: string,
  importCache: string
) {
  const routes = endpoints
    .map(
      (e) =>
        `\tr.Method("${e.method}", "${goPath(e.path)}", http.HandlerFunc(handle${handlerName(e)}))`
    )
    .join("\n");
  const handlers = endpoints
    .map(
      (e) => `func handle${handlerName(e)}(w http.ResponseWriter, r *http.Request) {
\twriteJSON(w, 200, map[string]any{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  return `package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"${module}/internal/config"
${importDB}${importCache})

type Server struct {
	cfg *config.Config
	log *slog.Logger
	srv *http.Server
}

func New(cfg *config.Config, log *slog.Logger) *Server {
	r := chi.NewRouter()
	r.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

	r.Get("/health", healthHandler)
${routes}

	return &Server{cfg: cfg, log: log, srv: &http.Server{Addr: ":" + cfg.Port, Handler: r}}
}

func (s *Server) Run() error { return s.srv.ListenAndServe() }
func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

${handlers}
`;
}

function goMiddleware(config: StackConfig) {
  const fw = config.framework;
  if (fw === "gin") {
    return `package server

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

func recoverer(log *slog.Logger) gin.HandlerFunc {
	return gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, err any) {
		log.Error("panic", "err", err)
		c.AbortWithStatus(500)
	})
}

func requestLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		log.Info("req", "m", c.Request.Method, "p", c.Request.URL.Path, "s", c.Writer.Status(), "d", time.Since(start))
	}
}

${config.rateLimit ? `func rateLimit() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } } // TODO: implement using redis
` : ""}${config.tracing ? `func tracing() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } } // TODO: wire otel
` : ""}func authRequired(c *gin.Context) {
	token := c.GetHeader("Authorization")
	if token == "" { c.AbortWithStatus(401); return }
	// TODO: verify JWT using cfg.JWTSecret
	c.Next()
}
`;
  }
  if (fw === "fiber") {
    return `package server

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
)

func recoverer(log *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic", "err", r)
				_ = c.SendStatus(500)
			}
		}()
		return c.Next()
	}
}

func requestLog(log *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		log.Info("req", "m", c.Method(), "p", c.Path(), "s", c.Response().StatusCode(), "d", time.Since(start))
		return err
	}
}

${config.rateLimit ? "func rateLimit() fiber.Handler { return func(c *fiber.Ctx) error { return c.Next() } }\n" : ""}${config.tracing ? "func tracing() fiber.Handler { return func(c *fiber.Ctx) error { return c.Next() } }\n" : ""}func authRequired(c *fiber.Ctx) error {
	if c.Get("Authorization") == "" { return c.SendStatus(401) }
	return c.Next()
}
`;
  }
  if (fw === "echo") {
    return `package server

import (
	"log/slog"
	"time"

	"github.com/labstack/echo/v4"
)

func recoverer(log *slog.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) (err error) {
			defer func() {
				if r := recover(); r != nil {
					log.Error("panic", "err", r)
					err = c.NoContent(500)
				}
			}()
			return next(c)
		}
	}
}

func requestLog(log *slog.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			err := next(c)
			log.Info("req", "m", c.Request().Method, "p", c.Path(), "s", c.Response().Status, "d", time.Since(start))
			return err
		}
	}
}

${config.rateLimit ? "func rateLimit() echo.MiddlewareFunc { return func(next echo.HandlerFunc) echo.HandlerFunc { return next } }\n" : ""}${config.tracing ? "func tracing() echo.MiddlewareFunc { return func(next echo.HandlerFunc) echo.HandlerFunc { return next } }\n" : ""}func authRequired(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if c.Request().Header.Get("Authorization") == "" {
			return c.NoContent(401)
		}
		return next(c)
	}
}
`;
  }
  // chi
  return `package server

import (
	"log/slog"
	"net/http"
	"time"
)

func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("panic", "err", rec)
					w.WriteHeader(500)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func requestLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			next.ServeHTTP(w, r)
			log.Info("req", "m", r.Method, "p", r.URL.Path, "d", time.Since(start))
		})
	}
}

${config.rateLimit ? "func rateLimit() func(http.Handler) http.Handler { return func(next http.Handler) http.Handler { return next } }\n" : ""}${config.tracing ? "func tracing() func(http.Handler) http.Handler { return func(next http.Handler) http.Handler { return next } }\n" : ""}func authRequired(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" { w.WriteHeader(401); return }
		next.ServeHTTP(w, r)
	})
}
`;
}

function goHealth(framework: string) {
  if (framework === "gin") {
    return `package server

import "github.com/gin-gonic/gin"

func healthHandler(c *gin.Context) {
	c.JSON(200, gin.H{"ok": true})
}
`;
  }
  if (framework === "fiber") {
    return `package server

import "github.com/gofiber/fiber/v2"

func healthHandler(c *fiber.Ctx) error { return c.JSON(fiber.Map{"ok": true}) }
`;
  }
  if (framework === "echo") {
    return `package server

import "github.com/labstack/echo/v4"

func healthHandler(c echo.Context) error { return c.JSON(200, map[string]any{"ok": true}) }
`;
  }
  return `package server

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) }
`;
}

function goSQLDB(db: string) {
  return `package db

import (
	"context"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"database/sql"
)

func Open(dsn string) (*sql.DB, error) {
	// db: ${db}
	conn, err := sql.Open("pgx", dsn)
	if err != nil { return nil, err }
	conn.SetMaxOpenConns(25)
	conn.SetMaxIdleConns(10)
	conn.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.PingContext(ctx); err != nil { return nil, err }
	return conn, nil
}
`;
}

function goRedis() {
  return `package cache

import (
	"context"

	"github.com/redis/go-redis/v9"
)

func Open(url string) (*redis.Client, error) {
	opt, err := redis.ParseURL(url)
	if err != nil { return nil, err }
	c := redis.NewClient(opt)
	if err := c.Ping(context.Background()).Err(); err != nil { return nil, err }
	return c, nil
}
`;
}

function goPath(p: string) {
  return p.replace(/:([a-zA-Z0-9_]+)/g, ":$1");
}

function fiberMethod(m: string) {
  return m[0] + m.slice(1).toLowerCase();
}

function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "By" + cap(p.slice(1)) : cap(p)));
  return cap(e.method.toLowerCase()) + parts.join("");
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1).replace(/[^a-zA-Z0-9]/g, "") : "";
}

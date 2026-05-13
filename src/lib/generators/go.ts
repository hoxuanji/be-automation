import type { Endpoint, Entity, FieldType, GeneratedFile, StackConfig } from "./types";
import { safeName, toPascal, toKebab, toSnake } from "./types";
import { goGrpcFiles } from "./grpc/go";
import { needsAuth } from "./auth/providers";
import { goApiHandlersFile, goHandlerMethodName } from "./patterns/go";

export function goFiles(
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[] = []
): GeneratedFile[] {
  // gRPC mode swaps the HTTP framework bootstrap for a pure gRPC server.
  // Keep the Dockerfile + shared helpers; replace the cmd / internal/server
  // output with the gRPC tree.
  if (config.api === "grpc") {
    const files: GeneratedFile[] = [];
    files.push({ path: "Dockerfile", content: goDockerfile() });
    files.push({ path: "internal/config/config.go", content: goConfig() });
    files.push(...goGrpcFiles(config, entities));
    return files;
  }

  const module = `github.com/your-username/${safeName(config.name)}`;
  const files: GeneratedFile[] = [];
  const anyProtected = endpoints.some((e) => e.auth);
  const withAuth = needsAuth(config, anyProtected);
  const hasPatterns = endpoints.some((e) => e.pattern);
  const patternSet = new Set(endpoints.map((e) => e.pattern).filter(Boolean) as string[]);
  const withPatternAuth = [...patternSet].some((p) => p.startsWith("auth_"));
  const withPatternDb = [...patternSet].some((p) =>
    p.startsWith("crud_") || p === "paginated_search" || p === "aggregate_stats" || p === "cache_read"
  );
  const needsGorm = entities.length > 0 || withPatternDb;

  files.push({ path: "go.mod", content: goMod(module, config.framework, needsGorm, withAuth, withPatternAuth) });
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
    content: goServer(module, config, endpoints, entities),
  });
  files.push({
    path: "internal/server/middleware.go",
    content: goMiddleware(config, module, withAuth),
  });
  files.push({
    path: "internal/server/health.go",
    content: goHealth(config.framework),
  });

  if (withAuth) {
    files.push({
      path: "internal/auth/jwt.go",
      content: goAuthJwt(),
    });
  }

  if (/postgres|neon|supabase|cockroach|planetscale/.test(config.database) || config.database === "mysql") {
    files.push({
      path: "internal/db/sql.go",
      content: goSQLDB(config.database),
    });
  }

  // Generate GORM adapter whenever entities or DB patterns require it
  if (needsGorm && !(/sqlite/.test(config.database) && entities.length === 0)) {
    if (!files.some((f) => f.path === "internal/db/gorm.go")) {
      files.push({ path: "internal/db/gorm.go", content: goGormDB(config.database) });
    }
  }

  if (entities.length > 0) {
    if (!files.some((f) => f.path === "internal/models/models.go")) {
      files.push({ path: "internal/models/models.go", content: goModels(module, entities) });
    }
    if (!files.some((f) => f.path === "internal/db/gorm.go")) {
      files.push({ path: "internal/db/gorm.go", content: goGormDB(config.database) });
    }
    for (const entity of entities) {
      files.push({
        path: `internal/handlers/${toSnake(entity.name)}.go`,
        content: goEntityHandler(module, config.framework, entity),
      });
      files.push({
        path: `internal/handlers/${toSnake(entity.name)}_test.go`,
        content: goEntityTest(module, config.framework, entity),
      });
    }
  }

  // Pattern-based API handlers (custom endpoints from API builder)
  if (hasPatterns) {
    files.push(goApiHandlersFile(module, config.framework, config, endpoints, entities));
  }

  if (config.cache === "redis" || config.cache === "upstash" || config.cache === "dragonfly") {
    files.push({ path: "internal/cache/redis.go", content: goRedis() });
  }

  return files;
}

function goEntityHandler(module: string, framework: string, entity: Entity): string {
  const pascal = entity.name;
  const snake = toSnake(entity.name);
  const kebab = toKebab(entity.name);

  if (framework === "gin") {
    return `package handlers

import (
\t"net/http"

\t"github.com/gin-gonic/gin"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c *gin.Context) {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusOK, items)
}

func (h *${pascal}Handler) GetByID(c *gin.Context) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusNotFound, gin.H{"error": "not found"})
\t\treturn
\t}
\tc.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Create(c *gin.Context) {
\tvar payload models.${pascal}
\tif err := c.ShouldBindJSON(&payload); err != nil {
\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusCreated, payload)
}

func (h *${pascal}Handler) Update(c *gin.Context) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusNotFound, gin.H{"error": "not found"})
\t\treturn
\t}
\tvar payload map[string]any
\tif err := c.ShouldBindJSON(&payload); err != nil {
\t\tc.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Delete(c *gin.Context) {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Param("id")).Error; err != nil {
\t\tc.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
\t\treturn
\t}
\tc.Status(http.StatusNoContent)
}
`;
  }

  if (framework === "fiber") {
    return `package handlers

import (
\t"github.com/gofiber/fiber/v2"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c *fiber.Ctx) error {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.JSON(items)
}

func (h *${pascal}Handler) GetByID(c *fiber.Ctx) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(404).JSON(fiber.Map{"error": "not found"})
\t}
\treturn c.JSON(item)
}

func (h *${pascal}Handler) Create(c *fiber.Ctx) error {
\tvar payload models.${pascal}
\tif err := c.BodyParser(&payload); err != nil {
\t\treturn c.Status(400).JSON(fiber.Map{"error": err.Error()})
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.Status(201).JSON(payload)
}

func (h *${pascal}Handler) Update(c *fiber.Ctx) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(404).JSON(fiber.Map{"error": "not found"})
\t}
\tvar payload map[string]any
\tif err := c.BodyParser(&payload); err != nil {
\t\treturn c.Status(400).JSON(fiber.Map{"error": err.Error()})
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.JSON(item)
}

func (h *${pascal}Handler) Delete(c *fiber.Ctx) error {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Params("id")).Error; err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": err.Error()})
\t}
\treturn c.SendStatus(204)
}
`;
  }

  if (framework === "echo") {
    return `package handlers

import (
\t"net/http"

\t"github.com/labstack/echo/v4"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) List(c echo.Context) error {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusOK, items)
}

func (h *${pascal}Handler) GetByID(c echo.Context) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
\t}
\treturn c.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Create(c echo.Context) error {
\tvar payload models.${pascal}
\tif err := c.Bind(&payload); err != nil {
\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusCreated, payload)
}

func (h *${pascal}Handler) Update(c echo.Context) error {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
\t}
\tvar payload map[string]any
\tif err := c.Bind(&payload); err != nil {
\t\treturn c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.JSON(http.StatusOK, item)
}

func (h *${pascal}Handler) Delete(c echo.Context) error {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", c.Param("id")).Error; err != nil {
\t\treturn c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
\t}
\treturn c.NoContent(http.StatusNoContent)
}
`;
  }

  // chi
  return `package handlers

import (
\t"encoding/json"
\t"net/http"

\t"github.com/go-chi/chi/v5"
\t"gorm.io/gorm"

\t"${module}/internal/models"
)

type ${pascal}Handler struct{ db *gorm.DB }

func New${pascal}Handler(db *gorm.DB) *${pascal}Handler { return &${pascal}Handler{db: db} }

func (h *${pascal}Handler) writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}

func (h *${pascal}Handler) List(w http.ResponseWriter, r *http.Request) {
\tvar items []models.${pascal}
\tif err := h.db.Find(&items).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 200, items)
}

func (h *${pascal}Handler) GetByID(w http.ResponseWriter, r *http.Request) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 404, map[string]any{"error": "not found"})
\t\treturn
\t}
\th.writeJSON(w, 200, item)
}

func (h *${pascal}Handler) Create(w http.ResponseWriter, r *http.Request) {
\tvar payload models.${pascal}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\th.writeJSON(w, 400, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Create(&payload).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 201, payload)
}

func (h *${pascal}Handler) Update(w http.ResponseWriter, r *http.Request) {
\tvar item models.${pascal}
\tif err := h.db.First(&item, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 404, map[string]any{"error": "not found"})
\t\treturn
\t}
\tvar payload map[string]any
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\th.writeJSON(w, 400, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tif err := h.db.Model(&item).Updates(payload).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\th.writeJSON(w, 200, item)
}

func (h *${pascal}Handler) Delete(w http.ResponseWriter, r *http.Request) {
\tif err := h.db.Delete(&models.${pascal}{}, "id = ?", chi.URLParam(r, "id")).Error; err != nil {
\t\th.writeJSON(w, 500, map[string]any{"error": err.Error()})
\t\treturn
\t}
\tw.WriteHeader(http.StatusNoContent)
}
`;
  // suppress unused var warning
  void snake; void kebab;
}

function goTestBody(entity: Entity, valueString = "test", valueNum = 1): string {
  const fields = entity.fields.filter(f => !f.primaryKey && f.required);
  if (fields.length === 0) return `map[string]any{"name": "test"}`;
  const pairs = fields.slice(0, 3).map(f => {
    if (f.type === "string" || f.type === "text") return `"${f.name}": "${valueString}"`;
    if (f.type === "number") return `"${f.name}": ${valueNum}`;
    if (f.type === "boolean") return `"${f.name}": true`;
    if (f.type === "uuid") return `"${f.name}": "00000000-0000-0000-0000-000000000001"`;
    return `"${f.name}": "${valueString}"`;
  });
  return `map[string]any{${pairs.join(", ")}}`;
}

function goEntityTest(module: string, framework: string, entity: Entity): string {
  const pascal = entity.name;
  const kebab = toKebab(entity.name);
  const createBody = goTestBody(entity, "test", 1);
  const updateBody = goTestBody(entity, "updated", 2);

  if (framework === "gin") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/gin-gonic/gin"
\t"gorm.io/driver/sqlite"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil { t.Fatal(err) }
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil { t.Fatal(err) }
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tgin.SetMode(gin.TestMode)
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tr := gin.New()
\tr.GET("/${kebab}s", h.List)
\tr.GET("/${kebab}s/:id", h.GetByID)
\tr.POST("/${kebab}s", h.Create)
\tr.PATCH("/${kebab}s/:id", h.Update)
\tr.DELETE("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated { t.Errorf("want 201 got %d: %s", w.Code, w.Body) }
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok { createdID = id }
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d", w.Code) }
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound { t.Errorf("want 404 got %d", w.Code) }
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent { t.Errorf("want 204 got %d", w.Code) }
\t})
}
`;
  }

  if (framework === "fiber") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"io"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/gofiber/fiber/v2"
\t"gorm.io/driver/sqlite"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil { t.Fatal(err) }
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil { t.Fatal(err) }
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tapp := fiber.New()
\tapp.Get("/${kebab}s", h.List)
\tapp.Get("/${kebab}s/:id", h.GetByID)
\tapp.Post("/${kebab}s", h.Create)
\tapp.Patch("/${kebab}s/:id", h.Update)
\tapp.Delete("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s", nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusOK { t.Errorf("want 200 got %d", resp.StatusCode) }
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusCreated { t.Errorf("want 201 got %d", resp.StatusCode) }
\t\trawBody, _ := io.ReadAll(resp.Body)
\t\tvar result map[string]any
\t\t_ = json.Unmarshal(rawBody, &result)
\t\tif id, ok := result["id"].(string); ok { createdID = id }
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusOK { t.Errorf("want 200 got %d", resp.StatusCode) }
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\treq := httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusNotFound { t.Errorf("want 404 got %d", resp.StatusCode) }
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusOK { t.Errorf("want 200 got %d", resp.StatusCode) }
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\treq := httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil)
\t\tresp, err := app.Test(req)
\t\tif err != nil { t.Fatal(err) }
\t\tif resp.StatusCode != http.StatusNoContent { t.Errorf("want 204 got %d", resp.StatusCode) }
\t})
}
`;
  }

  if (framework === "echo") {
    return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/labstack/echo/v4"
\t"gorm.io/driver/sqlite"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil { t.Fatal(err) }
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil { t.Fatal(err) }
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\te := echo.New()
\te.GET("/${kebab}s", h.List)
\te.GET("/${kebab}s/:id", h.GetByID)
\te.POST("/${kebab}s", h.Create)
\te.PATCH("/${kebab}s/:id", h.Update)
\te.DELETE("/${kebab}s/:id", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated { t.Errorf("want 201 got %d: %s", w.Code, w.Body) }
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok { createdID = id }
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d", w.Code) }
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound { t.Errorf("want 404 got %d", w.Code) }
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\te.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent { t.Errorf("want 204 got %d", w.Code) }
\t})
}
`;
  }

  // chi
  return `package handlers_test

import (
\t"bytes"
\t"encoding/json"
\t"net/http"
\t"net/http/httptest"
\t"testing"

\t"github.com/go-chi/chi/v5"
\t"gorm.io/driver/sqlite"
\t"gorm.io/gorm"

\t"${module}/internal/handlers"
\t"${module}/internal/models"
)

func setup${pascal}DB(t *testing.T) *gorm.DB {
\tt.Helper()
\tdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
\tif err != nil { t.Fatal(err) }
\tif err := db.AutoMigrate(&models.${pascal}{}); err != nil { t.Fatal(err) }
\treturn db
}

func Test${pascal}Handler(t *testing.T) {
\tdb := setup${pascal}DB(t)
\th := handlers.New${pascal}Handler(db)

\tr := chi.NewRouter()
\tr.Get("/${kebab}s", h.List)
\tr.Get("/${kebab}s/{id}", h.GetByID)
\tr.Post("/${kebab}s", h.Create)
\tr.Patch("/${kebab}s/{id}", h.Update)
\tr.Delete("/${kebab}s/{id}", h.Delete)

\tvar createdID string

\tt.Run("list empty", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s", nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("create", func(t *testing.T) {
\t\tbody, _ := json.Marshal(${createBody})
\t\treq := httptest.NewRequest(http.MethodPost, "/${kebab}s", bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusCreated { t.Errorf("want 201 got %d: %s", w.Code, w.Body) }
\t\tvar resp map[string]any
\t\t_ = json.Unmarshal(w.Body.Bytes(), &resp)
\t\tif id, ok := resp["id"].(string); ok { createdID = id }
\t})

\tt.Run("get by id", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d", w.Code) }
\t})

\tt.Run("get not found", func(t *testing.T) {
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/${kebab}s/00000000-0000-0000-0000-000000000000", nil))
\t\tif w.Code != http.StatusNotFound { t.Errorf("want 404 got %d", w.Code) }
\t})

\tt.Run("update", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tbody, _ := json.Marshal(${updateBody})
\t\treq := httptest.NewRequest(http.MethodPatch, "/${kebab}s/"+createdID, bytes.NewReader(body))
\t\treq.Header.Set("Content-Type", "application/json")
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, req)
\t\tif w.Code != http.StatusOK { t.Errorf("want 200 got %d: %s", w.Code, w.Body) }
\t})

\tt.Run("delete", func(t *testing.T) {
\t\tif createdID == "" { t.Skip("depends on create") }
\t\tw := httptest.NewRecorder()
\t\tr.ServeHTTP(w, httptest.NewRequest(http.MethodDelete, "/${kebab}s/"+createdID, nil))
\t\tif w.Code != http.StatusNoContent { t.Errorf("want 204 got %d", w.Code) }
\t})
}
`;
}

function goGormDB(database: string): string {
  const isSQLite = database === "sqlite";
  if (isSQLite) {
    return `package db

import (
\t"gorm.io/driver/sqlite"
\t"gorm.io/gorm"
)

func OpenGorm(dsn string) (*gorm.DB, error) {
\tif dsn == "" {
\t\tdsn = "app.db"
\t}
\treturn gorm.Open(sqlite.Open(dsn), &gorm.Config{})
}
`;
  }
  return `package db

import (
\t"time"

\tgormPg "gorm.io/driver/postgres"
\t"gorm.io/gorm"
)

func OpenGorm(dsn string) (*gorm.DB, error) {
\t// GORM wraps the underlying *sql.DB; configure the pool explicitly rather
\t// than relying on GORM's defaults (no pool configuration at all).
\tdb, err := gorm.Open(gormPg.Open(dsn), &gorm.Config{})
\tif err != nil {
\t\treturn nil, err
\t}
\tsqlDB, err := db.DB()
\tif err != nil {
\t\treturn nil, err
\t}
\tsqlDB.SetMaxOpenConns(25)
\tsqlDB.SetMaxIdleConns(10)
\tsqlDB.SetConnMaxLifetime(30 * time.Minute)
\treturn db, nil
}
`;
}

function goModels(module: string, entities: Entity[]): string {
  const needsTime = entities.some((e) =>
    e.fields.some((f) => f.type === "date" || f.name === "createdAt" || f.name === "updatedAt")
  );
  const needsJSON = entities.some((e) => e.fields.some((f) => f.type === "json"));

  const imports = [
    needsTime ? `\t"time"` : "",
    needsJSON ? `\t"gorm.io/datatypes"` : "",
    `\t"gorm.io/gorm"`,
  ]
    .filter(Boolean)
    .join("\n");

  const structs = entities
    .map((e) => {
      const fields = e.fields.map((f) => {
        const goType = goFieldType(f.type);
        const tags = buildGORMTags(f);
        return `\t${toPascal(f.name)} ${goType} \`${tags}\``;
      });
      if (!e.fields.some((f) => f.name === "createdAt"))
        fields.push("\tCreatedAt time.Time");
      if (!e.fields.some((f) => f.name === "updatedAt"))
        fields.push("\tUpdatedAt time.Time");
      if (!e.fields.some((f) => f.name === "deletedAt"))
        fields.push("\tDeletedAt gorm.DeletedAt `gorm:\"index\"`");
      return `type ${e.name} struct {\n${fields.join("\n")}\n}`;
    })
    .join("\n\n");

  return `// Auto-generated by Helios — edit freely
package models

import (
${imports}
)

${structs}
`;
}

function goFieldType(t: FieldType): string {
  switch (t) {
    case "uuid":    return "string";
    case "string":  return "string";
    case "text":    return "string";
    case "number":  return "int64";
    case "boolean": return "bool";
    case "date":    return "time.Time";
    case "json":    return "datatypes.JSON";
  }
}

function buildGORMTags(f: { type: FieldType; primaryKey?: boolean; unique: boolean; required: boolean }): string {
  const tags: string[] = [];
  if (f.primaryKey) {
    tags.push(
      f.type === "uuid"
        ? 'gorm:"type:uuid;primaryKey;default:gen_random_uuid()"'
        : 'gorm:"primaryKey"'
    );
  } else {
    const parts: string[] = [];
    if (f.type === "text") parts.push("type:text");
    if (f.type === "json") parts.push("type:jsonb");
    if (f.unique) parts.push("uniqueIndex");
    if (f.required) parts.push("not null");
    if (parts.length) tags.push(`gorm:"${parts.join(";")}"`)
    else tags.push(`gorm:""`);
  }
  return tags.join(" ");
}

function goMod(module: string, framework: string, withEntities = false, withAuth = false, withPatternAuth = false) {
  const frameworkDep: Record<string, string> = {
    gin: "\tgithub.com/gin-gonic/gin v1.10.0",
    fiber: "\tgithub.com/gofiber/fiber/v2 v2.52.0",
    echo: "\tgithub.com/labstack/echo/v4 v4.12.0",
    chi: "\tgithub.com/go-chi/chi/v5 v5.1.0",
  };
  const gormDeps = withEntities
    ? "\tgorm.io/gorm v1.25.12\n\tgorm.io/driver/postgres v1.5.11\n\tgorm.io/driver/sqlite v1.5.5\n\tgithub.com/golang-migrate/migrate/v4 v4.18.1"
    : "";
  const authDeps = withAuth
    // jwx is the canonical Go JWT/JWK library — handles JWKS fetch + cache,
    // RS256/ES256 verification, and claim validation without hand-rolling
    // PEM parsing.
    ? "\tgithub.com/lestrrat-go/jwx/v2 v2.1.1"
    : "";
  // Pattern auth handlers need bcrypt for password hashing and jwt/v5 for signing
  const patternAuthDeps = withPatternAuth
    ? "\tgithub.com/golang-jwt/jwt/v5 v5.2.1\n\tgolang.org/x/crypto v0.27.0\n\tgithub.com/google/uuid v1.6.0\n\tgithub.com/redis/go-redis/v9 v9.7.0"
    : "";
  const allDeps = [gormDeps, authDeps, patternAuthDeps].filter(Boolean).join("\n");
  return `module ${module}

go 1.23

require (
${frameworkDep[framework] ?? frameworkDep.gin}
\tgithub.com/caarlos0/env/v11 v11.2.2
${allDeps}
)
`;
}

function goDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOFLAGS=-mod=mod go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

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
\t"context"
\t"log/slog"
\t"os"
\t"os/signal"
\t"syscall"
\t"time"

\t"${module}/internal/config"
\t"${module}/internal/server"
)

func main() {
\tlogger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
\tslog.SetDefault(logger)

\tcfg, err := config.Load()
\tif err != nil {
\t\tlogger.Error("config", "err", err)
\t\tos.Exit(1)
\t}

\tsrv := server.New(cfg, logger)

\tctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
\tdefer cancel()

\tgo func() {
\t\tif err := srv.Run(); err != nil {
\t\t\tlogger.Error("serve", "err", err)
\t\t\tos.Exit(1)
\t\t}
\t}()

\t<-ctx.Done()
\tlogger.Info("shutting down")
\tshutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
\tdefer cancel()
\t_ = srv.Shutdown(shutdown)
}
`;
}

function goConfig() {
  return `package config

import env "github.com/caarlos0/env/v11"

type Config struct {
\tAppName  string \`env:"APP_NAME" envDefault:"app"\`
\tPort     string \`env:"PORT" envDefault:"8080"\`
\tLogLevel string \`env:"LOG_LEVEL" envDefault:"info"\`

\tDatabaseURL string \`env:"DATABASE_URL"\`
\tRedisURL    string \`env:"REDIS_URL"\`
\tJWTSecret   string \`env:"JWT_SECRET"\`
}

func Load() (*Config, error) {
\tc := &Config{}
\tif err := env.Parse(c); err != nil {
\t\treturn nil, err
\t}
\treturn c, nil
}
`;
}

function goServer(module: string, config: StackConfig, endpoints: Endpoint[], entities: Entity[]) {
  const importDB = /postgres|mysql|neon|supabase|cockroach|planetscale/.test(config.database)
    ? `\t"${module}/internal/db"\n`
    : "";
  const importCache = /redis|upstash|dragonfly/.test(config.cache)
    ? `\t"${module}/internal/cache"\n`
    : "";
  const importHandlers = (entities.length > 0 || endpoints.some((e) => e.pattern))
    ? `\t"${module}/internal/handlers"\n`
    : "";

  if (config.framework === "gin") return ginServer(module, config, endpoints, entities, importDB, importCache, importHandlers);
  if (config.framework === "fiber") return fiberServer(module, config, endpoints, entities, importDB, importCache, importHandlers);
  if (config.framework === "echo") return echoServer(module, config, endpoints, entities, importDB, importCache, importHandlers);
  return chiServer(module, config, endpoints, entities, importDB, importCache, importHandlers);
}

function entityRoutes(framework: string, entities: Entity[]): { setup: string; routes: string } {
  if (entities.length === 0) return { setup: "", routes: "" };

  if (framework === "gin") {
    const setup = entities
      .map((e) => `\t${toCamelLocal(e.name)}H := handlers.New${e.name}Handler(gormDB)`)
      .join("\n");
    const routes = entities
      .map((e) => {
        const kb = toKebab(e.name);
        return [
          `\tr.GET("/${kb}s", ${toCamelLocal(e.name)}H.List)`,
          `\tr.GET("/${kb}s/:id", ${toCamelLocal(e.name)}H.GetByID)`,
          `\tr.POST("/${kb}s", ${toCamelLocal(e.name)}H.Create)`,
          `\tr.PATCH("/${kb}s/:id", ${toCamelLocal(e.name)}H.Update)`,
          `\tr.DELETE("/${kb}s/:id", ${toCamelLocal(e.name)}H.Delete)`,
        ].join("\n");
      })
      .join("\n");
    return { setup, routes };
  }

  if (framework === "fiber") {
    const setup = entities
      .map((e) => `\t${toCamelLocal(e.name)}H := handlers.New${e.name}Handler(gormDB)`)
      .join("\n");
    const routes = entities
      .map((e) => {
        const kb = toKebab(e.name);
        return [
          `\tapp.Get("/${kb}s", ${toCamelLocal(e.name)}H.List)`,
          `\tapp.Get("/${kb}s/:id", ${toCamelLocal(e.name)}H.GetByID)`,
          `\tapp.Post("/${kb}s", ${toCamelLocal(e.name)}H.Create)`,
          `\tapp.Patch("/${kb}s/:id", ${toCamelLocal(e.name)}H.Update)`,
          `\tapp.Delete("/${kb}s/:id", ${toCamelLocal(e.name)}H.Delete)`,
        ].join("\n");
      })
      .join("\n");
    return { setup, routes };
  }

  if (framework === "echo") {
    const setup = entities
      .map((e) => `\t${toCamelLocal(e.name)}H := handlers.New${e.name}Handler(gormDB)`)
      .join("\n");
    const routes = entities
      .map((e) => {
        const kb = toKebab(e.name);
        return [
          `\te.GET("/${kb}s", ${toCamelLocal(e.name)}H.List)`,
          `\te.GET("/${kb}s/:id", ${toCamelLocal(e.name)}H.GetByID)`,
          `\te.POST("/${kb}s", ${toCamelLocal(e.name)}H.Create)`,
          `\te.PATCH("/${kb}s/:id", ${toCamelLocal(e.name)}H.Update)`,
          `\te.DELETE("/${kb}s/:id", ${toCamelLocal(e.name)}H.Delete)`,
        ].join("\n");
      })
      .join("\n");
    return { setup, routes };
  }

  // chi
  const setup = entities
    .map((e) => `\t${toCamelLocal(e.name)}H := handlers.New${e.name}Handler(gormDB)`)
    .join("\n");
  const routes = entities
    .map((e) => {
      const kb = toKebab(e.name);
      return [
        `\tr.Get("/${kb}s", ${toCamelLocal(e.name)}H.List)`,
        `\tr.Get("/${kb}s/{id}", ${toCamelLocal(e.name)}H.GetByID)`,
        `\tr.Post("/${kb}s", ${toCamelLocal(e.name)}H.Create)`,
        `\tr.Patch("/${kb}s/{id}", ${toCamelLocal(e.name)}H.Update)`,
        `\tr.Delete("/${kb}s/{id}", ${toCamelLocal(e.name)}H.Delete)`,
      ].join("\n");
    })
    .join("\n");
  return { setup, routes };
}

function toCamelLocal(name: string): string {
  const s = name;
  return s ? s[0].toLowerCase() + s.slice(1) : "";
}

function gormOpenBlock(database: string): string {
  if (!(/postgres|mysql|neon|supabase|cockroach|planetscale/.test(database) || database === "sqlite" || database === "mysql")) {
    return "";
  }
  return `\tgormDB, err := db.OpenGorm(cfg.DatabaseURL)
\tif err != nil {
\t\tlog.Error("gorm open", "err", err)
\t\tos.Exit(1)
\t}
`;
}

function ginServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[],
  importDB: string,
  importCache: string,
  importHandlers: string
) {
  const hasPatterns = endpoints.some((e) => e.pattern);
  const routes = endpoints
    .map((e) => {
      const hname = hasPatterns
        ? `apiH.${goHandlerMethodName(e)}`
        : `handle${handlerName(e)}`;
      return `\tr.${e.method}("${goPath(e.path)}", ${e.auth ? "authRequired, " : ""}${hname})`;
    })
    .join("\n");
  const inlineHandlers = hasPatterns ? "" : endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c *gin.Context) {
\tc.JSON(200, gin.H{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  const apiHSetup = hasPatterns ? `\tapiH := handlers.NewAPIHandlers(log)\n` : "";

  const { setup: entitySetup, routes: entityRouteLines } = entityRoutes("gin", entities);
  const gormBlock = entities.length > 0 ? gormOpenBlock(config.database) : "";
  const needsOS = entities.length > 0;

  return `package server

import (
\t"context"
\t"log/slog"
\t"net/http"
${needsOS ? '\t"os"\n' : ""}
\t"github.com/gin-gonic/gin"

\t"${module}/internal/config"
${importDB}${importCache}${importHandlers})

type Server struct {
\tcfg    *config.Config
\tlog    *slog.Logger
\tsrv    *http.Server
\tengine *gin.Engine
}

func New(cfg *config.Config, log *slog.Logger) *Server {
\tgin.SetMode(gin.ReleaseMode)
\tr := gin.New()
\tr.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

${apiHSetup}\tr.GET("/health", healthHandler)
${routes}
${gormBlock}${entitySetup}
${entityRouteLines}

\treturn &Server{cfg: cfg, log: log, engine: r, srv: &http.Server{
\t\tAddr:    ":" + cfg.Port,
\t\tHandler: r,
\t}}
}

func (s *Server) Run() error {
\ts.log.Info("listening", "addr", s.srv.Addr)
\treturn s.srv.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }
func (s *Server) Handler() http.Handler     { return s.engine }

${inlineHandlers}
`;
}

function fiberServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[],
  importDB: string,
  importCache: string,
  importHandlers: string
) {
  const hasPatternsF = endpoints.some((e) => e.pattern);
  const routesF = endpoints
    .map((e) => {
      const hname = hasPatternsF
        ? `apiH.${goHandlerMethodName(e)}`
        : `handle${handlerName(e)}`;
      return `\tapp.${fiberMethod(e.method)}("${goPath(e.path)}", ${e.auth ? "authRequired, " : ""}${hname})`;
    })
    .join("\n");
  const inlineHandlersF = hasPatternsF ? "" : endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c *fiber.Ctx) error {
\treturn c.JSON(fiber.Map{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  const apiHSetupF = hasPatternsF ? `\tapiH := handlers.NewAPIHandlers(log)\n` : "";

  const { setup: entitySetup, routes: entityRouteLines } = entityRoutes("fiber", entities);
  const gormBlock = entities.length > 0 ? gormOpenBlock(config.database) : "";
  const needsOS = entities.length > 0;

  return `package server

import (
\t"context"
\t"log/slog"
${needsOS ? '\t"os"\n' : ""}
\t"github.com/gofiber/fiber/v2"

\t"${module}/internal/config"
${importDB}${importCache}${importHandlers})

type Server struct {
\tcfg *config.Config
\tlog *slog.Logger
\tapp *fiber.App
}

func New(cfg *config.Config, log *slog.Logger) *Server {
\tapp := fiber.New(fiber.Config{DisableStartupMessage: true})
\tapp.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

${apiHSetupF}\tapp.Get("/health", healthHandler)
${routesF}
${gormBlock}${entitySetup}
${entityRouteLines}

\treturn &Server{cfg: cfg, log: log, app: app}
}

func (s *Server) Run() error { return s.app.Listen(":" + s.cfg.Port) }
func (s *Server) Shutdown(ctx context.Context) error { return s.app.ShutdownWithContext(ctx) }
func (s *Server) App() *fiber.App { return s.app }

${inlineHandlersF}
`;
}

function echoServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[],
  importDB: string,
  importCache: string,
  importHandlers: string
) {
  const hasPatternsE = endpoints.some((e) => e.pattern);
  const routesE = endpoints
    .map((e) => {
      const hname = hasPatternsE
        ? `apiH.${goHandlerMethodName(e)}`
        : `handle${handlerName(e)}`;
      return `\te.${e.method}("${goPath(e.path)}", ${hname}${e.auth ? ", authRequired" : ""})`;
    })
    .join("\n");
  const inlineHandlersE = hasPatternsE ? "" : endpoints
    .map(
      (e) => `func handle${handlerName(e)}(c echo.Context) error {
\treturn c.JSON(200, map[string]any{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  const apiHSetupE = hasPatternsE ? `\tapiH := handlers.NewAPIHandlers(log)\n` : "";

  const { setup: entitySetup, routes: entityRouteLines } = entityRoutes("echo", entities);
  const gormBlock = entities.length > 0 ? gormOpenBlock(config.database) : "";
  const needsOS = entities.length > 0;

  return `package server

import (
\t"context"
\t"log/slog"
\t"net/http"
${needsOS ? '\t"os"\n' : ""}
\t"github.com/labstack/echo/v4"

\t"${module}/internal/config"
${importDB}${importCache}${importHandlers})

type Server struct {
\tcfg *config.Config
\tlog *slog.Logger
\te   *echo.Echo
}

func New(cfg *config.Config, log *slog.Logger) *Server {
\te := echo.New()
\te.HideBanner = true
\te.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

${apiHSetupE}\te.GET("/health", healthHandler)
${routesE}
${gormBlock}${entitySetup}
${entityRouteLines}

\treturn &Server{cfg: cfg, log: log, e: e}
}

func (s *Server) Run() error { return s.e.Start(":" + s.cfg.Port) }
func (s *Server) Shutdown(ctx context.Context) error { return s.e.Shutdown(ctx) }
func (s *Server) Handler() http.Handler { return s.e }

${inlineHandlersE}
`;
}

function chiServer(
  module: string,
  config: StackConfig,
  endpoints: Endpoint[],
  entities: Entity[],
  importDB: string,
  importCache: string,
  importHandlers: string
) {
  const hasPatternsC = endpoints.some((e) => e.pattern);
  const routesC = endpoints
    .map((e) => {
      const hname = hasPatternsC
        ? `apiH.${goHandlerMethodName(e)}`
        : `handle${handlerName(e)}`;
      return `\tr.Method("${e.method}", "${goPath(e.path)}", http.HandlerFunc(${hname}))`;
    })
    .join("\n");
  const inlineHandlersC = hasPatternsC ? "" : endpoints
    .map(
      (e) => `func handle${handlerName(e)}(w http.ResponseWriter, r *http.Request) {
\twriteJSON(w, 200, map[string]any{"ok": true, "op": "${e.method} ${e.path}"})
}`
    )
    .join("\n\n");
  const apiHSetupC = hasPatternsC ? `\tapiH := handlers.NewAPIHandlers(log)\n` : "";

  const { setup: entitySetup, routes: entityRouteLines } = entityRoutes("chi", entities);
  const gormBlock = entities.length > 0 ? gormOpenBlock(config.database) : "";
  const needsOS = entities.length > 0;

  return `package server

import (
\t"context"
\t"encoding/json"
\t"log/slog"
\t"net/http"
${needsOS ? '\t"os"\n' : ""}
\t"github.com/go-chi/chi/v5"

\t"${module}/internal/config"
${importDB}${importCache}${importHandlers})

type Server struct {
\tcfg *config.Config
\tlog *slog.Logger
\tsrv *http.Server
}

func New(cfg *config.Config, log *slog.Logger) *Server {
\tr := chi.NewRouter()
\tr.Use(recoverer(log), requestLog(log)${config.rateLimit ? ", rateLimit()" : ""}${config.tracing ? ", tracing()" : ""})

${apiHSetupC}\tr.Get("/health", healthHandler)
${routesC}
${gormBlock}${entitySetup}
${entityRouteLines}

\treturn &Server{cfg: cfg, log: log, srv: &http.Server{Addr: ":" + cfg.Port, Handler: r}}
}

func (s *Server) Run() error { return s.srv.ListenAndServe() }
func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }
func (s *Server) Handler() http.Handler     { return s.srv.Handler }

func writeJSON(w http.ResponseWriter, status int, v any) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(v)
}

${inlineHandlersC}
`;
}

function goAuthJwt(): string {
  return `// Package auth verifies inbound JWTs against the configured issuer and JWKS
// endpoint. The JWKS is fetched once on first use and refreshed automatically
// by jwx's cache; no hand-rolled key management required.
//
// The package is provider-agnostic: point AUTH_ISSUER and AUTH_JWKS_URL at
// Clerk, Auth0, Cognito, Firebase, Keycloak, or Supabase Auth and the same
// verifier handles all of them. Set AUTH_AUDIENCE if the provider issues
// tokens with an \`aud\` claim (most do).
package auth

import (
\t"context"
\t"errors"
\t"fmt"
\t"net/http"
\t"os"
\t"strings"
\t"sync"
\t"time"

\t"github.com/lestrrat-go/jwx/v2/jwk"
\t"github.com/lestrrat-go/jwx/v2/jwt"
)

// Claims is a thin wrapper around jwt.Token so handlers can reach for the
// common fields (subject, audience, email) without poking at the jwx API.
type Claims struct {
\tSubject  string
\tIssuer   string
\tAudience []string
\tEmail    string
\tRaw      jwt.Token
}

type contextKey struct{}

// NewContext / FromContext thread claims through request context.
func NewContext(ctx context.Context, c *Claims) context.Context {
\treturn context.WithValue(ctx, contextKey{}, c)
}
func FromContext(ctx context.Context) (*Claims, bool) {
\tc, ok := ctx.Value(contextKey{}).(*Claims)
\treturn c, ok
}

// Verifier holds JWKS and config read from the environment. Safe to share
// across goroutines — jwk.Cache does its own locking.
type Verifier struct {
\tissuer   string
\taudience string
\tjwksURL  string
\tcache    *jwk.Cache
\tset      jwk.Set
\tonce     sync.Once
}

var (
\tdefaultVerifier *Verifier
\tdefaultErr      error
\tdefaultOnce     sync.Once
)

// Default returns a process-wide Verifier built from the AUTH_* env vars.
// Call \`auth.Default()\` once at startup to fail fast if the env is wrong.
func Default() (*Verifier, error) {
\tdefaultOnce.Do(func() {
\t\tdefaultVerifier, defaultErr = NewVerifier(context.Background())
\t})
\treturn defaultVerifier, defaultErr
}

func NewVerifier(ctx context.Context) (*Verifier, error) {
\tissuer := os.Getenv("AUTH_ISSUER")
\tjwksURL := os.Getenv("AUTH_JWKS_URL")
\tif issuer == "" || jwksURL == "" {
\t\treturn nil, errors.New("auth: AUTH_ISSUER and AUTH_JWKS_URL must be set")
\t}

\tcache := jwk.NewCache(ctx)
\tif err := cache.Register(jwksURL, jwk.WithMinRefreshInterval(15*time.Minute)); err != nil {
\t\treturn nil, fmt.Errorf("auth: register JWKS: %w", err)
\t}
\t// Warm the cache so the first incoming request doesn't pay the fetch latency.
\tif _, err := cache.Refresh(ctx, jwksURL); err != nil {
\t\treturn nil, fmt.Errorf("auth: fetch JWKS: %w", err)
\t}
\treturn &Verifier{
\t\tissuer:   issuer,
\t\taudience: os.Getenv("AUTH_AUDIENCE"),
\t\tjwksURL:  jwksURL,
\t\tcache:    cache,
\t\tset:      jwk.NewCachedSet(cache, jwksURL),
\t}, nil
}

// Verify parses, validates, and returns claims for the given raw token.
// Returns a wrapped error on any validation failure — the caller should
// respond 401 without leaking detail to the client.
func (v *Verifier) Verify(ctx context.Context, raw string) (*Claims, error) {
\topts := []jwt.ParseOption{
\t\tjwt.WithKeySet(v.set),
\t\tjwt.WithIssuer(v.issuer),
\t\tjwt.WithValidate(true),
\t\tjwt.WithAcceptableSkew(30 * time.Second),
\t}
\tif v.audience != "" {
\t\topts = append(opts, jwt.WithAudience(v.audience))
\t}
\ttok, err := jwt.ParseString(raw, opts...)
\tif err != nil {
\t\treturn nil, fmt.Errorf("auth: verify: %w", err)
\t}
\temail, _ := tok.Get("email")
\temailStr, _ := email.(string)
\treturn &Claims{
\t\tSubject:  tok.Subject(),
\t\tIssuer:   tok.Issuer(),
\t\tAudience: tok.Audience(),
\t\tEmail:    emailStr,
\t\tRaw:      tok,
\t}, nil
}

// ExtractBearer pulls the token out of an \`Authorization: Bearer <token>\`
// header and returns an error when the header is missing or malformed.
// Framework middleware wraps this.
func ExtractBearer(h http.Header) (string, error) {
\tauth := h.Get("Authorization")
\tif auth == "" {
\t\treturn "", errors.New("missing Authorization header")
\t}
\tconst prefix = "Bearer "
\tif !strings.HasPrefix(auth, prefix) {
\t\treturn "", errors.New("Authorization header must be a Bearer token")
\t}
\treturn strings.TrimSpace(auth[len(prefix):]), nil
}
`;
}

function goMiddleware(config: StackConfig, module: string, withAuth: boolean) {
  const fw = config.framework;
  // Per-framework import of the shared auth package. We import it only when
  // at least one endpoint needs protection (withAuth) — otherwise the
  // auth middleware is a no-op and we skip the dependency entirely.
  const authImport = withAuth ? `\n\t"${module}/internal/auth"` : "";
  if (fw === "gin") {
    return `package server

import (
\t"log/slog"
\t"net/http"
\t"time"

\t"github.com/gin-gonic/gin"${authImport}
)

func recoverer(log *slog.Logger) gin.HandlerFunc {
\treturn gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, err any) {
\t\tlog.Error("panic", "err", err)
\t\tc.AbortWithStatus(500)
\t})
}

func requestLog(log *slog.Logger) gin.HandlerFunc {
\treturn func(c *gin.Context) {
\t\tstart := time.Now()
\t\tc.Next()
\t\tlog.Info("req", "m", c.Request.Method, "p", c.Request.URL.Path, "s", c.Writer.Status(), "d", time.Since(start))
\t}
}

${config.rateLimit ? `func rateLimit() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } } // TODO: implement using redis
` : ""}${config.tracing ? `func tracing() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } } // TODO: wire otel
` : ""}${
  withAuth
    ? `func authRequired(c *gin.Context) {
\tv, err := auth.Default()
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "auth_unconfigured"})
\t\treturn
\t}
\traw, err := auth.ExtractBearer(c.Request.Header)
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing_or_malformed_token"})
\t\treturn
\t}
\tclaims, err := v.Verify(c.Request.Context(), raw)
\tif err != nil {
\t\tc.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid_token"})
\t\treturn
\t}
\tc.Request = c.Request.WithContext(auth.NewContext(c.Request.Context(), claims))
\tc.Next()
}
`
    : `func authRequired(c *gin.Context) {
\t// Auth disabled — no provider configured for this stack.
\tc.Next()
}
`}`;
  }
  if (fw === "fiber") {
    return `package server

import (
\t"log/slog"
\t"time"

\t"github.com/gofiber/fiber/v2"${authImport}
)

func recoverer(log *slog.Logger) fiber.Handler {
\treturn func(c *fiber.Ctx) error {
\t\tdefer func() {
\t\t\tif r := recover(); r != nil {
\t\t\t\tlog.Error("panic", "err", r)
\t\t\t\t_ = c.SendStatus(500)
\t\t\t}
\t\t}()
\t\treturn c.Next()
\t}
}

func requestLog(log *slog.Logger) fiber.Handler {
\treturn func(c *fiber.Ctx) error {
\t\tstart := time.Now()
\t\terr := c.Next()
\t\tlog.Info("req", "m", c.Method(), "p", c.Path(), "s", c.Response().StatusCode(), "d", time.Since(start))
\t\treturn err
\t}
}

${config.rateLimit ? "func rateLimit() fiber.Handler { return func(c *fiber.Ctx) error { return c.Next() } }\n" : ""}${config.tracing ? "func tracing() fiber.Handler { return func(c *fiber.Ctx) error { return c.Next() } }\n" : ""}${
  withAuth
    ? `func authRequired(c *fiber.Ctx) error {
\tv, err := auth.Default()
\tif err != nil {
\t\treturn c.Status(500).JSON(fiber.Map{"error": "auth_unconfigured"})
\t}
\traw, err := auth.ExtractBearer(c.GetReqHeaders().(map[string][]string))
\tif err != nil {
\t\treturn c.Status(401).JSON(fiber.Map{"error": "missing_or_malformed_token"})
\t}
\tclaims, err := v.Verify(c.UserContext(), raw)
\tif err != nil {
\t\treturn c.Status(401).JSON(fiber.Map{"error": "invalid_token"})
\t}
\tc.SetUserContext(auth.NewContext(c.UserContext(), claims))
\treturn c.Next()
}
`
    : `func authRequired(c *fiber.Ctx) error { return c.Next() }
`}`;
  }
  if (fw === "echo") {
    return `package server

import (
\t"log/slog"
\t"net/http"
\t"time"

\t"github.com/labstack/echo/v4"${authImport}
)

func recoverer(log *slog.Logger) echo.MiddlewareFunc {
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) (err error) {
\t\t\tdefer func() {
\t\t\t\tif r := recover(); r != nil {
\t\t\t\t\tlog.Error("panic", "err", r)
\t\t\t\t\terr = c.NoContent(500)
\t\t\t\t}
\t\t\t}()
\t\t\treturn next(c)
\t\t}
\t}
}

func requestLog(log *slog.Logger) echo.MiddlewareFunc {
\treturn func(next echo.HandlerFunc) echo.HandlerFunc {
\t\treturn func(c echo.Context) error {
\t\t\tstart := time.Now()
\t\t\terr := next(c)
\t\t\tlog.Info("req", "m", c.Request().Method, "p", c.Path(), "s", c.Response().Status, "d", time.Since(start))
\t\t\treturn err
\t\t}
\t}
}

${config.rateLimit ? "func rateLimit() echo.MiddlewareFunc { return func(next echo.HandlerFunc) echo.HandlerFunc { return next } }\n" : ""}${config.tracing ? "func tracing() echo.MiddlewareFunc { return func(next echo.HandlerFunc) echo.HandlerFunc { return next } }\n" : ""}${
  withAuth
    ? `func authRequired(next echo.HandlerFunc) echo.HandlerFunc {
\treturn func(c echo.Context) error {
\t\tv, err := auth.Default()
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusInternalServerError, map[string]string{"error": "auth_unconfigured"})
\t\t}
\t\traw, err := auth.ExtractBearer(c.Request().Header)
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusUnauthorized, map[string]string{"error": "missing_or_malformed_token"})
\t\t}
\t\tclaims, err := v.Verify(c.Request().Context(), raw)
\t\tif err != nil {
\t\t\treturn c.JSON(http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
\t\t}
\t\tc.SetRequest(c.Request().WithContext(auth.NewContext(c.Request().Context(), claims)))
\t\treturn next(c)
\t}
}
`
    : `func authRequired(next echo.HandlerFunc) echo.HandlerFunc { return next }
`}`;
  }
  // chi
  return `package server

import (
\t"encoding/json"
\t"log/slog"
\t"net/http"
\t"time"${authImport}
)

func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tdefer func() {
\t\t\t\tif rec := recover(); rec != nil {
\t\t\t\t\tlog.Error("panic", "err", rec)
\t\t\t\t\tw.WriteHeader(500)
\t\t\t\t}
\t\t\t}()
\t\t\tnext.ServeHTTP(w, r)
\t\t})
\t}
}

func requestLog(log *slog.Logger) func(http.Handler) http.Handler {
\treturn func(next http.Handler) http.Handler {
\t\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\t\tstart := time.Now()
\t\t\tnext.ServeHTTP(w, r)
\t\t\tlog.Info("req", "m", r.Method, "p", r.URL.Path, "d", time.Since(start))
\t\t})
\t}
}

${config.rateLimit ? "func rateLimit() func(http.Handler) http.Handler { return func(next http.Handler) http.Handler { return next } }\n" : ""}${config.tracing ? "func tracing() func(http.Handler) http.Handler { return func(next http.Handler) http.Handler { return next } }\n" : ""}${
  withAuth
    ? `func authRequired(next http.Handler) http.Handler {
\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
\t\tv, err := auth.Default()
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusInternalServerError, "auth_unconfigured")
\t\t\treturn
\t\t}
\t\traw, err := auth.ExtractBearer(r.Header)
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusUnauthorized, "missing_or_malformed_token")
\t\t\treturn
\t\t}
\t\tclaims, err := v.Verify(r.Context(), raw)
\t\tif err != nil {
\t\t\twriteJSONErr(w, http.StatusUnauthorized, "invalid_token")
\t\t\treturn
\t\t}
\t\tnext.ServeHTTP(w, r.WithContext(auth.NewContext(r.Context(), claims)))
\t})
}

func writeJSONErr(w http.ResponseWriter, status int, code string) {
\tw.Header().Set("Content-Type", "application/json")
\tw.WriteHeader(status)
\t_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
`
    : `func authRequired(next http.Handler) http.Handler { return next }
`}`;
}

function goHealth(framework: string) {
  if (framework === "gin") {
    return `package server

import "github.com/gin-gonic/gin"

func healthHandler(c *gin.Context) {
\tc.JSON(200, gin.H{"ok": true})
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
\t"context"
\t"errors"
\t"fmt"
\t"log"
\t"time"

\t_ "github.com/jackc/pgx/v5/stdlib"
\t"database/sql"
)

// Open connects to the database and retries transient errors with exponential
// backoff (up to ~30s total). Kubernetes pods frequently come up before their
// database StatefulSet / managed instance accepts connections — without retry
// the API pod restarts and delays rollout.
//
// Pool sizing (25 open / 10 idle / 30m lifetime) matches Go's community
// consensus for a single-instance API talking to Postgres. Tune per your
// connection-limited deployment (e.g. pgbouncer transaction pooling).
func Open(dsn string) (*sql.DB, error) {
\t// db: ${db}
\tconn, err := sql.Open("pgx", dsn)
\tif err != nil {
\t\treturn nil, fmt.Errorf("sql.Open: %w", err)
\t}
\tconn.SetMaxOpenConns(25)
\tconn.SetMaxIdleConns(10)
\tconn.SetConnMaxLifetime(30 * time.Minute)

\tctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
\tdefer cancel()

\tvar lastErr error
\tbackoff := 200 * time.Millisecond
\tfor attempt := 1; attempt <= 6; attempt++ {
\t\tif err := conn.PingContext(ctx); err == nil {
\t\t\treturn conn, nil
\t\t} else {
\t\t\tlastErr = err
\t\t\tif errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
\t\t\t\tbreak
\t\t\t}
\t\t\tlog.Printf("db: ping failed (attempt %d/6): %v — retrying in %s", attempt, err, backoff)
\t\t\tselect {
\t\t\tcase <-ctx.Done():
\t\t\t\treturn nil, fmt.Errorf("db: context cancelled while retrying: %w", ctx.Err())
\t\t\tcase <-time.After(backoff):
\t\t\t}
\t\t\tbackoff *= 2
\t\t\tif backoff > 5*time.Second {
\t\t\t\tbackoff = 5 * time.Second
\t\t\t}
\t\t}
\t}
\treturn nil, fmt.Errorf("db: could not connect after retries: %w", lastErr)
}
`;
}

function goRedis() {
  return `package cache

import (
\t"context"

\t"github.com/redis/go-redis/v9"
)

func Open(url string) (*redis.Client, error) {
\topt, err := redis.ParseURL(url)
\tif err != nil { return nil, err }
\tc := redis.NewClient(opt)
\tif err := c.Ping(context.Background()).Err(); err != nil { return nil, err }
\treturn c, nil
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

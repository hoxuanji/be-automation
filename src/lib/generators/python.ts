import type { Endpoint, GeneratedFile, StackConfig } from "./types";

export function pythonFiles(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push({ path: "pyproject.toml", content: pyproject(config) });
  files.push({ path: "Dockerfile", content: pyDockerfile() });
  files.push({ path: "app/__init__.py", content: "" });
  files.push({
    path: "app/main.py",
    content: appMain(config, endpoints),
  });
  files.push({
    path: "app/config.py",
    content: `from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "app"
    log_level: str = "info"
    database_url: str | None = None
    redis_url: str | None = None
    jwt_secret: str | None = None

    class Config:
        env_file = ".env"

settings = Settings()
`,
  });

  return files;
}

function pyproject(config: StackConfig) {
  const deps =
    config.framework === "fastapi"
      ? `fastapi = "^0.115.0"\nuvicorn = { extras = ["standard"], version = "^0.30.0" }\npydantic = "^2.9.0"\npydantic-settings = "^2.5.0"`
      : config.framework === "litestar"
      ? `litestar = { extras = ["standard"], version = "^2.12.0" }\npydantic-settings = "^2.5.0"`
      : `django = "^5.1.0"\npydantic-settings = "^2.5.0"`;
  return `[project]
name = "${config.name}"
version = "0.1.0"
requires-python = ">=3.12"

[tool.poetry.dependencies]
python = "^3.12"
${deps}

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.0"
httpx = "^0.27.0"
`;
}

function pyDockerfile() {
  return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY pyproject.toml ./
RUN pip install --no-cache-dir poetry==1.8.3 && poetry config virtualenvs.create false && poetry install --only main --no-root || pip install fastapi uvicorn pydantic pydantic-settings
COPY . .
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

function appMain(config: StackConfig, endpoints: Endpoint[]) {
  if (config.framework === "fastapi") {
    const routes = endpoints
      .map((e) => {
        const py = e.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
        const paramsDecl = (e.path.match(/:([a-zA-Z0-9_]+)/g) ?? [])
          .map((p) => `${p.slice(1)}: str`)
          .join(", ");
        return `@app.${e.method.toLowerCase()}(${JSON.stringify(py)})
async def ${handlerName(e)}(${paramsDecl}):
    return {"ok": True, "op": "${e.method} ${e.path}"}`;
      })
      .join("\n\n");
    return `from fastapi import FastAPI, Depends, HTTPException, Header
from .config import settings

app = FastAPI(title=settings.app_name)

async def auth_required(authorization: str | None = Header(default=None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="unauthorized")

@app.get("/health")
async def health():
    return {"ok": True}

${routes}
`;
  }
  if (config.framework === "litestar") {
    return `from litestar import Litestar, get

@get("/health")
async def health() -> dict:
    return {"ok": True}

app = Litestar(route_handlers=[health])
`;
  }
  // django minimal
  return `# Minimal Django entrypoint — see deploy/k8s for production setup
from django.http import JsonResponse
from django.urls import path

def health(_):
    return JsonResponse({"ok": True})

urlpatterns = [path("health", health)]
`;
}

function handlerName(e: Endpoint) {
  const parts = e.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? "by_" + p.slice(1) : p.replace(/[^a-zA-Z0-9]/g, "_")));
  return (e.method.toLowerCase() + "_" + parts.join("_")).replace(/_+$/g, "");
}

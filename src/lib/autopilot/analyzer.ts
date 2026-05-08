import { Octokit } from "@octokit/rest";
import type { Audit, DetectedStack, Finding, RepoRef } from "./schema";

/**
 * Static analyzer. Does not clone the repo — only fetches a handful of
 * manifest files via the GitHub API and runs pattern checks against them.
 * That keeps latency under ~3s and avoids needing a worker or storage.
 */

const MANIFEST_PATHS = [
  "package.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Dockerfile",
  "docker-compose.yml",
  "README.md",
  "LICENSE",
  ".env.example",
  ".gitignore",
  ".github/dependabot.yml",
];

const CI_PATHS = [
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
  ".github/workflows/test.yml",
  ".github/workflows/build.yml",
  ".gitlab-ci.yml",
  ".circleci/config.yml",
];

type FileBundle = Record<string, string | null>;

export async function auditRepo(
  token: string,
  ref: RepoRef
): Promise<Audit> {
  const octo = new Octokit({ auth: token, userAgent: "helios-autopilot/0.1" });

  const { data: repo } = await octo.repos.get({
    owner: ref.owner,
    repo: ref.name,
  });

  const files: FileBundle = {};
  await Promise.all(
    [...MANIFEST_PATHS, ...CI_PATHS].map(async (path) => {
      files[path] = await fetchFile(octo, ref, path, repo.default_branch);
    })
  );

  const stack = detectStack(files);
  const findings = buildFindings(stack, files);
  const score = scoreRepo(stack, findings);

  return {
    repo: {
      owner: repo.owner.login,
      name: repo.name,
      defaultBranch: repo.default_branch,
      stars: repo.stargazers_count,
      description: repo.description,
      htmlUrl: repo.html_url,
    },
    stack,
    findings,
    score,
  };
}

async function fetchFile(
  octo: Octokit,
  ref: RepoRef,
  path: string,
  branch: string
): Promise<string | null> {
  try {
    const { data } = await octo.repos.getContent({
      owner: ref.owner,
      repo: ref.name,
      path,
      ref: branch,
    });
    if (Array.isArray(data)) return null;
    if (data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function detectStack(files: FileBundle): DetectedStack {
  const pkgRaw = files["package.json"];
  const goMod = files["go.mod"];
  const pyproject = files["pyproject.toml"];
  const cargo = files["Cargo.toml"];
  const pom = files["pom.xml"];
  const gradle = files["build.gradle"] ?? files["build.gradle.kts"];

  let language: DetectedStack["language"] = "unknown";
  let packageManager: DetectedStack["packageManager"] = "unknown";
  let framework: string | undefined;
  let nodeVersion: string | undefined;
  let goVersion: string | undefined;
  let pythonVersion: string | undefined;

  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        engines?: { node?: string };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        packageManager?: string;
      };
      const isTs =
        !!pkg.devDependencies?.typescript || !!pkg.dependencies?.typescript;
      language = isTs ? "typescript" : "javascript";
      nodeVersion = pkg.engines?.node;
      packageManager = /^pnpm/.test(pkg.packageManager ?? "")
        ? "pnpm"
        : /^yarn/.test(pkg.packageManager ?? "")
        ? "yarn"
        : /^bun/.test(pkg.packageManager ?? "")
        ? "bun"
        : "npm";
      framework = inferNodeFramework(pkg.dependencies ?? {}, pkg.devDependencies ?? {});
    } catch {
      /* ignore */
    }
  } else if (goMod) {
    language = "go";
    packageManager = "go";
    const m = /^go\s+(\S+)/m.exec(goMod);
    if (m) goVersion = m[1];
    if (/gin-gonic\/gin/.test(goMod)) framework = "gin";
    else if (/gofiber\/fiber/.test(goMod)) framework = "fiber";
    else if (/labstack\/echo/.test(goMod)) framework = "echo";
    else if (/go-chi\/chi/.test(goMod)) framework = "chi";
  } else if (pyproject) {
    language = "python";
    packageManager = /\[tool\.poetry\]/.test(pyproject) ? "poetry" : "pip";
    const v = /requires-python\s*=\s*"([^"]+)"/.exec(pyproject);
    if (v) pythonVersion = v[1];
    if (/fastapi/i.test(pyproject)) framework = "fastapi";
    else if (/django/i.test(pyproject)) framework = "django";
    else if (/litestar/i.test(pyproject)) framework = "litestar";
  } else if (cargo) {
    language = "rust";
    packageManager = "cargo";
    if (/axum/.test(cargo)) framework = "axum";
    else if (/actix-web/.test(cargo)) framework = "actix";
  } else if (pom) {
    language = "java";
    packageManager = "maven";
    if (/spring-boot/.test(pom)) framework = "spring";
  } else if (gradle) {
    language = gradle.includes("kotlin") ? "kotlin" : "java";
    packageManager = "gradle";
    if (/ktor/.test(gradle)) framework = "ktor";
  }

  const hasCI = [
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".github/workflows/test.yml",
    ".github/workflows/build.yml",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
  ].some((p) => !!files[p]);

  const hasTests = detectTests(pkgRaw, goMod, pyproject);

  return {
    language,
    framework,
    packageManager,
    nodeVersion,
    goVersion,
    pythonVersion,
    hasDockerfile: !!files["Dockerfile"],
    hasCI,
    hasTests,
    hasReadme: !!(files["README.md"] && files["README.md"].length > 100),
    hasLicense: !!files["LICENSE"],
    hasEnvExample: !!files[".env.example"],
    hasGitignore: !!files[".gitignore"],
    hasDependabot: !!files[".github/dependabot.yml"],
  };
}

function inferNodeFramework(
  deps: Record<string, string>,
  devDeps: Record<string, string>
): string | undefined {
  const all = { ...deps, ...devDeps };
  if (all["@nestjs/core"]) return "nestjs";
  if (all["fastify"]) return "fastify";
  if (all["hono"]) return "hono";
  if (all["express"]) return "express";
  if (all["next"]) return "next";
  return undefined;
}

function detectTests(
  pkgRaw: string | null,
  goMod: string | null,
  pyproject: string | null
): boolean {
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      return (
        !!all.vitest ||
        !!all.jest ||
        !!all.mocha ||
        !!all["@playwright/test"] ||
        !!all.cypress
      );
    } catch {
      return false;
    }
  }
  if (goMod) return false; // Go tests live in _test.go — would need a tree walk.
  if (pyproject) return /pytest|unittest/i.test(pyproject);
  return false;
}

function buildFindings(stack: DetectedStack, files: FileBundle): Finding[] {
  const findings: Finding[] = [];

  if (!stack.hasDockerfile) {
    findings.push({
      id: "add-dockerfile",
      severity: "warning",
      category: "ops",
      title: "No Dockerfile",
      description:
        "Without a Dockerfile, every deploy is bespoke and reproducible builds are difficult. Adding a multi-stage Dockerfile with a distroless runtime yields ~30% smaller images and a smaller attack surface.",
      impact: "Ops · reproducible builds · smaller image",
      proposedFiles: [
        {
          path: "Dockerfile",
          action: "create",
          reason:
            "Multi-stage build tuned for the detected language; distroless runtime.",
        },
      ],
    });
  }

  if (!stack.hasCI) {
    findings.push({
      id: "add-ci",
      severity: "warning",
      category: "ops",
      title: "No CI pipeline",
      description:
        "No GitHub Actions workflow was found. A baseline CI that installs, lints, tests, and typechecks catches 80% of PR regressions.",
      impact: "Quality · catches regressions on every PR",
      proposedFiles: [
        {
          path: ".github/workflows/ci.yml",
          action: "create",
          reason:
            "GitHub Actions workflow for install + lint + test + build, matrix for the detected language's stable version.",
        },
      ],
    });
  }

  if (!stack.hasDependabot) {
    findings.push({
      id: "add-dependabot",
      severity: "info",
      category: "security",
      title: "No Dependabot config",
      description:
        "Dependabot opens weekly PRs for vulnerable or outdated dependencies — free security hygiene that scales with your team.",
      impact: "Security · automated dep updates",
      proposedFiles: [
        {
          path: ".github/dependabot.yml",
          action: "create",
          reason: "Weekly scan of the detected package manager + GitHub Actions.",
        },
      ],
    });
  }

  if (!stack.hasEnvExample) {
    findings.push({
      id: "add-env-example",
      severity: "info",
      category: "docs",
      title: "No .env.example",
      description:
        "Missing .env.example makes onboarding slow — new contributors guess what env vars exist.",
      impact: "DX · faster onboarding",
      proposedFiles: [
        {
          path: ".env.example",
          action: "create",
          reason: "Template with common env vars (PORT, LOG_LEVEL, DATABASE_URL).",
        },
      ],
    });
  }

  if (!stack.hasLicense) {
    findings.push({
      id: "add-license",
      severity: "info",
      category: "docs",
      title: "No LICENSE file",
      description:
        "No license = legally ambiguous. Most open-source repos should have MIT or Apache-2.0. Enterprise consumers cannot depend on unlicensed code.",
      impact: "Adoption · removes legal friction",
      proposedFiles: [
        {
          path: "LICENSE",
          action: "create",
          reason: "MIT License with the repo owner as copyright holder.",
        },
      ],
    });
  }

  if (!stack.hasReadme) {
    findings.push({
      id: "add-readme",
      severity: "info",
      category: "docs",
      title: "README is missing or minimal",
      description:
        "A README is the first thing every visitor sees. Missing or under-100-char READMEs hurt adoption and SEO.",
      impact: "Adoption · SEO · contributor onboarding",
      proposedFiles: [
        {
          path: "README.md",
          action: "update",
          reason: "Expanded with overview, quickstart, scripts, and contribution notes.",
        },
      ],
    });
  }

  if (stack.language === "typescript" || stack.language === "javascript") {
    if (stack.nodeVersion && isOutdatedNode(stack.nodeVersion)) {
      findings.push({
        id: "bump-node",
        severity: "warning",
        category: "security",
        title: `Node ${stack.nodeVersion} is outdated`,
        description: `Node ${stack.nodeVersion} is no longer in LTS. Bumping to Node 22 gets you security patches, better perf, and stable native fetch.`,
        impact: "Security · perf · stable runtime",
        proposedFiles: [
          {
            path: "package.json",
            action: "update",
            reason: "Bump engines.node to >=22",
          },
        ],
      });
    }
  }

  if (stack.language === "go" && stack.goVersion && isOutdatedGo(stack.goVersion)) {
    findings.push({
      id: "bump-go",
      severity: "warning",
      category: "security",
      title: `Go ${stack.goVersion} is outdated`,
      description: `Go ${stack.goVersion} is behind the current release. Bumping unlocks loop-var fixes, runtime speedups, and security backports.`,
      impact: "Security · perf",
      proposedFiles: [
        { path: "go.mod", action: "update", reason: "Bump to go 1.23" },
      ],
    });
  }

  return findings;
}

function isOutdatedNode(v: string): boolean {
  const m = /(\d+)/.exec(v);
  if (!m) return false;
  return parseInt(m[1], 10) < 20;
}

function isOutdatedGo(v: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (major < 1) return true;
  if (major === 1 && minor < 22) return true;
  return false;
}

function scoreRepo(stack: DetectedStack, findings: Finding[]): number {
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  let score = 100;
  score -= critical * 20;
  score -= warnings * 10;
  score -= infos * 3;
  if (!stack.hasReadme) score -= 3;
  if (!stack.hasLicense) score -= 2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export { MANIFEST_PATHS, CI_PATHS };

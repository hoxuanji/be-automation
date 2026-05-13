// ─── Types ────────────────────────────────────────────────────────────────────

export type GitStrategy = "github-flow" | "git-flow" | "trunk" | "release-trains";

export type WorkflowId =
  | "pr-check"
  | "release"
  | "deploy-staging"
  | "deploy-prod"
  | "dep-scan"
  | "secret-scan"
  | "stale";

export type WorkflowJob = {
  id: string;
  name: string;
  enabled: boolean;
};

export type WorkflowConfig = {
  id: WorkflowId;
  enabled: boolean;
  jobs: WorkflowJob[];
  rawMode: boolean;
  rawYaml?: string;
};

export type BranchProtectionRule = {
  pattern: string;
  requirePR: boolean;
  requiredApprovals: number;
  dismissStaleReviews: boolean;
  requireStatusChecks: string[];
  requireUpToDate: boolean;
  blockForcePush: boolean;
  blockDeletion: boolean;
  requireLinearHistory: boolean;
  requireSignedCommits: boolean;
};

export type CommitlintConfig = {
  types: string[];
  scopeAllowlist: string[];
  requireScope: boolean;
  requireBody: boolean;
  maxSubjectLength: number;
};

export type HuskyConfig = {
  enabled: boolean;
  preCommitCommands: string[];
  commitMsgLint: boolean;
  prePushCommands: string[];
};

export type SemanticReleaseConfig = {
  enabled: boolean;
  branches: string[];
  generateChangelog: boolean;
  createGitHubRelease: boolean;
};

export type DeployEnvironment = {
  id: string;
  name: string;
  targetBranches: string[];
  requireApproval: boolean;
  approvers: string[];
};

export type PRTemplateSections = {
  summary: boolean;
  motivation: boolean;
  testPlan: boolean;
  screenshots: boolean;
  breakingChanges: boolean;
  relatedIssues: boolean;
  checklist: boolean;
};

export type StaleConfig = {
  enabled: boolean;
  daysBeforeIssueStale: number;
  daysBeforePrStale: number;
  daysBeforeClose: number;
  exemptLabels: string[];
};

export type FreezeWindow = {
  id: string;
  label: string;
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
};

export type GitConfig = {
  strategy: GitStrategy;
  defaultBranch: "main" | "master";
  branchNaming: {
    feature: string;
    bugfix: string;
    hotfix: string;
    release: string;
    chore: string;
    docs: string;
  };
  protectedBranches: BranchProtectionRule[];
  workflows: WorkflowConfig[];
  commitlint: CommitlintConfig;
  husky: HuskyConfig;
  semanticRelease: SemanticReleaseConfig;
  deployEnvironments: DeployEnvironment[];
  prTemplateSections: PRTemplateSections;
  codeowners: string;
  stale: StaleConfig;
  freezeWindows: FreezeWindow[];
  autoDeleteMergedBranches: boolean;
};

// ─── Metadata ─────────────────────────────────────────────────────────────────

export const WORKFLOW_META: Record<
  WorkflowId,
  { name: string; description: string; defaultJobs: WorkflowJob[] }
> = {
  "pr-check": {
    name: "PR Check",
    description: "Runs on every pull request. Validates branch naming, lints, type-checks, tests, and builds before merge.",
    defaultJobs: [
      { id: "branch-name", name: "Branch name validation", enabled: true },
      { id: "lint", name: "Lint & format", enabled: true },
      { id: "type-check", name: "Type check", enabled: true },
      { id: "test", name: "Tests", enabled: true },
      { id: "build", name: "Build", enabled: true },
      { id: "size-report", name: "Bundle size report", enabled: false },
      { id: "coverage-gate", name: "Coverage gate (≥80%)", enabled: false },
    ],
  },
  "release": {
    name: "Release",
    description: "Runs on push to the default branch. Triggers semantic-release to version, tag, and generate a changelog.",
    defaultJobs: [
      { id: "semantic-release", name: "Semantic release", enabled: true },
      { id: "docker-push", name: "Build & push Docker image", enabled: true },
      { id: "notify-slack", name: "Slack notification", enabled: false },
    ],
  },
  "deploy-staging": {
    name: "Deploy (Staging)",
    description: "Runs on push to release/* branches. Deploys to the staging environment.",
    defaultJobs: [
      { id: "deploy", name: "Deploy to staging", enabled: true },
      { id: "smoke-test", name: "Post-deploy smoke tests", enabled: false },
    ],
  },
  "deploy-prod": {
    name: "Deploy (Production)",
    description: "Runs when a GitHub Release is published. Deploys the tagged version to production.",
    defaultJobs: [
      { id: "deploy", name: "Deploy to production", enabled: true },
      { id: "smoke-test", name: "Post-deploy smoke tests", enabled: false },
      { id: "rollback-on-fail", name: "Auto-rollback on failure", enabled: false },
    ],
  },
  "dep-scan": {
    name: "Dependency Scan",
    description: "Runs weekly and on PRs. Audits dependencies for known vulnerabilities.",
    defaultJobs: [
      { id: "audit", name: "Dependency audit", enabled: true },
      { id: "license-check", name: "License compliance check", enabled: false },
      { id: "sbom", name: "Generate SBOM", enabled: false },
    ],
  },
  "secret-scan": {
    name: "Secret Scan",
    description: "Runs on every push. Detects accidentally committed secrets and credentials.",
    defaultJobs: [
      { id: "gitleaks", name: "Gitleaks scan", enabled: true },
      { id: "trufflehog", name: "TruffleHog deep scan", enabled: false },
    ],
  },
  "stale": {
    name: "Stale Issues & PRs",
    description: "Runs nightly. Labels and optionally closes issues and PRs that have had no activity.",
    defaultJobs: [
      { id: "stale", name: "Mark and close stale items", enabled: true },
    ],
  },
};

export const STRATEGY_META: Record<GitStrategy, { name: string; description: string; badge: string }> = {
  "github-flow": {
    name: "GitHub Flow",
    description: "Simple: feature branches off main, PR to merge. Main is always deployable. Best for continuous deployment.",
    badge: "Most popular",
  },
  "git-flow": {
    name: "Git Flow",
    description: "Full branching model: main + develop + feature/release/hotfix branches. Best for versioned releases.",
    badge: "Structured",
  },
  "trunk": {
    name: "Trunk-Based",
    description: "All devs commit to main (or very short-lived branches). Feature flags gate incomplete work. Best for high-velocity teams.",
    badge: "Advanced",
  },
  "release-trains": {
    name: "Release Trains",
    description: "Periodic release/* stabilization branches. Teams merge features by a cutoff, then the train ships. Best for large teams.",
    badge: "Enterprise",
  },
};

// ─── Defaults ─────────────────────────────────────────────────────────────────

export function defaultGitConfig(): GitConfig {
  return {
    strategy: "github-flow",
    defaultBranch: "main",
    branchNaming: {
      feature: "feature/*",
      bugfix: "bugfix/*",
      hotfix: "hotfix/*",
      release: "release/v*",
      chore: "chore/*",
      docs: "docs/*",
    },
    protectedBranches: [
      {
        pattern: "main",
        requirePR: true,
        requiredApprovals: 1,
        dismissStaleReviews: true,
        requireStatusChecks: ["PR Check / Lint & format", "PR Check / Tests", "PR Check / Build"],
        requireUpToDate: true,
        blockForcePush: true,
        blockDeletion: true,
        requireLinearHistory: false,
        requireSignedCommits: false,
      },
      {
        pattern: "release/*",
        requirePR: true,
        requiredApprovals: 1,
        dismissStaleReviews: false,
        requireStatusChecks: ["PR Check / Build"],
        requireUpToDate: false,
        blockForcePush: true,
        blockDeletion: false,
        requireLinearHistory: false,
        requireSignedCommits: false,
      },
    ],
    workflows: (Object.keys(WORKFLOW_META) as WorkflowId[]).map((id) => ({
      id,
      enabled: true,
      jobs: WORKFLOW_META[id].defaultJobs.map((j) => ({ ...j })),
      rawMode: false,
    })),
    commitlint: {
      types: ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "revert", "ci"],
      scopeAllowlist: [],
      requireScope: false,
      requireBody: false,
      maxSubjectLength: 72,
    },
    husky: {
      enabled: true,
      preCommitCommands: ["npx lint-staged"],
      commitMsgLint: true,
      prePushCommands: [],
    },
    semanticRelease: {
      enabled: true,
      branches: ["main"],
      generateChangelog: true,
      createGitHubRelease: true,
    },
    deployEnvironments: [
      { id: "dev", name: "Development", targetBranches: ["feature/*", "bugfix/*"], requireApproval: false, approvers: [] },
      { id: "staging", name: "Staging", targetBranches: ["release/*"], requireApproval: false, approvers: [] },
      { id: "prod", name: "Production", targetBranches: ["main"], requireApproval: true, approvers: [] },
    ],
    prTemplateSections: {
      summary: true,
      motivation: true,
      testPlan: true,
      screenshots: false,
      breakingChanges: true,
      relatedIssues: true,
      checklist: true,
    },
    codeowners: `# CODEOWNERS — who reviews what
# Format: <pattern> <@user-or-team>
#
# * @your-org/backend-team
# src/api/ @your-org/api-team
# .github/ @your-org/devops-team
`,
    stale: {
      enabled: true,
      daysBeforeIssueStale: 30,
      daysBeforePrStale: 14,
      daysBeforeClose: 7,
      exemptLabels: ["pinned", "security", "help wanted"],
    },
    freezeWindows: [],
    autoDeleteMergedBranches: true,
  };
}

// ─── YAML generators (used in preview + file output) ──────────────────────────

export function renderWorkflowYaml(id: WorkflowId, git: GitConfig, language = "typescript"): string {
  const w = git.workflows.find((wf) => wf.id === id);
  if (w?.rawMode && w.rawYaml) return w.rawYaml;

  const enabledJobs = (w?.jobs ?? WORKFLOW_META[id].defaultJobs).filter((j) => j.enabled);
  const hasJob = (jid: string) => enabledJobs.some((j) => j.id === jid);
  const db = git.defaultBranch;

  const langSetup: Record<string, string> = {
    go: `      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true`,
    typescript: `      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci`,
    python: `      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install uv && uv pip install -e ".[dev]" --system`,
    rust: `      - uses: dtolnay/rust-toolchain@stable`,
    java: `      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'`,
    kotlin: `      - uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: 'temurin'`,
  };

  const lintCmd: Record<string, string> = {
    go: "go vet ./... && golangci-lint run",
    typescript: "npx tsc --noEmit && npx eslint .",
    python: "ruff check . && mypy .",
    rust: "cargo clippy -- -D warnings && cargo fmt --check",
    java: "./mvnw checkstyle:check",
    kotlin: "./gradlew detekt",
  };
  const testCmd: Record<string, string> = {
    go: "go test ./... -race -cover -coverprofile=coverage.out",
    typescript: "npm test --if-present",
    python: "pytest -q --cov --cov-report=xml",
    rust: "cargo test",
    java: "./mvnw test",
    kotlin: "./gradlew test",
  };
  const buildCmd: Record<string, string> = {
    go: "go build ./...",
    typescript: "npm run build --if-present",
    python: "python -m py_compile $(find app -name '*.py')",
    rust: "cargo build --release",
    java: "./mvnw package -DskipTests",
    kotlin: "./gradlew assemble",
  };

  const setup = langSetup[language] ?? langSetup.typescript;
  const _branchPattern = [
    git.branchNaming.feature,
    git.branchNaming.bugfix,
    git.branchNaming.hotfix,
    git.branchNaming.release,
    git.branchNaming.chore,
    git.branchNaming.docs,
  ].map((p) => `'^${p.replace("*", ".+")}$'`).join("|");

  switch (id) {
    case "pr-check":
      return `name: PR Check
on:
  pull_request:
    branches: [${db}, 'release/**']

jobs:
${hasJob("branch-name") ? `  validate-branch:
    name: Branch name
    runs-on: ubuntu-latest
    steps:
      - name: Check naming convention
        run: |
          BRANCH="\${{ github.head_ref }}"
          if ! echo "$BRANCH" | grep -qE '^(${[git.branchNaming.feature, git.branchNaming.bugfix, git.branchNaming.hotfix, git.branchNaming.release, git.branchNaming.chore, git.branchNaming.docs].map(p => p.replace("*", ".+")).join("|")})'; then
            echo "❌ Branch '$BRANCH' violates naming rules."
            echo "   Allowed: ${Object.values(git.branchNaming).join(", ")}"
            exit 1
          fi
` : ""}
${hasJob("lint") || hasJob("type-check") ? `  lint:
    name: Lint & type check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}
${hasJob("lint") ? `      - name: Lint
        run: ${lintCmd[language] ?? lintCmd.typescript}` : ""}
` : ""}
${hasJob("test") ? `  test:
    name: Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}
      - name: Run tests
        run: ${testCmd[language] ?? testCmd.typescript}
${hasJob("coverage-gate") ? `      - name: Coverage gate
        run: |
          COVERAGE=$(grep -oP 'total.*\\K[0-9]+(?=%)' coverage.out || echo 0)
          [ "$COVERAGE" -ge 80 ] || (echo "Coverage $COVERAGE% < 80%" && exit 1)` : ""}
` : ""}
${hasJob("build") ? `  build:
    name: Build
    needs: [${[hasJob("lint") || hasJob("type-check") ? "lint" : null, hasJob("test") ? "test" : null].filter(Boolean).join(", ")}]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}
      - name: Build
        run: ${buildCmd[language] ?? buildCmd.typescript}
` : ""}`;

    case "release":
      return `name: Release
on:
  push:
    branches: [${db}]

${git.semanticRelease.branches.length > 1 ? `# Branches: ${git.semanticRelease.branches.join(", ")}` : ""}
jobs:
${hasJob("semantic-release") && git.semanticRelease.enabled ? `  release:
    name: Semantic Release
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Semantic release
        run: npx semantic-release
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
` : ""}
${hasJob("docker-push") ? `  docker:
    name: Build & push image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/\${{ github.repository }}:\${{ github.sha }},ghcr.io/\${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
` : ""}`;

    case "deploy-staging":
      return `name: Deploy (Staging)
on:
  push:
    branches: ['release/**']

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    environment: staging
    concurrency:
      group: deploy-staging
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          echo "Add your staging deploy command here"
          # Examples: flyctl deploy, railway up, render deploy hook
        env:
          STAGING_URL: \${{ secrets.STAGING_URL }}
${hasJob("smoke-test") ? `
      - name: Smoke tests
        run: |
          curl -f "\${{ secrets.STAGING_URL }}/health" || exit 1
` : ""}`;

    case "deploy-prod":
      return `name: Deploy (Production)
on:
  release:
    types: [published]

jobs:
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    environment: production
    concurrency:
      group: deploy-prod
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.release.tag_name }}
      - name: Deploy to production
        run: |
          echo "Add your production deploy command here"
          echo "Deploying tag: \${{ github.event.release.tag_name }}"
        env:
          PROD_URL: \${{ secrets.PROD_URL }}
${hasJob("smoke-test") ? `
      - name: Smoke tests
        run: curl -f "\${{ secrets.PROD_URL }}/health" || exit 1
` : ""}${hasJob("rollback-on-fail") ? `
      - name: Rollback on failure
        if: failure()
        run: echo "Trigger rollback to previous stable tag"
` : ""}`;

    case "dep-scan":
      const auditCmd: Record<string, string> = {
        go: "go list -json -m all | docker run --rm -i sonatypecommunity/nancy:latest sleuth",
        typescript: "npm audit --audit-level=high",
        python: "pip-audit",
        rust: "cargo audit",
        java: "./mvnw org.owasp:dependency-check-maven:check",
        kotlin: "./gradlew dependencyCheckAnalyze",
      };
      return `name: Dependency Scan
on:
  schedule:
    - cron: '0 8 * * 1'  # Every Monday 08:00 UTC
  pull_request:

jobs:
  audit:
    name: Audit dependencies
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}
      - name: Dependency audit
        run: ${auditCmd[language] ?? auditCmd.typescript}
${hasJob("license-check") ? `
  license:
    name: License compliance
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npx license-checker --onlyAllow 'MIT;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause'
` : ""}${hasJob("sbom") ? `
  sbom:
    name: Generate SBOM
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anchore/sbom-action@v0
        with:
          format: spdx-json
          output-file: sbom.spdx.json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom
          path: sbom.spdx.json
` : ""}`;

    case "secret-scan":
      return `name: Secret Scan
on:
  push:
  pull_request:

jobs:
  gitleaks:
    name: Gitleaks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
${hasJob("trufflehog") ? `
  trufflehog:
    name: TruffleHog deep scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: \${{ github.event.repository.default_branch }}
          head: HEAD
` : ""}`;

    case "stale":
      return `name: Stale Issues & PRs
on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 06:00 UTC
  workflow_dispatch:

jobs:
  stale:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
    steps:
      - uses: actions/stale@v9
        with:
          days-before-issue-stale: ${git.stale.daysBeforeIssueStale}
          days-before-pr-stale: ${git.stale.daysBeforePrStale}
          days-before-close: ${git.stale.daysBeforeClose}
          stale-issue-message: >
            This issue has been automatically marked as stale because it has had
            no activity for ${git.stale.daysBeforeIssueStale} days. It will be closed in
            ${git.stale.daysBeforeClose} days unless it is commented on or labeled.
          stale-pr-message: >
            This PR has been automatically marked as stale because it has had
            no activity for ${git.stale.daysBeforePrStale} days.
          exempt-issue-labels: '${git.stale.exemptLabels.join(",")}'
          exempt-pr-labels: '${git.stale.exemptLabels.join(",")}'`;

    default:
      return `# Workflow: ${id}`;
  }
}

export function renderCommitlintYaml(git: GitConfig): string {
  const scopeRule = git.commitlint.scopeAllowlist.length > 0
    ? `  'scope-enum': [2, 'always', [${git.commitlint.scopeAllowlist.map((s) => `'${s}'`).join(", ")}]],`
    : "";
  const scopeRequired = git.commitlint.requireScope
    ? `  'scope-empty': [2, 'never'],`
    : "";
  const bodyRequired = git.commitlint.requireBody
    ? `  'body-empty': [2, 'never'],`
    : "";

  return `// .commitlintrc.js — generated by Helios
// Docs: https://commitlint.js.org
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [${git.commitlint.types.map((t) => `'${t}'`).join(", ")}],
    ],
    'subject-max-length': [2, 'always', ${git.commitlint.maxSubjectLength}],
${scopeRule}
${scopeRequired}
${bodyRequired}
  },
};`;
}

export function renderReleaseRcYaml(git: GitConfig): string {
  if (!git.semanticRelease.enabled) return "// Semantic release disabled";
  const branches = git.semanticRelease.branches
    .map((b) => b === "main" || b === "master" ? `'${b}'` : `{ name: '${b}', prerelease: true }`)
    .join(", ");
  return `// .releaserc.js — generated by Helios
module.exports = {
  branches: [${branches}],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
${git.semanticRelease.generateChangelog ? `    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],` : ""}
    '@semantic-release/git',
${git.semanticRelease.createGitHubRelease ? `    '@semantic-release/github',` : ""}
  ],
};`;
}

export function renderPRTemplate(git: GitConfig): string {
  const s = git.prTemplateSections;
  const sections: string[] = [];

  if (s.summary) sections.push(`## Summary\n\nBriefly describe what this PR does and why.`);
  if (s.motivation) sections.push(`## Motivation\n\nWhat problem does this solve? Link to an issue or context.`);
  if (s.breakingChanges) sections.push(`## Breaking changes\n\n- [ ] This PR introduces breaking changes\n\n<!-- If yes, describe the impact and migration path. -->`);
  if (s.testPlan) sections.push(`## Test plan\n\n- [ ] Unit tests added/updated\n- [ ] Integration tests pass\n- [ ] Manually tested`);
  if (s.screenshots) sections.push(`## Screenshots\n\n<!-- Add before/after screenshots if the change affects the UI. -->`);
  if (s.relatedIssues) sections.push(`## Related issues\n\nCloses #`);
  if (s.checklist) sections.push(`## Checklist\n\n- [ ] I have read the CONTRIBUTING guide\n- [ ] My code follows the project style guidelines\n- [ ] I have added/updated documentation where needed\n- [ ] All CI checks pass`);

  return sections.join("\n\n");
}

export function renderDependabotYaml(_git: GitConfig): string {
  return `# .github/dependabot.yml — generated by Helios
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      actions:
        patterns: ["*"]

  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    groups:
      production-dependencies:
        dependency-type: "production"
      development-dependencies:
        dependency-type: "development"
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
`;
}

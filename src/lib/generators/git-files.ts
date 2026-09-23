import type { GeneratedFile, StackConfig } from "./types";
import type { GitConfig, WorkflowId } from "../git-config";
import {
  renderWorkflowYaml,
  renderCommitlintYaml,
  renderReleaseRcYaml,
  renderPRTemplate,
  renderDependabotYaml,
} from "../git-config";

export function gitWorkflowFiles(config: StackConfig, git: GitConfig): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const lang = config.language;

  const workflowIds: WorkflowId[] = [
    "pr-check", "release", "deploy-staging", "deploy-prod",
    "dep-scan", "secret-scan", "stale",
  ];

  for (const id of workflowIds) {
    const w = git.workflows.find((wf) => wf.id === id);
    if (w && !w.enabled) continue;
    files.push({
      path: `.github/workflows/${id}.yml`,
      content: renderWorkflowYaml(id, git, lang),
    });
  }

  // Dependabot config
  files.push({
    path: ".github/dependabot.yml",
    content: renderDependabotYaml(git),
  });

  // PR template
  const prContent = renderPRTemplate(git);
  if (prContent) {
    files.push({
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      content: prContent,
    });
  }

  // CODEOWNERS
  if (git.codeowners.trim()) {
    files.push({
      path: ".github/CODEOWNERS",
      content: git.codeowners,
    });
  }

  // Commitlint config
  if (git.husky.commitMsgLint) {
    files.push({
      path: ".commitlintrc.js",
      content: renderCommitlintYaml(git),
    });
  }

  // Husky hooks
  if (git.husky.enabled) {
    files.push({
      path: ".husky/pre-commit",
      content: `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

${git.husky.preCommitCommands.join("\n")}
`,
      mode: 0o755,
    });

    if (git.husky.commitMsgLint) {
      files.push({
        path: ".husky/commit-msg",
        content: `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no -- commitlint --edit "\${1}"
`,
        mode: 0o755,
      });
    }

    if (git.husky.prePushCommands.length > 0) {
      files.push({
        path: ".husky/pre-push",
        content: `#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

${git.husky.prePushCommands.join("\n")}
`,
        mode: 0o755,
      });
    }
  }

  // Semantic release config
  if (git.semanticRelease.enabled) {
    files.push({
      path: ".releaserc.js",
      content: renderReleaseRcYaml(git),
    });
  }

  // .github/ISSUE_TEMPLATE/
  files.push({
    path: ".github/ISSUE_TEMPLATE/bug_report.md",
    content: `---
name: Bug report
about: Report a bug so we can fix it
title: '[Bug] '
labels: 'bug'
assignees: ''
---

## Describe the bug
A clear description of what the bug is.

## Steps to reproduce
1. Go to '...'
2. Do '...'
3. See error

## Expected behavior
What you expected to happen.

## Environment
- Version:
- OS:
- Browser (if applicable):
`,
  });

  files.push({
    path: ".github/ISSUE_TEMPLATE/feature_request.md",
    content: `---
name: Feature request
about: Suggest a new feature or improvement
title: '[Feature] '
labels: 'enhancement'
assignees: ''
---

## Problem
What problem does this feature solve?

## Proposed solution
Describe your proposed solution clearly.

## Alternatives considered
Any alternative approaches you've considered?

## Additional context
Screenshots, links, or other context.
`,
  });

  return files;
}

import type { StackConfig } from "../types";
import { safeName } from "../types";

/**
 * Returns the `buf.yaml` + `buf.gen.yaml` + a Makefile proto target.
 *
 * We pick `buf` over raw protoc because:
 *   - One yaml config instead of a brittle shell command per language
 *   - Built-in lint/breaking-change detection (useful when the entity schema evolves)
 *   - Deterministic plugin pinning via the BSR remote plugins
 */
export function bufFiles(config: StackConfig): { path: string; content: string }[] {
  const name = safeName(config.name);
  const pkgDir = name.replace(/-/g, "_");

  // Per-language output plugin list. We emit config for the *selected* language
  // so the generated buf.gen.yaml isn't polluted with plugins the user doesn't need.
  const plugins: string[] = [];
  switch (config.language) {
    case "go":
      plugins.push(
        "  - remote: buf.build/protocolbuffers/go:v1.36.2",
        "    out: gen/go",
        "    opt: paths=source_relative",
        "  - remote: buf.build/grpc/go:v1.5.1",
        "    out: gen/go",
        "    opt: paths=source_relative"
      );
      break;
    case "typescript":
      plugins.push(
        "  - remote: buf.build/bufbuild/es:v2.2.3",
        "    out: gen/ts",
        "    opt: target=ts",
        "  - remote: buf.build/connectrpc/es:v1.6.1",
        "    out: gen/ts",
        "    opt: target=ts"
      );
      break;
    case "python":
      plugins.push(
        "  - remote: buf.build/protocolbuffers/python:v28.2",
        "    out: gen/python",
        "  - remote: buf.build/grpc/python:v1.67.1",
        "    out: gen/python"
      );
      break;
    default:
      plugins.push(
        "  # Language-specific plugins for this stack aren't wired up yet.",
        "  # Add them here per https://buf.build/docs/generate/overview."
      );
  }

  return [
    {
      path: "buf.yaml",
      content: `version: v2
modules:
  - path: proto
lint:
  use:
    - DEFAULT
breaking:
  use:
    - FILE
`,
    },
    {
      path: "buf.gen.yaml",
      content: `version: v2
plugins:
${plugins.join("\n")}
`,
    },
    {
      path: "Makefile",
      content: `# Proto codegen targets — require \`buf\` (https://buf.build/docs/installation).
# CI installs buf automatically; run these locally after editing proto/.

.PHONY: proto proto-lint proto-breaking clean-proto

proto:
	buf generate

proto-lint:
	buf lint

# Compare against the last pushed version of main to catch breaking changes.
proto-breaking:
	buf breaking --against '.git#branch=main'

clean-proto:
	rm -rf gen/
`,
    },
  ];
}

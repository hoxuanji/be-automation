import { commonFiles } from "./common";
import { goFiles } from "./go";
import { typescriptFiles } from "./typescript";
import { pythonFiles } from "./python";
import { rustFiles, javaFiles, kotlinFiles } from "./others";
import type { Endpoint, GeneratedFile, StackConfig } from "./types";

export function generate(
  config: StackConfig,
  endpoints: Endpoint[]
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  files.push(...commonFiles(config, endpoints));

  switch (config.language) {
    case "go":
      files.push(...goFiles(config, endpoints));
      break;
    case "typescript":
      files.push(...typescriptFiles(config, endpoints));
      break;
    case "python":
      files.push(...pythonFiles(config, endpoints));
      break;
    case "rust":
      files.push(...rustFiles(config, endpoints));
      break;
    case "java":
      files.push(...javaFiles(config, endpoints));
      break;
    case "kotlin":
      files.push(...kotlinFiles(config, endpoints));
      break;
  }

  // Stable sort for deterministic zip contents
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export type { GeneratedFile } from "./types";

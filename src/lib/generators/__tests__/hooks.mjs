import { resolve as resolvePath } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const srcDir = resolvePath(fileURLToPath(import.meta.url), "../../../../");

function toFilePath(specifier, parentURL) {
  if (specifier.startsWith("file://")) return fileURLToPath(specifier);
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (parentURL) {
      const resolved = new URL(specifier, parentURL);
      return fileURLToPath(resolved);
    }
    return resolvePath(specifier);
  }
  return specifier;
}

function tryTsExtensions(filePath, context, nextResolve) {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = filePath + ext;
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, context);
    }
  }
  return nextResolve(pathToFileURL(filePath).href, context);
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const mapped = resolvePath(srcDir, specifier.slice(2));
    return tryTsExtensions(mapped, context, nextResolve);
  }
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("file://")
  ) {
    const filePath = toFilePath(specifier, context.parentURL);
    if (existsSync(filePath)) {
      return nextResolve(pathToFileURL(filePath).href, context);
    }
    return tryTsExtensions(filePath, context, nextResolve);
  }
  return nextResolve(specifier, context);
}

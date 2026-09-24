"use client";

// Self-hosted Monaco: bundle the pinned `monaco-editor` package instead of
// letting @monaco-editor/react fetch it from cdn.jsdelivr.net at runtime.
// Import this module only via next/dynamic({ ssr: false }) — monaco touches
// `window` at import time.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url), { type: "module" });
      case "css":
      case "scss":
      case "less":
        return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url), { type: "module" });
      case "html":
      case "handlebars":
      case "razor":
        return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url), { type: "module" });
      case "typescript":
      case "javascript":
        return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url), { type: "module" });
      default:
        return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" });
    }
  },
};

loader.config({ monaco });

export { default } from "@monaco-editor/react";

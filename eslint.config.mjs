import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // `next lint` ignored these by default; the eslint CLI does not.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      // Allow _-prefixed args/vars to signal intentionally-unused parameters
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Generator files assign to `module` as a local variable (Go module path),
      // not the CommonJS global — disable the Next.js rule for these files.
      "@next/next/no-assign-module-variable": "off",
    },
  },
]);

export default eslintConfig;

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
      // ponytail: React Compiler rules new in eslint-plugin-react-hooks v7
      // (via eslint-config-next 16). Off to keep lint parity with Next 15;
      // re-enable and fix the ~20 existing hits as a follow-up.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/use-memo": "off",
    },
  },
]);

export default eslintConfig;

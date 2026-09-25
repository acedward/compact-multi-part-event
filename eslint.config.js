import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "build/",
      ".cache/",
      "contract-examples/*/managed/",
      "contract-examples/*/dist/",
      "contract-examples/*/node_modules/",
      "tests/contracts/managed/",
      // Parked until the CLI is ported to the reader and publisher (plan P1-B).
      "src/cli/",
      "deploy-tools/commands.ts",
      "deploy-tools/config.ts",
      "deploy-tools/contracts.ts",
      "deploy-tools/main.ts",
      "tests/cli-commands.test.ts",
      "tests/helpers/offline-services.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      eqeqeq: "error",
    },
  },
  {
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", console: "readonly", process: "readonly" },
    },
  },
  prettier,
);

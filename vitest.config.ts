import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The consumer example imports the library by its package name, as an external
    // project does; inside this repository those names resolve to the sources.
    alias: [
      {
        find: /^compact-multi-segment-emit\/codec\/raw-transaction$/,
        replacement: source("./src/codec/raw-transaction.ts"),
      },
      { find: /^compact-multi-segment-emit\/codec$/, replacement: source("./src/codec/index.ts") },
      {
        find: /^compact-multi-segment-emit\/transaction$/,
        replacement: source("./src/transaction/index.ts"),
      },
      {
        find: /^compact-multi-segment-emit\/contract$/,
        replacement: source("./src/contract/index.ts"),
      },
      {
        find: /^compact-multi-segment-emit\/adapters$/,
        replacement: source("./src/adapters/index.ts"),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

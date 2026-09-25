import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // The notice-board example imports the library by its package name, as an external
    // project does; inside this repository those names resolve to the sources.
    alias: [
      {
        find: /^compact-multi-segment-emit\/reader$/,
        replacement: source("./src/reader/index.ts"),
      },
      {
        find: /^compact-multi-segment-emit\/publisher$/,
        replacement: source("./src/publisher/index.ts"),
      },
      {
        find: /^compact-multi-segment-emit\/indexer$/,
        replacement: source("./src/indexer/index.ts"),
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

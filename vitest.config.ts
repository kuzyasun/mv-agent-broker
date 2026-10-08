import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // Deterministic core: no fake timers by default; tests inject manual clocks.
    testTimeout: 20_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});

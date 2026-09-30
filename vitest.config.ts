import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Deterministic core: no fake timers by default; tests inject manual clocks.
    testTimeout: 20_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});

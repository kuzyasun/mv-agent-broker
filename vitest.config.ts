import { configDefaults, defineConfig } from "vitest/config";

// Tests that spawn native provider CLIs or the Windows job-object helper need
// the developer machine's environment (installed providers, fast PowerShell
// startup). CI runners have none of that, so they are skipped there.
const DEV_MACHINE_ONLY = [
  "tests/unit/cursor-adapter.test.ts",
  "tests/unit/claude-adapter.test.ts",
  "tests/unit/zcode-adapter.test.ts",
  "tests/unit/zcode-quota.test.ts",
  "tests/unit/antigravity-adapter.test.ts",
  "tests/unit/headless-infra.test.ts",
  "tests/unit/windows-job.test.ts",
  "tests/unit/native-readiness.test.ts",
  "tests/unit/worktree-provisioning.test.ts",
  "tests/integration/native-feedback-harness.test.ts",
];

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: process.env.AB_SKIP_NATIVE_TESTS === "1"
      ? [...configDefaults.exclude, ...DEV_MACHINE_ONLY]
      : configDefaults.exclude,
    environment: "node",
    // Deterministic core: no fake timers by default; tests inject manual clocks.
    testTimeout: 20_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});

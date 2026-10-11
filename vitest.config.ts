import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    // tests/perf/ is excluded: its benches assert absolute-time thresholds
    // and flake when run in parallel with the unit files (worker contention
    // inflates timings). `bun run test` runs this suite, then the perf suite
    // sequentially via vitest.perf.config.ts — see package.json.
    exclude: ["tests/perf/**", "**/node_modules/**"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // The 5,001-activation lifecycle regression has no timing assertion, but
    // competing transforms can exhaust its unchanged five-second deadline.
    // Ordered projects keep it and the unchanged subprocess compiler gate in
    // every full run, before parallel unit work starts. Positive orders avoid
    // Vitest's special trailing group for
    // order zero when maxWorkers=1. CLI overrides and deadlines still apply.
    projects: [
      {
        extends: true,
        test: {
          name: "registry-churn",
          include: ["tests/plugins/registry-churn.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "native-suite-typecheck",
          include: ["tests/native-suite-typecheck.test.ts"],
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts", "tests/**/*.bench.ts"],
          exclude: ["tests/plugins/registry-churn.test.ts", "tests/native-suite-typecheck.test.ts"],
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, "src/lib"),
    },
  },
});

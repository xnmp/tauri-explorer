import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import { resolve } from "path";

/**
 * Perf benchmarks run under their own config: one file at a time with no
 * worker parallelism, so their absolute-time thresholds measure the code
 * rather than scheduler contention from the unit suite running alongside.
 * Invoked by `bun run test:perf` (and by `bun run test` after the unit
 * suite); see vitest.config.ts for the matching exclusion.
 */
export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ["tests/perf/**/*.test.ts", "tests/perf/**/*.bench.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, "src/lib"),
    },
  },
});

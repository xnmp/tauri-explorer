import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";
import { resolve } from "path";
import { SERIAL_UNIT_FILES } from "./tests/serial-unit-files";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    // tests/perf/ is excluded: its benches assert absolute-time thresholds
    // and flake when run in parallel with the unit files (worker contention
    // inflates timings). `bun run test` runs this suite, then the perf suite
    // sequentially via vitest.perf.config.ts — see package.json.
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Hundreds of cold Svelte transforms otherwise contend across every core,
    // exhausting behavior-test timers. Keep the default bounded like browser
    // tests; explicit Vitest --maxWorkers overrides still take precedence.
    maxWorkers: 4,
    // Two unchanged files whose deadlines are sensitive to scheduler
    // contention (the 5,001-activation registry churn and the graph-lineage
    // hover budget) run in the sequential perf config instead (#1123).
    include: ["tests/**/*.test.ts", "tests/**/*.bench.ts"],
    exclude: [...SERIAL_UNIT_FILES, "tests/perf/**", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, "src/lib"),
    },
  },
});

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
    include: ["tests/**/*.test.ts", "tests/**/*.bench.ts"],
    exclude: ["tests/perf/**", "**/node_modules/**"],
    environment: "node",
    setupFiles: ["./tests/setup.ts", "./tests/runner-setup.ts"],
    // Hundreds of cold Svelte transforms otherwise contend across every core,
    // exhausting behavior-test timers. Keep the default bounded like browser
    // tests; explicit Vitest --maxWorkers overrides still take precedence.
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      $lib: resolve(__dirname, "src/lib"),
    },
  },
});

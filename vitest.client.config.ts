import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

/**
 * Client-compiled Svelte runtime tests (`*.client-test.ts`). The default
 * suite is transformed as SSR, where `$effect` never runs, so reactivity
 * contracts (what a store command or getter subscribes an effect to) can only
 * be observed here. Run with `bun run test:client`; `bun run test` includes it.
 */
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: resolve(__dirname, "tests/helpers/client-env.mts"),
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.client-test.ts"],
    maxWorkers: 2,
  },
  resolve: {
    alias: { $lib: resolve(__dirname, "src/lib") },
    conditions: ["browser"],
  },
});

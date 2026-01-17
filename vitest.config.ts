import { defineConfig } from "vitest/config";
import { sveltekit } from "@sveltejs/kit/vite";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.bench.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      $lib: "/home/chong/Repos/tauri-explorer/src/lib",
    },
  },
});

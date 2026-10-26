import { defineConfig, loadEnv, type Plugin } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { releaseHookGuard } from "./scripts/release-hook-leaks.mjs";
import { e2eBrowserBuild } from "./scripts/e2e-browser-build.mjs";

// KaTeX's stylesheet lists woff2, woff and ttf for every face; every webview
// Tauri targets supports woff2, so drop the fallbacks and ship a third of the
// font bytes (#1393).
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/katex[\\/]dist[\\/]katex(\.min)?\.css$/.test(id.split("?")[0])) return null;
      return code.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
    },
  };
}

const host = process.env.TAURI_DEV_HOST;
const port = parseInt(process.env.DEV_PORT || "1420", 10);
// The browser-test bundle served to CI's Playwright shards (#1381). It may
// bundle src/test-support modules that specs import, so the release guard
// treats it like a hook build; release builds never set this.
const browserTestBuild = process.env.E2E_BROWSER_BUILD === "1";

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [
    sveltekit(),
    katexWoff2Only(),
    // A build without VITE_E2E_HOOKS=1 fails if it bundles src/test-support (#884).
    releaseHookGuard({
      hooksEnabled:
        browserTestBuild || loadEnv(mode, process.cwd(), "VITE_").VITE_E2E_HOOKS === "1",
    }),
    e2eBrowserBuild({ enabled: browserTestBuild }),
  ],

  // The app's own `import.meta.env.DEV` diagnostics (startup console summary,
  // PDF worker receipts, shortcut-conflict warnings) behave as on the dev
  // server, which specs were written against. Svelte and SvelteKit still
  // compile and resolve for production; only this literal changes.
  define: browserTestBuild ? { "import.meta.env.DEV": "true" } : {},
  // Hidden maps (no sourceMappingURL comment) let the dev-push impact map
  // attribute bundle coverage to source lines (#1386); release builds emit none.
  build: browserTestBuild ? { sourcemap: "hidden" as const } : {},

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    warmup: {
      clientFiles: [
        "src/routes/+page.svelte",
        "src/lib/components/*.svelte",
      ],
    },
  },
}));

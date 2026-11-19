// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The marketing site's embedded demo (`bun run build:demo`) is served under
// /app/ next to the site pages, from its own output directory
// (scripts/build-demo.mjs builds into SITE_DEMO_OUT, then swaps it in).
const siteDemo = process.env.VITE_SITE_DEMO === "1";
const output = siteDemo ? process.env.SITE_DEMO_OUT || "build-demo" : "build";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Embedded assets ship with the desktop release. SvelteKit's default build
    // timestamp rotates chunk hashes and gzip sizes even when source is unchanged.
    version: { name: version },
    adapter: adapter({
      pages: output,
      assets: output,
      fallback: "index.html",
    }),
    ...(siteDemo ? { paths: { base: "/app" } } : {}),
  },
};

export default config;

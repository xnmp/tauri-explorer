# Serving browser E2E from a prebuilt bundle (#1381)

CI's browser shards serve one `E2E_BROWSER_BUILD=1 bun run build` bundle
instead of a Vite dev server per shard. Locally, the same 195 tests took 326 s
of test time on the dev server and 200-207 s on the bundle; a warm navigation to
the first row dropped from ~400 ms to ~200 ms (unbundled modules and on-demand
transforms dominate a page load).

What a plain production bundle broke, and why:

- **Live module imports.** Specs `import("/src/lib/state/window-tabs.svelte.ts")`
  in the page to reach the app's own instance. The build emits each such
  module as an entry chunk and writes a re-exporting module at that URL
  (`scripts/e2e-browser-build.mjs`). A redirect would not work: the module map
  is keyed by request URL, so it would create a second instance.
- **Entry chunks get no CSS preloading.** Vite injects stylesheet loading only
  for the app's dynamic imports; a component mounted through an emitted entry
  rendered unstyled (`plugin-file-tiles.spec.ts`). The URL module awaits the
  chunk's static `importedCss` first.
- **Request interception.** Specs that route `**/FilePicker.svelte*` (fail or
  delay a lazy chunk) or serve a modified source module match nothing in a
  bundle; some failed, others could pass without exercising their case. Any
  spec that intercepts requests, directly or through a local helper, runs on a
  dev server beside the bundle (`e2e/app-server.ts`).
- **`import.meta.env.DEV` gates.** The startup console summary and PDF worker
  receipts that specs read exist only in dev; the flavour defines that literal
  as `true` (Svelte/SvelteKit still build for production).
- **Range requests.** Video seeking needs `206 Partial Content`; the static
  server implements single ranges.

The nightly impact map keeps the dev server: coverage is attributed to
per-module scripts through their inline source maps.

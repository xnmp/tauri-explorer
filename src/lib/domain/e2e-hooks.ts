/**
 * Whether the app registers its end-to-end test hooks — the `e2e-navigate` /
 * `e2e-reset-view` listeners, the `data-e2e-*` readiness markers, and the
 * directory-listing and watcher probes that `e2e-tauri/specs/` drives.
 *
 * These used to ride on `import.meta.env.DEV`, which coupled the tier-3 suite
 * to a *dev-mode* binary — and a dev-mode Tauri binary serves `build.devUrl`,
 * so the suite silently required a Vite dev server running beside it. That
 * coupling hung Windows CI for a month (#457): msedgedriver's `POST /session`
 * waits for the WebView2 page to load, that page was a cold dev server
 * transforming the whole module graph, and once the graph outgrew the 60s
 * `connectionRetryTimeout` the handshake never returned.
 *
 * Making the hooks their own opt-in build flag decouples "can the tests drive
 * the app" from "is this a dev build", so the suite can run against a binary
 * with the frontend embedded — which is also closer to what actually ships.
 *
 * Both operands are statically replaced by Vite, so this folds to `false` in a
 * normal production build and the guarded code is tree-shaken out entirely.
 * Release builds never set `VITE_E2E_HOOKS`; only the smoke workflow does.
 */
export const E2E_HOOKS_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_E2E_HOOKS === "1";

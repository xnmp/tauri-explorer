/**
 * The single frontend gate for end-to-end test hooks (#884).
 *
 * Hooks are the `e2e-*` DOM request listeners, the `data-e2e-*` readiness and
 * receipt markers, and the listing/mutation interceptors that
 * `e2e-tauri/specs/` drives. They are compiled in only when the frontend is
 * built with `VITE_E2E_HOOKS=1`; the Rust side's matching gate is the
 * `e2e-hooks` Cargo feature. Release builds set neither.
 *
 * The gate is deliberately not `import.meta.env.DEV`. That coupled the tier-3
 * suite to a dev-mode binary, which serves `build.devUrl` and so silently
 * needed a Vite dev server beside it; that hung Windows CI for a month (#457).
 * A dev server does not get hooks either: browser Playwright drives the mock
 * backend and needs none.
 *
 * Two rules keep hook code out of release assets:
 *
 * 1. Code that must observe from page start (synchronous DOM publishers in
 *    production modules) guards itself with `E2E_HOOKS_ENABLED`. Vite replaces
 *    the literal below, so every guard folds to `false` and is tree-shaken.
 * 2. Everything else lives in `src/test-support/` and is loaded only by
 *    `loadE2EHooks()` below. A dynamic `import()` must be guarded by a
 *    constant declared in the SAME module: Rollup discovers dynamic chunks
 *    before it folds imported constants, so `if (IMPORTED_FLAG) import(...)`
 *    emits an orphan test chunk into release assets even though nothing can
 *    load it. Keep this the only module that imports `src/test-support/`.
 *
 * A build without the flag fails if it bundles any `src/test-support/` module
 * (the `releaseHookGuard` Vite plugin), and `bun run check:bundle` also fails
 * on hook markers in the emitted scripts (`scripts/release-hook-leaks.mjs`).
 */
export const E2E_HOOKS_ENABLED = import.meta.env.VITE_E2E_HOOKS === "1";

/** Load the test-support entry point, or `null` in builds without hooks. */
export function loadE2EHooks(): Promise<typeof import("../../test-support/e2e-hooks")> | null {
  return E2E_HOOKS_ENABLED ? import("../../test-support/e2e-hooks") : null;
}

/**
 * Windows CI attaches msedgedriver to the main WebView2 through an E2E-only
 * CDP port. Keep initial session attachment free of automatic warm priming.
 * Explicit new-window operations can still prime/replenish the pool; the
 * attach feature injects matching browser arguments for all descendants.
 * Linux retains automatic warm-window priming coverage.
 */
export const E2E_WARM_WINDOW_PRIMING_DISABLED =
  import.meta.env.VITE_E2E_NO_WARM_PRIME === "1";

/**
 * Release-build guard for E2E test hooks (#884).
 *
 * A build without `VITE_E2E_HOOKS=1` must contain no hook code: no chunk
 * built from `src/test-support/` (an orphan chunk appears when a dynamic
 * import is guarded by an imported constant; see `src/lib/api/e2e-hooks.ts`),
 * and no `data-e2e-*` marker or `e2e-*` request event surviving in any
 * emitted script (an inline publisher that escaped `E2E_HOOKS_ENABLED`).
 */

const HOOK_MARKERS = [
  // `document.documentElement.dataset.e2eFoo` survives minification as a
  // property name, so this catches every inline publisher and probe.
  /\be2e[A-Z][A-Za-z]+\b/,
  // Probe request events dispatched by native specs.
  /["'`]e2e-[a-z][a-z-]*["'`]/,
];

/**
 * @param {Record<string, {file: string, src?: string}>} manifest Vite build manifest
 * @param {Array<{file: string, text: string}>} scripts every emitted JS file
 * @returns {string[]} one message per leak; empty when the build is clean
 */
export function findHookLeaks(manifest, scripts) {
  const leaks = [];
  for (const [key, record] of Object.entries(manifest)) {
    const source = record.src ?? key;
    if (source.startsWith("src/test-support/")) {
      leaks.push(`${record.file} is built from test-support module ${source}`);
    }
  }
  for (const { file, text } of scripts) {
    for (const marker of HOOK_MARKERS) {
      const match = marker.exec(text);
      if (match) leaks.push(`${file} contains hook marker ${match[0]}`);
    }
  }
  return leaks;
}

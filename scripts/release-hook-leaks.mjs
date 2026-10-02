/**
 * Release-build guard for E2E test hooks (#884).
 *
 * A build without `VITE_E2E_HOOKS=1` must contain no hook code. Two
 * independent checks enforce that:
 *
 * - `releaseHookGuard()` is a Vite plugin that fails the build itself when
 *   any module under `src/test-support/` is bundled into an emitted chunk.
 *   It reads Rollup's module ids, so it also catches a test-support module
 *   that a static import merged into an ordinary hashed chunk (such a chunk
 *   has no manifest `src`, and a module like `dom-rpc.ts` has no marker).
 * - `findHookLeaks()` (run by `check:bundle`) rejects an orphan chunk whose
 *   manifest source is a test-support module (an orphan appears when a
 *   dynamic import is guarded by an imported constant; see
 *   `src/lib/api/e2e-hooks.ts`) and scans every emitted script for hook
 *   markers that an inline publisher escaping `E2E_HOOKS_ENABLED` leaves.
 */

const TEST_SUPPORT_DIR = "src/test-support/";

const HOOK_MARKERS = [
  // `document.documentElement.dataset.e2eFoo` survives minification as a
  // property name, so this catches every inline publisher and probe
  // (including a one-letter suffix such as `dataset.e2eX`).
  /\be2e[A-Z][A-Za-z]*\b/,
  // The attribute form of the same dataset keys.
  /data-e2e-/,
  // Probe request events dispatched by native specs.
  /["'`]e2e-[a-z][a-z-]*["'`]/,
  // Receipt keys built from a prefix, e.g. `e2e-child-ready:${label}`.
  /["'`]e2e-[a-z][a-z-]*:/,
  // Window globals read only by hook builds, e.g. `__E2E_WEBVIEW_BROWSER_ARGS__`.
  /__E2E_/,
];

/**
 * Normalise a Rollup module id (absolute, possibly `\0`-prefixed or queried).
 * @param {string} moduleId
 */
function isTestSupportModule(moduleId) {
  const path = moduleId.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
  return path.startsWith(TEST_SUPPORT_DIR) || path.includes(`/${TEST_SUPPORT_DIR}`);
}

/**
 * @param {Array<{fileName: string, moduleIds: string[]}>} chunks emitted chunks
 * @returns {string[]} one message per test-support module found in a chunk
 */
export function findTestSupportModules(chunks) {
  return chunks.flatMap(({ fileName, moduleIds }) =>
    moduleIds
      .filter(isTestSupportModule)
      .map((moduleId) => `${fileName} bundles test-support module ${moduleId}`),
  );
}

/**
 * Vite plugin: fail a build made without hooks if it bundles test-support code.
 *
 * @param {{hooksEnabled: boolean}} options
 * @returns {import("vite").Plugin}
 */
export function releaseHookGuard({ hooksEnabled }) {
  return {
    name: "tauri-explorer:release-hook-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      if (hooksEnabled) return;
      const chunks = Object.values(bundle)
        .filter((output) => output.type === "chunk")
        .map((chunk) => ({ fileName: chunk.fileName, moduleIds: Object.keys(chunk.modules) }));
      const leaks = findTestSupportModules(chunks);
      if (leaks.length > 0) {
        this.error(
          "A build without VITE_E2E_HOOKS=1 bundled E2E test-support code " +
            `(see src/lib/api/e2e-hooks.ts):\n  ${leaks.join("\n  ")}`,
        );
      }
    },
  };
}

/**
 * @param {Record<string, {file: string, src?: string}>} manifest Vite build manifest
 * @param {Array<{file: string, text: string}>} scripts every emitted JS file
 * @returns {string[]} one message per leak; empty when the build is clean
 */
export function findHookLeaks(manifest, scripts) {
  const leaks = [];
  for (const [key, record] of Object.entries(manifest)) {
    const source = record.src ?? key;
    if (source.startsWith(TEST_SUPPORT_DIR)) {
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

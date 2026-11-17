/**
 * Release-build guard for the Lightning CSS `light-dark()` polyfill (#1728).
 *
 * Lightning CSS compiles `light-dark()` into `--lightningcss-light` /
 * `--lightningcss-dark` variables that are defined only beside a stylesheet's
 * own `color-scheme` rules. Runtime-loaded user themes never define them, so
 * every surface using `light-dark()` paints nothing. `vite.config.ts` excludes
 * `Features.LightDark`; this check fails the build if the polyfill returns.
 */

const POLYFILL_MARKER = /--lightningcss-(?:light|dark)\b/;

/**
 * @param {ReadonlyArray<{ file: string, text: string }>} stylesheets
 * @returns {string[]} the files containing the polyfill
 */
export function findLightDarkPolyfill(stylesheets) {
  return stylesheets.filter(({ text }) => POLYFILL_MARKER.test(text)).map(({ file }) => file);
}

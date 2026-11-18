/**
 * Release-build guard for the marketing site's embedded demo (`bun run
 * build:demo`, `VITE_SITE_DEMO=1`). `hooks.client.ts` imports the demo boot
 * behind a constant that folds to false in every other build, so none of the
 * demo modules may reach an ordinary build. `check:bundle` runs this on the
 * release output: a manifest record built from a demo module, or a demo
 * marker inlined into an ordinary chunk, fails the build.
 */

const SITE_DEMO_SOURCES = [
  /^src\/lib\/state\/site-demo-/,
  /^src\/lib\/api\/mock-world/,
  /^src\/lib\/domain\/demo-(boot|fixture|shell|protocol)/,
];

const SITE_DEMO_MARKERS = [
  // `document.documentElement.dataset.siteDemo`, set first thing by the boot.
  /\bsiteDemo\b/,
  /data-site-demo/,
  // Every demo log line is prefixed this way.
  /\[site-demo\]/,
];

/**
 * @param {Record<string, {file: string, src?: string}>} manifest Vite build manifest
 * @param {Array<{file: string, text: string}>} scripts every emitted JS file
 * @returns {string[]} one message per leak; empty when the build is clean
 */
export function findSiteDemoLeaks(manifest, scripts) {
  const leaks = [];
  for (const [key, record] of Object.entries(manifest)) {
    const source = record.src ?? key;
    if (SITE_DEMO_SOURCES.some((pattern) => pattern.test(source))) {
      leaks.push(`${record.file} is built from site-demo module ${source}`);
    }
  }
  for (const { file, text } of scripts) {
    for (const marker of SITE_DEMO_MARKERS) {
      const match = marker.exec(text);
      if (match) leaks.push(`${file} contains site-demo marker ${match[0]}`);
    }
  }
  return leaks;
}

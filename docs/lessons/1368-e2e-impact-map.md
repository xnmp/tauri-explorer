# Coverage-based E2E selection: what browser coverage cannot see

The PR test-impact map (#1368) is built from per-test V8 block coverage of
every page a test opens. Several things look covered but are not, and each one
is a silent under-selection if treated as "no test touches this":

- Playwright's `startCSSCoverage` returns no entries for Vite dev styles: they
  arrive as injected `<style>` elements with no `sourceURL`. Style changes
  therefore select by file loading (or ALL), not by rule usage.
- Svelte 5 hoists component templates to module level, and function headers are
  "covered" when the module evaluates. An inserted line is attributed to the
  smallest enclosing executed block excluding its header line; at module scope
  that degrades to every test that loaded the file.
- A spec that imports `test` from `@playwright/test` bypasses `e2e/fixtures.ts`
  and records nothing. `tests/e2e-fixture-imports.test.ts` enforces the import.
- Modules a spec imports on the Node side (`src/lib/api/...` constants, test
  fixtures) never run in the browser. `nodeSideImports` in
  `scripts/e2e-affected.mjs` follows the static import graph from each spec.
- A hunk no Chromium test executed is not proof that nothing depends on it
  (WebKit-only branches, unrecorded serial setup). It falls back to every spec
  that loaded the file, and the WebKit tier runs in full.

Stale or missing maps select exactly as the keyword clusters did; never make a
map fetch failure skip tests.

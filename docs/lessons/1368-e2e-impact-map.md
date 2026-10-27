# Coverage-based E2E selection: what browser coverage cannot see

The PR test-impact map (#1368) is built from per-test V8 block coverage of
every page a test opens. Several things look covered but are not, and each one
is a silent under-selection if treated as "no test touches this":

- Playwright's `startCSSCoverage` returns no entries for Vite dev styles: they
  arrive as injected `<style>` elements with no `sourceURL`. Style changes
  therefore select by file loading (or ALL), not by rule usage.
- Do not narrow below the function. esbuild maps a block's closing brace and
  V8 attributes it to the `then` block, so adding `else`/`else if`/`catch`
  after an existing block looked like code only the `then` tests reached
  (PR #1373 review). A hunk selects every test that entered the innermost
  function around it; a header, closing line, module-level code, markup or
  styles select every loader. Measured on 20 PRs, block level gained almost
  nothing over file level anyway.
- Svelte 5 hoists component templates to module level, and function headers are
  "covered" when the module evaluates: header lines never show who called a
  function, so the function level counts only its body after the line the
  body starts on.
- The project compiles with verbatimModuleSyntax: `import { type A } from "x"`
  is kept as `import {} from "x"` and still evaluates `x`. Only `import type`
  is erased. Removing or reordering imports changes evaluation (Svelte keeps
  unused value imports), so it selects every loader.
- A test whose final attempt failed has truncated coverage: the merge marks
  its spec incomplete, so it always runs.
- A spec that imports `test` from `@playwright/test` bypasses `e2e/fixtures.ts`
  and records nothing. `tests/e2e-fixture-imports.test.ts` enforces the import.
- Modules a spec imports on the Node side (`src/lib/api/...` constants, test
  fixtures) never run in the browser. `nodeSideImports` in
  `scripts/e2e-affected.mjs` follows the static import graph from each spec.
- A hunk no Chromium test executed is not proof that nothing depends on it
  (WebKit-only branches, unrecorded serial setup). It falls back to every spec
  that loaded the file, and the WebKit tier runs in full.

- The map describes the code at its own commit. A dev change after it can
  route a test into the PR's change without the map knowing, so the selector
  also runs the tests that executed code changed between the map's commit and
  the merge base. Diff those two commits directly: the map can be newer than
  a PR's base, and their merge base is then the base itself (an empty diff).
- "Inert" proofs need the whole binding, not the specifier: `import { a as b }`
  replacing `import { b }` keeps the module and changes behaviour. New object
  members are never inert (enumeration, spreads and getters reach them), and
  a function header placed by its callers must keep its export/accessor shape.

Stale or missing maps select exactly as the keyword clusters did; never make a
map fetch failure skip tests.

## Fewer runners (phase 2)

Two Playwright workers per runner suit Chromium (2 shards in about 9.5 min,
no new flakes) but not WebKit: three 2-worker WebKit shards hit the 40-minute
global timeout with timing failures in folder-peek and preview specs. WebKit
per-test time is rendering, not module loading, so it parallelises poorly on a
2-vCPU runner. Measure a worker change per engine before applying it.

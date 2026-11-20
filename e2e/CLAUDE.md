# Browser Playwright test rules

These specs run against `mock-invoke.ts` and are blind to backend timing (root
`CLAUDE.md`, three test tiers). Write PNG evidence only under
`CAPTURE_EVIDENCE=1` (`e2e/evidence-shots.ts`). Feature rules for the
components under test: `src/lib/components/CLAUDE.md`.

## Locators and readiness

- Pane focus is state: assert on `.explorer-pane.active`, not on `document.activeElement`. Retained tabs stay mounted as hidden `.pane-tree.retained` layers (#1173): scope locators to the shown tab (`.pane-tree:not(.retained)` or Playwright `:visible`).
- Settings browser tests must target named controls (for example `.color-theme-select`), not `select.first()`: async language-model settings insert earlier selects, changing the positional locator's identity between focus and assertion (#1010).
- Column visibility tests must assert mounted row cells as well as headers: they render independently. Require nonempty rows, then check each column before hiding, while hidden, and after restoring (#993).
- Multi-step WebKit interaction tests must wait for an opened modal to become hidden after Escape before focusing the next surface; otherwise the following shortcut can correctly be rejected while `hasModalOpen` is still true.
- Keep clock-exact debounce coverage in fake-timer domain tests: an E2E runner may stall between synthetic keystrokes for longer than the debounce and legitimately start an intermediate query, so contract-level final-query tests should update the input atomically.
- Modal evidence (for example About, #755) must finish CSS animations (`page.screenshot({ animations: "disabled", ... })`): a visible DOM assertion can succeed on the first transparent frame of the shared modal fade.
- Marquee tests read the band through `getBoundingClientRect()`, which includes the transform, and sample pixels at 130% zoom (#1051).

## Clocks

Playwright `page.clock.install()` still advances with real time. Tests that
assert exact elapsed or remaining labels must install a fixed time and pause
after page readiness, then advance only with `runFor()`; otherwise flooring
can turn an expected 20s remaining into 19s without any application defect.

Tiles Folder Peek motion probes must control both rAF and `performance.now()`
through Playwright's clock. Six wall-clock frames can outlast the entire 150ms
motion on loaded WebKit runners. Install before navigation, pause after initial
layout settles, then advance the clock while the page-side sampler is pending;
retain the intermediate-height, inert-ghost and reduced-motion assertions (#1275).

## Peek and List geometry

Spring peek state becomes observable before its List card finishes opening.
Synthetic drag probes that target row edges must await populated rows and the
end of live List motion before reading hit-test coordinates; a bounding box
can include pixels still clipped by the opening card (#1292). Rows also
hit-test before the first rendered frame, whose ResizeObserver delivery sizes
the List (until then it flows at its 4-row floor): settle across rendered
frames, not DOM visibility (#1388).

List peek lineage includes the card's outer folder as well as nested groups.
Geometry assertions must select the guide for the intended depth; the first
`.list-guide` now belongs to the card root. Scroll nested children into the card's
viewport before capturing lineage evidence (#1330).

## HTML preview CSP

For HTML preview CSP browser tests, route the forbidden image to a valid fixture
and assert it never reaches the route plus completed/zero-natural-width image
state. WebKit omits `requestfailed` events for CSP and blocks asynchronous
callbacks injected into a script-disabled sandbox; neither is a portable oracle.

## Scenario budgets

The video-marker theme matrix splits view-mode markers, preview transitions and
large-Tiles refresh into independent tests (#1864). Do not fold them back into
one theme-wide scenario: WebKit's cumulative action time exhausted the default
30-second test budget at the final refresh even while that row was actionable.

/**
 * Backward (Shift+Tab) traversal out of the file-list composite, qualified per
 * browser engine.
 *
 * This spec deliberately holds two separable things apart:
 *
 *  1. **Engine qualification** — bare `setContent` pages with no application
 *     code, establishing what Playwright's automation actually delivers and how
 *     each engine resolves the sequential-navigation starting point.
 *  2. **The application contract** — that leaving the file-list cursor with
 *     Shift+Tab reaches the preceding sequential control.
 *
 * Selection retention, cursor reveal and forward Tab re-entry are *not* covered
 * here; they are the file-list composite's own contract and live in
 * `e2e/file-list-focus.spec.ts` (ADR 0015). Backward traversal must never be
 * inferred from those tests, nor they from this one.
 *
 * Playwright WebKit is an automation proxy for WKWebView, not WKWebView itself,
 * and never evidence for native WebKitGTK. See
 * `docs/lessons/692-webkit-backward-focus-qualification.md`.
 */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries, type ViewMode } from "./helpers";

const HOME_PATH = "/home/user";

/** Report the active element in a form that is stable across engines. */
async function activeDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return "(body)";
    const classes = (element.className ?? "").toString().split(" ")
      .filter((name) => name && !name.startsWith("svelte-")).slice(0, 3).join(".");
    return `${element.tagName}${element.id ? `#${element.id}` : ""}${classes ? `.${classes}` : ""}`;
  });
}

// ===========================================================================
// 1. Engine qualification — no application code involved.
// ===========================================================================

test.describe("backward traversal engine qualification", () => {
  const PROBE_PAGE = `
    <button id="before">Before</button>
    <div id="target" tabindex="0" role="gridcell">Target cell</div>
    <button id="after">After</button>
    <output id="events"></output>
    <script>
      const events = [];
      document.addEventListener("keydown", (event) => {
        events.push({ key: event.key, shiftKey: event.shiftKey, defaultPrevented: event.defaultPrevented });
        document.querySelector("#events").textContent = JSON.stringify(events);
      });
    </script>
  `;

  test("automation delivers a real, unprevented Shift+Tab", async ({ page, browserName }) => {
    await page.setContent(PROBE_PAGE);
    await page.evaluate(() => document.getElementById("after")!.focus());

    await page.keyboard.press("Shift+Tab");

    // The event itself is ordinary on every engine: a Tab key, Shift held, and
    // nothing in the page prevented the default action.
    await expect(page.locator("#events")).toHaveText(/"key":"Tab"/);
    await expect(page.locator("#events")).toHaveText(/"shiftKey":true/);
    await expect(page.locator("#events")).toHaveText(/"defaultPrevented":false/);
    await test.info().attach("engine.json", {
      body: JSON.stringify({ browserName, browserVersion: page.context().browser()?.version() }),
      contentType: "application/json",
    });
  });

  test("a keyboard-entered control traverses backward on every engine", async ({ page }) => {
    await page.setContent(PROBE_PAGE);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#target")).toBeFocused();

    await page.keyboard.press("Shift+Tab");

    await expect(page.locator("#before")).toBeFocused();
  });

  test("a programmatically focused control traverses backward on every engine", async ({ page }) => {
    await page.setContent(PROBE_PAGE);
    await page.evaluate(() => document.getElementById("target")!.focus());
    await expect(page.locator("#target")).toBeFocused();

    await page.keyboard.press("Shift+Tab");

    await expect(page.locator("#before")).toBeFocused();
  });

  test("a pointer-clicked control traverses backward only on Chromium", async ({ page, browserName }) => {
    // WebKit resolves the sequential-navigation starting point from the clicked
    // node rather than from the focused element, so backward traversal restarts
    // inside the control that the click landed in. Forward traversal (asserted
    // below) is unaffected, and neither route involves any application code:
    // this page is three inert controls.
    test.fail(browserName === "webkit", "WebKit derives its backward starting point from the clicked node");
    await page.setContent(PROBE_PAGE);
    await page.locator("#after").click();
    await expect(page.locator("#after")).toBeFocused();

    await page.keyboard.press("Shift+Tab");

    await expect(page.locator("#target")).toBeFocused();
  });

  test("forward traversal after a pointer click is unaffected on every engine", async ({ page }) => {
    // Establishes that the click does not break sequential navigation as such —
    // only its backward starting point differs.
    await page.setContent(PROBE_PAGE);
    await page.locator("#target").click();
    await expect(page.locator("#target")).toBeFocused();

    await page.keyboard.press("Tab");

    await expect(page.locator("#after")).toBeFocused();
  });
});

// ===========================================================================
// 2. Application contract — the file-list composite.
// ===========================================================================

/** Insert an inert control immediately before the row viewport, so the test
 *  asserts an exact backward destination instead of "something else". */
async function addPrecedingControl(page: Page): Promise<void> {
  await page.locator(".file-list .virtual-viewport").evaluate((viewport) => {
    const before = document.createElement("button");
    before.id = "backward-focus-before";
    before.textContent = "Before file list";
    before.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:1;padding:8px 12px";
    viewport.before(before);
  });
}

/** Enter the composite the way a keyboard user does: Tab in from the control
 *  that precedes it. This also gives the cursor row `:focus-visible`. */
async function tabIntoFileList(page: Page): Promise<void> {
  await page.locator("#backward-focus-before").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".file-list .entry-item:focus")).toHaveCount(1);
}

for (const viewMode of ALL_VIEW_MODES) {
  test.describe(`file-list backward traversal [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/?path=${encodeURIComponent(HOME_PATH)}&viewMode=${viewMode}`);
      await waitForEntries(page);
      await expect(page.locator(`.${viewMode}-view`)).toBeVisible();
      await addPrecedingControl(page);
    });

    test("Shift+Tab leaves the keyboard-entered cursor for the preceding control", async ({ page }) => {
      await tabIntoFileList(page);
      const cursorPath = await page.locator(".file-list .entry-item:focus").getAttribute("data-path");
      expect(cursorPath).toBeTruthy();

      await page.keyboard.press("Shift+Tab");

      await expect(page.locator("#backward-focus-before"),
        `backward traversal must reach the preceding control (was ${await activeDescriptor(page)})`).toBeFocused();
      // Departure must not disturb the cursor: exactly one row stays tabbable,
      // and it is the row the cursor was on.
      expect(await page.locator(".file-list").evaluate((list) => [...list
        .querySelectorAll<HTMLElement>(".entry-item")]
        .filter((row) => row.tabIndex === 0)
        .map((row) => row.dataset.path))).toEqual([cursorPath]);
    });

    test("Shift+Tab leaves a pointer-selected cursor for the preceding control", async ({ page, browserName }) => {
      // Same application path as above; only the way the cursor was acquired
      // differs. The engine qualification above reproduces this WebKit
      // divergence on an inert page, so it is not an application routing fault
      // and no Tab handler is added to compensate for it.
      test.fail(browserName === "webkit", "WebKit derives its backward starting point from the clicked node");
      const row = page.locator(".file-list .entry-item").nth(1);
      await row.click();
      await expect(row).toBeFocused();

      await page.keyboard.press("Shift+Tab");

      await expect(page.locator("#backward-focus-before"),
        `backward traversal must reach the preceding control (was ${await activeDescriptor(page)})`).toBeFocused();
    });
  });
}

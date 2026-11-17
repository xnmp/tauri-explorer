/**
 * Ctrl+T keeps the selection highlight and the row's focus-ring state (#1729).
 *
 * A new tab is seeded with the source tab's rows, but it selected nothing
 * until its own listing settled, so the highlight dropped for a frame or more
 * (most visible in Tiles). The seeded pane now selects the row the listing
 * would pick at creation. A rAF sampler counts the shown tab's selected rows
 * in every frame from the keypress until the listing has settled.
 *
 * The restored row focus is script focus that follows a key press, which
 * WebKit (WKWebView) treats as `:focus-visible`: the full keyboard ring
 * flashed after a pointer selection. Neither Playwright engine reproduces that
 * heuristic, so these specs assert the `focusVisible` option the app requests:
 * the ring state of the row that last had focus.
 */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings } from "./helpers";

const DIR = "/home/user/Documents";
/** Long enough that several frames pass before the new tab's listing settles. */
const LISTING_LATENCY_MS = 400;
const LISTING_COMMANDS = ["list_directory", "list_directory_fresh", "start_observed_directory", "list_directory_stream"];

const shownRows = (page: Page) => page.locator(".pane-tree:not(.retained) .entry-item");

interface Frame { tabs: number; selected: number; selectedPath: string | null }

/** Records the shown tab's selection in every animation frame until stopped. */
async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    let running = true;
    const tick = () => {
      if (!running) return;
      const selected = document.querySelectorAll<HTMLElement>(".pane-tree:not(.retained) .entry-item.selected");
      frames.push({
        tabs: document.querySelectorAll(".tab").length,
        selected: selected.length,
        selectedPath: selected[0]?.dataset.path ?? null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as any).__stopFrameSampler = () => { running = false; return frames; };
  });
}

const stopFrameSampler = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => (window as any).__stopFrameSampler());

/** Every listing request after this call waits LISTING_LATENCY_MS. */
async function slowListings(page: Page): Promise<void> {
  await page.evaluate(({ commands, ms }) => {
    const control = ((window as any).__mockControl ??= {});
    control.latency = { ...(control.latency ?? {}), ...Object.fromEntries(commands.map((cmd: string) => [cmd, ms])) };
  }, { commands: LISTING_COMMANDS, ms: LISTING_LATENCY_MS });
}

/** Records each script focus of a row with the options it was given. */
async function recordRowFocus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: { path: string | undefined; focusVisible: boolean | undefined }[] = [];
    (window as any).__rowFocusCalls = calls;
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions & { focusVisible?: boolean }) {
      if (this.matches(".entry-item")) calls.push({ path: this.dataset.path, focusVisible: options?.focusVisible });
      return focus.call(this, options);
    };
  });
}

const rowFocusCalls = (page: Page) =>
  page.evaluate(() => [...(window as any).__rowFocusCalls] as { path: string | undefined; focusVisible: boolean | undefined }[]);

async function open(page: Page, viewMode: string): Promise<void> {
  await seedSettings(page, { viewMode });
  await page.goto(`/?path=${DIR}`);
  await expect(shownRows(page).first()).toBeVisible();
  // The first listing selects its first row.
  await expect(page.locator(".pane-tree:not(.retained) .entry-item.selected")).toHaveCount(1);
}

for (const viewMode of ALL_VIEW_MODES) {
  test(`${viewMode}: Ctrl+T keeps a row selected in every frame`, async ({ page }) => {
    await open(page, viewMode);
    const selectedBefore = await page.locator(".pane-tree:not(.retained) .entry-item.selected").getAttribute("data-path");
    await slowListings(page);
    await startFrameSampler(page);
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    // Past the new tab's listing, which publishes its own selection.
    await page.waitForTimeout(LISTING_LATENCY_MS + 400);
    const frames = (await stopFrameSampler(page)).filter((frame) => frame.tabs === 2);

    expect(frames.length).toBeGreaterThan(5);
    const dropped = frames.filter((frame) => frame.selected !== 1);
    expect(dropped, `frames without exactly one selected row: ${JSON.stringify(dropped.slice(0, 5))}`).toEqual([]);
    // The seeded row is the one the listing picks: the selection never moves.
    expect(new Set(frames.map((frame) => frame.selectedPath))).toEqual(new Set([selectedBefore]));
  });
}

test("a click before the new tab's listing settles keeps the clicked row", async ({ page }) => {
  await open(page, "details");
  await slowListings(page);
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  const target = shownRows(page).nth(2);
  const path = await target.getAttribute("data-path");
  await target.click();
  await page.waitForTimeout(LISTING_LATENCY_MS + 400);
  await expect(page.locator(".pane-tree:not(.retained) .entry-item.selected")).toHaveCount(1);
  await expect(page.locator(".pane-tree:not(.retained) .entry-item.selected")).toHaveAttribute("data-path", path!);
});

const clearRowFocusCalls = (page: Page) => page.evaluate(() => { (window as any).__rowFocusCalls.length = 0; });
const matchesFocusVisible = (page: Page, index: number) =>
  shownRows(page).nth(index).evaluate((el) => el.matches(":focus-visible"));
/** The key that moves the cursor to the second row in each view. */
const NEXT_ROW_KEY = { details: "ArrowDown", list: "ArrowDown", tiles: "ArrowRight" } as const;

for (const viewMode of ALL_VIEW_MODES) {
  test.describe(`${viewMode}: restored row focus requests the previous ring state`, () => {
    test.beforeEach(async ({ page }) => { await recordRowFocus(page); });

    test("Ctrl+T after a click restores the row without the keyboard ring", async ({ page }) => {
      await open(page, viewMode);
      await shownRows(page).nth(1).click();
      await expect(shownRows(page).nth(1)).toBeFocused();
      await clearRowFocusCalls(page);
      await page.keyboard.press("Control+t");
      await expect(page.locator(".tab")).toHaveCount(2);
      await expect(shownRows(page).first()).toBeFocused();
      const calls = await rowFocusCalls(page);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.focusVisible === false), JSON.stringify(calls)).toBe(true);
      expect(await matchesFocusVisible(page, 0)).toBe(false);
    });

    test("Ctrl+T after arrow keys restores the row's ring state", async ({ page }) => {
      await open(page, viewMode);
      await shownRows(page).first().click();
      await clearRowFocusCalls(page);
      await page.keyboard.press(NEXT_ROW_KEY[viewMode]);
      await expect(shownRows(page).nth(1)).toBeFocused();
      // Keyboard navigation keeps the browser's own heuristic: no option, and the ring shows.
      expect(await rowFocusCalls(page)).toEqual([{ path: await shownRows(page).nth(1).getAttribute("data-path"), focusVisible: undefined }]);
      expect(await matchesFocusVisible(page, 1)).toBe(true);
      await clearRowFocusCalls(page);
      await page.keyboard.press("Control+t");
      await expect(page.locator(".tab")).toHaveCount(2);
      await expect(shownRows(page).first()).toBeFocused();
      const calls = await rowFocusCalls(page);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.focusVisible === true), JSON.stringify(calls)).toBe(true);
      expect(await matchesFocusVisible(page, 0)).toBe(true);
    });
  });
}

test.describe("ordinary navigation keeps the browser's own ring heuristic", () => {
  test.beforeEach(async ({ page }) => { await recordRowFocus(page); });

  test("keyboard navigation from a sidebar bookmark after a row click requests no ring override", async ({ page }) => {
    await open(page, "details");
    await shownRows(page).nth(1).click();
    await clearRowFocusCalls(page);
    await page.locator('.quick-access .bookmark-drop-target[data-path="/home/user/Downloads"]').first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('.pane-tree:not(.retained) .entry-item[data-path^="/home/user/Downloads/"]').first()).toBeFocused();
    const calls = await rowFocusCalls(page);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.focusVisible === undefined), JSON.stringify(calls)).toBe(true);
  });

  test("a mouse click on Back after arrow keys requests no ring override", async ({ page }) => {
    await open(page, "details");
    await page.locator('.quick-access .bookmark-drop-target[data-path="/home/user/Downloads"]').first().click();
    await expect(shownRows(page).first()).toHaveAttribute("data-path", /^\/home\/user\/Downloads\//);
    await shownRows(page).first().click();
    await page.keyboard.press("ArrowDown");
    expect(await matchesFocusVisible(page, 1)).toBe(true);
    await clearRowFocusCalls(page);
    await page.locator(".pane-tree:not(.retained) [aria-label='Go back']").click();
    await expect(shownRows(page).first()).toHaveAttribute("data-path", /^\/home\/user\/Documents\//);
    await expect.poll(async () => (await rowFocusCalls(page)).length).toBeGreaterThan(0);
    const calls = await rowFocusCalls(page);
    expect(calls.every((call) => call.focusVisible === undefined), JSON.stringify(calls)).toBe(true);
  });
});

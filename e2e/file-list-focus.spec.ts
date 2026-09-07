/** Main file-list rows form one keyboard focus/selection composite. */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, MULTI_SELECT_MODIFIER, waitForEntries, type ViewMode } from "./helpers";

const HOME_PATH = "/home/user";
const TARGET_PATH = `${HOME_PATH}/Downloads`;

function entry(page: Page, path: string) {
  return page.locator(`.file-list .entry-item[data-path="${path}"]`);
}

async function openPath(page: Page, path: string, viewMode: ViewMode): Promise<void> {
  await page.goto(`/?path=${encodeURIComponent(path)}&viewMode=${viewMode}`);
  await waitForEntries(page);
  await expect(page.locator(`.${viewMode}-view`)).toBeVisible();
}

/** Focus the last sequential focus target before the rows in DOM order. */
async function focusBeforeFileList(page: Page): Promise<void> {
  const focused = await page.evaluate(() => {
    const rowViewport = document.querySelector(".file-list .file-rows");
    if (!rowViewport) return null;
    const candidates = [...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => {
      const style = getComputedStyle(element);
      return element.tabIndex >= 0 && style.display !== "none" && style.visibility !== "hidden"
        && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        && !!(element.compareDocumentPosition(rowViewport) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const previous = candidates.at(-1);
    previous?.focus();
    return previous ? { tag: previous.tagName, className: previous.className } : null;
  });
  expect(focused, "the file list must have a preceding sequential focus target").not.toBeNull();
}

async function rowState(page: Page) {
  return await page.locator(".file-list").evaluate((list) => {
    const rows = [...list.querySelectorAll<HTMLElement>(".entry-item")];
    return {
      focusedPath: (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".entry-item")?.dataset.path,
      selectedPaths: rows.filter((row) => row.classList.contains("selected")).map((row) => row.dataset.path),
      tabbablePaths: rows.filter((row) => row.tabIndex === 0).map((row) => row.dataset.path),
    };
  });
}

for (const viewMode of ALL_VIEW_MODES) {
  test.describe(`File-list composite focus [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await openPath(page, HOME_PATH, viewMode);
    });

    test("Tab enters at the selected Open target", async ({ page }) => {
      const selectedDirectory = entry(page, TARGET_PATH);
      await selectedDirectory.click();
      await expect(selectedDirectory).toHaveClass(/selected/);

      await focusBeforeFileList(page);
      await page.keyboard.press("Tab");
      const beforeOpen = await rowState(page);
      expect(beforeOpen).toEqual({
        focusedPath: TARGET_PATH,
        selectedPaths: [TARGET_PATH],
        tabbablePaths: [TARGET_PATH],
      });

      await page.keyboard.press("Enter");
      await expect(page.locator(".status-path")).toHaveAttribute("title", TARGET_PATH);
    });

    test("Open focuses the new first row before Arrow moves the visible endpoint", async ({ page }) => {
      const selectedDirectory = entry(page, TARGET_PATH);
      await selectedDirectory.click();
      await page.keyboard.press("Enter");
      await expect(page.locator(".status-path")).toHaveAttribute("title", TARGET_PATH);

      const selected = page.locator(".file-list .entry-item.selected");
      await expect(selected).toHaveCount(1);
      await expect(selected).toBeInViewport();
      const initialPath = await selected.getAttribute("data-path");
      const focusedAfterOpen = await selected.evaluate((row) => row === document.activeElement);

      await page.keyboard.press(viewMode === "details" ? "ArrowDown" : "ArrowRight");
      await expect.poll(() => selected.getAttribute("data-path")).not.toBe(initialPath);
      await expect(selected).toBeInViewport();
      await expect(selected).toBeFocused();
      expect(focusedAfterOpen).toBe(true);
    });

    test("repeated Shift+Arrow extends the range and moves its focus endpoint", async ({ page }) => {
      const rows = page.locator(".file-list .entry-item");
      const first = rows.first();
      const endpoint = rows.nth(2);
      const endpointPath = await endpoint.getAttribute("data-path");
      expect(endpointPath).toBeTruthy();

      await first.click();
      const move = viewMode === "details" ? "Shift+ArrowDown" : "Shift+ArrowRight";
      await page.keyboard.press(move);
      await page.keyboard.press(move);

      await expect(page.locator(".file-list .entry-item.selected")).toHaveCount(3);
      await expect(endpoint).toBeFocused();
      const state = await rowState(page);
      expect(state.focusedPath).toBe(endpointPath);
      expect(state.selectedPaths).toHaveLength(3);
      expect(state.tabbablePaths).toEqual([endpointPath]);
    });

    test("Ctrl+End keeps a virtual endpoint when Tab leaves and returns", async ({ page }) => {
      await openPath(page, "/perf/huge-300", viewMode);
      await page.locator(".file-list .entry-item").first().click();
      await page.keyboard.press("Control+End");

      const endpoint = page.locator(".file-list .entry-item.selected");
      await expect(endpoint).toHaveCount(1);
      await expect(endpoint).toBeInViewport();
      await expect(endpoint).toBeFocused();
      const endpointPath = await endpoint.getAttribute("data-path");

      await page.keyboard.press("Shift+Tab");
      const leftComposite = await page.evaluate(() =>
        !(document.activeElement as HTMLElement | null)?.closest(".file-list .entry-item"),
      );
      await page.keyboard.press("Tab");

      await expect(endpoint).toBeFocused();
      expect({ leftComposite, ...await rowState(page) }).toEqual({
        leftComposite: true,
        focusedPath: endpointPath,
        selectedPaths: [endpointPath],
        tabbablePaths: [endpointPath],
      });
    });

    test("Tab reveals and restores an unmounted virtual cursor", async ({ page }) => {
      await openPath(page, "/perf/huge-300", viewMode);
      await page.locator(".file-list .entry-item").first().click();
      await page.keyboard.press("Control+End");

      const selected = page.locator(".file-list .entry-item.selected");
      await expect(selected).toBeFocused();
      const endpointPath = await selected.getAttribute("data-path");
      expect(endpointPath).toBeTruthy();

      await page.keyboard.press("Shift+Tab");
      await page.locator(".file-list .virtual-viewport").evaluate((viewport) => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const endpoint = entry(page, endpointPath!);
      await expect(endpoint, "the retained cursor must be outside the rendered window").toHaveCount(0);

      await focusBeforeFileList(page);
      await page.keyboard.press("Tab");

      await expect(endpoint).toBeInViewport();
      await expect(endpoint).toBeFocused();
      expect(await rowState(page)).toEqual({
        focusedPath: endpointPath,
        selectedPaths: [endpointPath],
        tabbablePaths: [endpointPath],
      });
    });

    test("rename retains the selected cursor at its new sorted position", async ({ page }) => {
      await openPath(page, TARGET_PATH, viewMode);
      const originalPath = `${TARGET_PATH}/bundle.zip`;
      const renamedPath = `${TARGET_PATH}/000-${viewMode}-renamed.zip`;
      const original = entry(page, originalPath);

      await original.click();
      await page.keyboard.press("F2");
      const renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeFocused();
      await renameInput.fill(`000-${viewMode}-renamed.zip`);
      await page.keyboard.press("Enter");

      const renamed = entry(page, renamedPath);
      await expect(renameInput).toHaveCount(0);
      await expect(original).toHaveCount(0);
      await expect(renamed).toBeFocused();
      const afterRename = await rowState(page);
      expect(afterRename.selectedPaths).toEqual([renamedPath]);
      expect(afterRename.tabbablePaths).toEqual([renamedPath]);

      const orderedPaths = await page.locator(".file-list .entry-item").evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.path),
      );
      const renamedIndex = orderedPaths.indexOf(renamedPath);
      const nextPath = orderedPaths[renamedIndex + 1];
      expect(renamedIndex).toBeGreaterThanOrEqual(0);
      expect(nextPath).toBeTruthy();

      await page.keyboard.press(viewMode === "details" ? "ArrowDown" : "ArrowRight");
      const next = entry(page, nextPath!);
      await expect(next).toBeFocused();
      expect(await rowState(page)).toEqual({
        focusedPath: nextPath,
        selectedPaths: [nextPath],
        tabbablePaths: [nextPath],
      });
    });

    test("rename exits restore row focus while validation retains the editor", async ({ page }) => {
      const selected = entry(page, `${HOME_PATH}/readme.txt`);
      await selected.click();

      await page.keyboard.press("F2");
      let renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(renameInput).toHaveCount(0);
      await expect(selected).toBeFocused();

      await page.keyboard.press("F2");
      renameInput = page.locator(".rename-input");
      await expect(renameInput).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(renameInput).toHaveCount(0);
      await expect(selected).toBeFocused();

      await page.keyboard.press("F2");
      renameInput = page.locator(".rename-input");
      await renameInput.fill("   ");
      await page.keyboard.press("Enter");
      await expect(renameInput).toBeVisible();
      await expect(renameInput).toBeFocused();
      await expect(renameInput).toHaveClass(/error/);
    });

    test("Ctrl+click selection survives leaving and returning with Tab", async ({ page }) => {
      const rows = page.locator(".file-list .entry-item");
      const first = rows.first();
      const endpoint = rows.nth(2);
      const firstPath = await first.getAttribute("data-path");
      const endpointPath = await endpoint.getAttribute("data-path");

      await first.click();
      await endpoint.click({ modifiers: [MULTI_SELECT_MODIFIER] });
      await expect(page.locator(".file-list .entry-item.selected")).toHaveCount(2);
      await expect(endpoint).toBeFocused();

      await page.keyboard.press("Shift+Tab");
      const leftComposite = await page.evaluate(() =>
        !(document.activeElement as HTMLElement | null)?.closest(".file-list .entry-item"),
      );
      await page.keyboard.press("Tab");

      await expect(endpoint).toBeFocused();
      expect({ leftComposite, ...await rowState(page) }).toEqual({
        leftComposite: true,
        focusedPath: endpointPath,
        selectedPaths: [firstPath, endpointPath],
        tabbablePaths: [endpointPath],
      });
      if (viewMode === "details") {
        await page.screenshot({
          path: "screenshots/refactor/repo-health-cleanup/file-list-keyboard-cursor.png",
          animations: "disabled",
        });
      }
    });
  });
}

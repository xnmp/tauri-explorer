/**
 * FileList cross-view invariants (#297).
 *
 * FileList.svelte dispatches to Details / List / Tiles views (each rendering
 * the shared selection/clipboard classes onto `.entry-item`). It is a
 * defect-dense hot spot with only indirect coverage. This spec asserts the
 * invariants that must hold identically in every view, plus the specific
 * regression where clipboard styling was lost across a view switch:
 *
 *  - a clicked entry gains `.selected` with a real visual highlight;
 *  - keyboard navigation (ArrowDown/Up moves selection, Enter opens a folder);
 *  - cut styling (`.cut`) and copy styling (`.in-clipboard`) survive switching
 *    view mode (the cut item is still visually marked in the new view);
 *  - selection survives a view switch performed without clearing it.
 *
 * Run across all three views with ALL_VIEW_MODES=1.
 */
import { test, expect, type Page } from "@playwright/test";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

const HOME = "/?path=/home/user";

/** Name of the entry at DOM index `i` (stable identity across view switches). */
async function entryNameAt(page: Page, i: number): Promise<string> {
  const name = await page.locator(".entry-item").nth(i).locator(".entry-name").textContent();
  return (name ?? "").trim();
}

/** The `.entry-item` whose `.entry-name` matches `name`, regardless of view. */
function entryByName(page: Page, name: string) {
  return page.locator(".entry-item", { has: page.locator(".entry-name", { hasText: name }) });
}

// ---------------------------------------------------------------------------
// Per-view invariants: selection highlight + keyboard navigation.
// ---------------------------------------------------------------------------
for (const viewMode of VIEW_MODES) {
  test.describe(`FileList invariants [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(HOME);
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test("clicking an entry applies .selected with a visible highlight", async ({ page }) => {
      const item = page.locator(".entry-item").first();
      await item.click();
      await expect(item).toHaveClass(/selected/);

      // Assert the class is actually painted, not just present in markup.
      const highlighted = await item.evaluate((el) => {
        const c = getComputedStyle(el);
        return c.backgroundColor !== "rgba(0, 0, 0, 0)" || c.borderColor !== "rgba(0, 0, 0, 0)";
      });
      expect(highlighted).toBe(true);
    });

    test("arrow keys move the selection between entries", async ({ page }) => {
      // Details is a single column (ArrowDown/Up step by 1). List/Tiles are
      // row-major grids where ArrowDown jumps a whole row (and legitimately
      // no-ops on the last row), so the reliable single-step keys there are
      // ArrowRight/Left. Anchor on a file (not a folder) so the yazi-style
      // "ArrowRight enters the selected folder" branch can't trigger.
      const forwardKey = viewMode === "details" ? "ArrowDown" : "ArrowRight";
      const backKey = viewMode === "details" ? "ArrowUp" : "ArrowLeft";
      const anchor = page.locator(".entry-item:not(.directory)").first();

      await anchor.click();
      await expect(anchor).toHaveClass(/selected/);

      await page.keyboard.press(forwardKey);
      await expect(anchor).not.toHaveClass(/selected/);
      await expect(page.locator(".entry-item.selected")).toHaveCount(1);

      await page.keyboard.press(backKey);
      await expect(anchor).toHaveClass(/selected/);
      await expect(page.locator(".entry-item.selected")).toHaveCount(1);
    });

    test("Enter opens the selected folder", async ({ page }) => {
      const folder = page.locator(".entry-item.directory").first();
      const folderName = (await folder.locator(".entry-name").textContent())?.trim();
      expect(folderName).toBeTruthy();

      await folder.click();
      await expect(folder).toHaveClass(/selected/);

      await page.keyboard.press("Enter");
      await expect(page.locator(".breadcrumbs-container")).toContainText(folderName!, {
        timeout: 5000,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Cross-view persistence: clipboard + selection styling survives view switches.
// These run once (details -> list -> tiles) — they exercise the switch itself.
// ---------------------------------------------------------------------------
test.describe("FileList clipboard styling survives view switches", () => {
  test("cut (.cut) styling persists through details -> list -> tiles", async ({ page }) => {
    await page.goto(HOME);
    await waitForEntries(page);

    // Cut a concrete file (not a directory) in Details view.
    const target = page.locator(".entry-item:not(.directory)").first();
    const name = (await target.locator(".entry-name").textContent())?.trim();
    expect(name).toBeTruthy();
    await target.click();
    await pressShortcut(page, "x", { ctrlKey: true });
    await expect(entryByName(page, name!)).toHaveClass(/cut/);

    // The cut marking must follow the entry into each other view.
    await switchViewMode(page, "list");
    await expect(entryByName(page, name!)).toHaveClass(/cut/);

    await switchViewMode(page, "tiles");
    await expect(entryByName(page, name!)).toHaveClass(/cut/);
  });

  test("copy (.in-clipboard) styling persists across a view switch", async ({ page }) => {
    await page.goto(HOME);
    await waitForEntries(page);

    const target = page.locator(".entry-item:not(.directory)").first();
    const name = (await target.locator(".entry-name").textContent())?.trim();
    expect(name).toBeTruthy();
    await target.click();
    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(entryByName(page, name!)).toHaveClass(/in-clipboard/);

    await switchViewMode(page, "tiles");
    await expect(entryByName(page, name!)).toHaveClass(/in-clipboard/);
  });
});

test.describe("FileList selection survives a non-clearing view switch", () => {
  test("selection persists when switching view via the command palette", async ({ page }) => {
    await page.goto(HOME);
    await waitForEntries(page);

    const name = await entryNameAt(page, 0);
    await page.locator(".entry-item").first().click();
    await expect(entryByName(page, name)).toHaveClass(/selected/);

    // Switch to Tiles via the command palette — unlike the context-menu path,
    // this does not clear the current selection.
    await page.keyboard.press("Control+Shift+p");
    const palette = page.locator(".command-palette-dialog");
    await palette.waitFor({ state: "visible", timeout: 2000 });
    await palette.locator(".search-input").fill("Tiles View");
    const cmd = palette.locator('.command-item:has-text("Tiles View")').first();
    await expect(cmd).toBeVisible();
    await cmd.click();
    await expect(page.locator(".tiles-view")).toBeVisible({ timeout: 2000 });

    // The same entry must still be selected in the new view.
    await expect(entryByName(page, name)).toHaveClass(/selected/);
  });
});

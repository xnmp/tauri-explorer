/**
 * E2E: each right-click gesture mounts the context menu exactly once (#1062).
 *
 * The `menuIn` entrance animation restarts whenever the `.context-menu`
 * element is recreated, so a gesture that opens the menu twice is visible as
 * the menu fading in a second time. We count `.context-menu` insertions and
 * `menuIn` animation starts per gesture. The menu is mounted `visibility:
 * hidden` for one measuring frame, so the entrance animation must also start
 * only once it is revealed: an animation spent while hidden is replayed (or
 * skipped) by the engine at reveal, which reads as a second fade-in.
 */
import { test, expect, type Locator, type Page } from "./fixtures";
import { ALL_VIEW_MODES, pressShortcut, seedSettings, waitForEntries, type ViewMode } from "./helpers";

const START_PATH = "/home/user/Pictures";

/** Layouts: bare, and the reported one (preview pane on, two panes). */
const LAYOUTS = ["single pane", "preview pane + two panes"] as const;

type Probe = { inserted: number; animations: number; animationsWhileHidden: number };

async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ctxProbe: Probe };
    w.__ctxProbe = { inserted: 0, animations: 0, animationsWhileHidden: 0 };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches(".context-menu") || node.querySelector(".context-menu")) w.__ctxProbe.inserted++;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener(
      "animationstart",
      (e) => {
        if ((e.target as HTMLElement).classList?.contains("context-menu") && e.animationName.includes("menuIn")) {
          w.__ctxProbe.animations++;
          if (getComputedStyle(e.target as HTMLElement).visibility === "hidden") w.__ctxProbe.animationsWhileHidden++;
        }
      },
      true,
    );
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ctxProbe: Probe };
    w.__ctxProbe.inserted = 0;
    w.__ctxProbe.animations = 0;
    w.__ctxProbe.animationsWhileHidden = 0;
  });
}

/** Counts after letting any deferred re-open (rAF, timers, effects) settle. */
async function settledCounts(page: Page): Promise<Probe> {
  await expect(page.locator(".context-menu")).toBeVisible();
  await page.waitForTimeout(500);
  return await page.evaluate(
    () => (window as unknown as { __ctxProbe: Probe }).__ctxProbe,
  );
}


/** A viewport point inside `row` that the open menu does not cover. */
async function pointClearOfMenu(page: Page, row: Locator): Promise<{ x: number; y: number }> {
  const menu = (await page.locator(".context-menu").boundingBox())!;
  const box = (await row.boundingBox())!;
  // Rows can be wider than their scroller (Details in a narrow pane): only
  // points inside the scroller's visible box are reachable by the pointer.
  const view = (await page.locator(".file-list").first().boundingBox())!;
  for (let x = Math.max(box.x, view.x) + 8; x < Math.min(box.x + box.width, view.x + view.width) - 8; x += 8) {
    const y = box.y + box.height / 2;
    if (x < menu.x - 2 || x > menu.x + menu.width + 2 || y < menu.y - 2 || y > menu.y + menu.height + 2) {
      return { x, y };
    }
  }
  throw new Error("row is entirely covered by the context menu");
}

for (const layout of LAYOUTS) {
  for (const viewMode of ALL_VIEW_MODES satisfies readonly ViewMode[]) {
    test.describe(`Context menu opens once per gesture [${viewMode}, ${layout}]`, () => {
      test.beforeEach(async ({ page }) => {
        await seedSettings(page, { thumbnailSize: "xlarge", showPreviewPane: layout !== LAYOUTS[0] });
        await page.goto(`/?path=${encodeURIComponent(START_PATH)}&viewMode=${viewMode}`);
        await waitForEntries(page);
        if (layout !== LAYOUTS[0]) {
          if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ", {});
          await expect(page.locator(".preview-pane")).toBeVisible();
          await page.keyboard.press("Control+\\");
          await expect(page.locator(".explorer-pane")).toHaveCount(2);
        }
        await installProbe(page);
      });

      const rows = (page: Page) => page.locator(".file-list").first().locator(".entry-item");

      test("right-click with no menu open mounts the menu once", async ({ page }) => {
        await waitForEntries(page);
        await resetProbe(page);
        await rows(page).nth(0).click({ button: "right" });
        expect(await settledCounts(page)).toEqual({ inserted: 1, animations: 1, animationsWhileHidden: 0 });
      });

      test("right-click on another entry while a menu is open replaces it with one mount", async ({ page }) => {
        await rows(page).nth(0).click({ button: "right" });
        await settledCounts(page);

        // The real gesture lands on the backdrop that covers the whole window.
        const second = rows(page).nth(1);
        const secondPath = await second.getAttribute("data-path");
        const { x, y } = await pointClearOfMenu(page, second);
        await resetProbe(page);
        await page.mouse.click(x, y, { button: "right" });
        await expect(second).toHaveClass(/selected/);
        expect(await settledCounts(page)).toEqual({ inserted: 1, animations: 1, animationsWhileHidden: 0 });
        // The menu moved to the new target rather than staying on the old one.
        await expect(page.locator(".file-list").first().locator(".entry-item.selected")).toHaveAttribute("data-path", secondPath!);
      });

      test("right-click on empty space while a menu is open mounts once", async ({ page }) => {
        await rows(page).nth(0).click({ button: "right" });
        await settledCounts(page);

        await resetProbe(page);
        const box = (await page.locator(".file-list").first().boundingBox())!;
        await page.mouse.click(box.x + 6, box.y + box.height - 6, { button: "right" });
        expect(await settledCounts(page)).toEqual({ inserted: 1, animations: 1, animationsWhileHidden: 0 });
      });
    });
  }
}

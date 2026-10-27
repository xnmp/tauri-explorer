/**
 * Arrowing through math-heavy Markdown with the preview open (#1418): the
 * selection follows every key and paints before the preview starts rendering,
 * and the preview ends on the final file's fully typeset document. No other
 * file's document is shown after the last key.
 *
 * Fixture: /home/math-nav (mock-fixtures.ts) alternates math-heavy files
 * (odd numbers: 28 sections, 140 formulas) and plain ones.
 */

import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

declare global {
  interface Window {
    __nav: { lastKey: number; shownAfterLastKey: string[]; order: string[]; complete: string[] };
  }
}

test.describe("Markdown preview navigation", () => {
  test("fast arrow navigation ends on the final file's typeset preview, never a stale one", async ({ page }) => {
    await page.goto("/?path=/home/math-nav");
    await waitForEntries(page);
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
    await expect(previewPane).toBeVisible();

    const markdown = page.locator(".preview-markdown");
    await page.locator('[data-path="/home/math-nav/nav-01.md"]').click();
    await expect(markdown.locator("h1")).toHaveText("Navigation 1");
    await expect(markdown.locator(".katex")).toHaveCount(140, { timeout: 15_000 });

    // Record every document title the preview shows after the last key.
    const keys = 10;
    await page.evaluate((keys) => {
      const nav = { lastKey: Infinity, shownAfterLastKey: [] as string[], order: [] as string[], complete: [] as string[] };
      let pressed = 0;
      document.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" && ++pressed === keys) nav.lastKey = performance.now();
      }, true);
      window.__nav = nav;
      new MutationObserver(() => {
        const title = document.querySelector(".preview-markdown h1")?.textContent;
        if (title && performance.now() > nav.lastKey) nav.shownAfterLastKey.push(title);
        if (title === "Navigation 11" && !nav.order.includes("preview")) nav.order.push("preview");
        // Documents the walk passed over that were typeset in full.
        if (title && !nav.complete.includes(title) && document.querySelectorAll(".preview-markdown .katex").length >= 140) nav.complete.push(title);
      }).observe(document.querySelector(".preview-pane")!, { subtree: true, childList: true });
      // The first frame painted after the final row is selected.
      new MutationObserver(() => {
        if (nav.order.includes("selection-frame") || !document.querySelector('.entry-item.selected[data-path="/home/math-nav/nav-11.md"]')) return;
        requestAnimationFrame(() => { if (!nav.order.includes("selection-frame")) nav.order.push("selection-frame"); });
      }).observe(document.querySelector(".file-list")!, { subtree: true, attributes: true, attributeFilter: ["class"] });
    }, keys);

    // Key repeat (~30/s), paced by page timers rather than runner round trips:
    // a timer cannot fire while a render holds the main thread.
    await page.evaluate((keys) => new Promise<void>((resolve) => {
      let sent = 0;
      const press = () => {
        const target = document.activeElement ?? document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
        if (++sent < keys) setTimeout(press, 33); else resolve();
      };
      press();
    }), keys);

    // The selection followed every key.
    await expect(page.locator(".entry-item.selected:visible")).toHaveAttribute("data-path", "/home/math-nav/nav-11.md");

    // The preview ends on nav-11, completely typeset (every block revealed).
    await expect(markdown.locator("h1")).toHaveText("Navigation 11");
    await expect(page.locator(".preview-content")).toHaveAttribute("aria-busy", "false");
    await expect(markdown.locator(".katex")).toHaveCount(140, { timeout: 15_000 });
    await expect(markdown.locator(".katex-display")).toHaveCount(28);
    await expect(markdown.locator("h2").last()).toHaveText("Section 27 of file 11");

    const { shownAfterLastKey, order, complete } = await page.evaluate(() => window.__nav);
    // Files passed over were abandoned, not typeset in full behind the walk.
    expect(complete).toEqual(["Navigation 11"]);
    expect(shownAfterLastKey.length).toBeGreaterThan(0);
    expect(new Set(shownAfterLastKey)).toEqual(new Set(["Navigation 11"]));
    // The selection painted before any of the final document was rendered:
    // typesetting never runs in the selection's own frame.
    expect(order).toEqual(["selection-frame", "preview"]);
  });

  test("going back to a previewed file shows it again, fully typeset", async ({ page }) => {
    await page.goto("/?path=/home/math-nav");
    await waitForEntries(page);
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
    const markdown = page.locator(".preview-markdown");

    await page.locator('[data-path="/home/math-nav/nav-03.md"]').click();
    await expect(markdown.locator(".katex")).toHaveCount(140, { timeout: 15_000 });
    await page.keyboard.press("ArrowDown");
    await expect(markdown.locator("h1")).toHaveText("Navigation 4");
    await expect(markdown.locator(".katex")).toHaveCount(0);
    await page.keyboard.press("ArrowUp");
    await expect(markdown.locator("h1")).toHaveText("Navigation 3");
    await expect(markdown.locator(".katex")).toHaveCount(140, { timeout: 15_000 });
    await expect(markdown.locator("h2").last()).toHaveText("Section 27 of file 3");
  });
});

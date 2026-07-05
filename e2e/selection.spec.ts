import { test, expect } from "@playwright/test";
import { VIEW_MODES, waitForEntries, switchViewMode, MULTI_SELECT_MODIFIER } from "./helpers";

for (const viewMode of VIEW_MODES) {
  test.describe(`Selection [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      if (viewMode !== "details") {
        await switchViewMode(page, viewMode);
      }
    });

    test.describe("Single Selection", () => {
      test("single-click on file selects it", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();
        await expect(file).toHaveClass(/selected/);
      });

      test("selected file has visual highlight", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();

        const styles = await file.evaluate((el) => {
          const computed = window.getComputedStyle(el);
          return {
            background: computed.backgroundColor,
            border: computed.border,
          };
        });

        expect(
          styles.background !== "rgba(0, 0, 0, 0)" || styles.border !== "none"
        ).toBeTruthy();
      });

      test("clicking another file changes selection", async ({ page }) => {
        const files = page.locator(".entry-item");
        const firstFile = files.nth(0);
        const secondFile = files.nth(1);

        await firstFile.click();
        await expect(firstFile).toHaveClass(/selected/);

        await secondFile.click();
        await expect(secondFile).toHaveClass(/selected/);
        await expect(firstFile).not.toHaveClass(/selected/);
      });

      test("clicking empty space deselects all", async ({ page }) => {
        const file = page.locator(".entry-item").first();
        await file.click();
        await expect(file).toHaveClass(/selected/);

        await page.locator(".file-list .content").first().click({ position: { x: 10, y: 400 } });

        await expect(file).not.toHaveClass(/selected/);
      });
    });

    test.describe("Multi-Selection", () => {
      test("Ctrl+click adds to selection", async ({ page }) => {
        const files = page.locator(".entry-item");
        const firstFile = files.nth(0);
        const secondFile = files.nth(1);

        await firstFile.click();
        await secondFile.click({ modifiers: [MULTI_SELECT_MODIFIER] });

        await expect(firstFile).toHaveClass(/selected/);
        await expect(secondFile).toHaveClass(/selected/);
      });

      test("Shift+click selects range", async ({ page }) => {
        const files = page.locator(".entry-item");
        const count = await files.count();
        expect(count, "mock home dir must provide at least 3 entries").toBeGreaterThanOrEqual(3);

        const firstFile = files.nth(0);
        const thirdFile = files.nth(2);

        await firstFile.click();
        await thirdFile.click({ modifiers: ["Shift"] });

        await expect(files.nth(0)).toHaveClass(/selected/);
        await expect(files.nth(1)).toHaveClass(/selected/);
        await expect(files.nth(2)).toHaveClass(/selected/);
      });
    });

    test.describe("Drag Selection (Marquee)", () => {
      test("drag in empty space creates selection rectangle", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        const startX = box.x + 50;
        const startY = box.y + box.height - 50;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 100, startY - 100);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.mouse.up();
      });

      test("drag selection selects files within rectangle", async ({ page }) => {
        // Navigate to a directory with few items so there's always empty background space
        await page.goto("/?path=/home/user/Downloads");
        await waitForEntries(page);
        if (viewMode !== "details") await switchViewMode(page, viewMode);

        const files = page.locator(".entry-item");
        const count = await files.count();
        expect(count, "mock home dir must provide at least 2 entries").toBeGreaterThanOrEqual(2);

        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        // Start the drag on empty background BELOW every item. The last DOM
        // item is not the visually lowest in list view (its CSS grid flows
        // column-first), so "below the last item" can land ON an entry and
        // turn the marquee into a file drag (#130) — compute the true max
        // bottom across all entries instead.
        let maxBottom = 0;
        for (const item of await files.all()) {
          const b = await item.boundingBox();
          if (b) maxBottom = Math.max(maxBottom, b.y + b.height);
        }
        expect(maxBottom, "entries must have bounding boxes").toBeGreaterThan(0);

        const startX = box.x + 50;
        const startY = maxBottom + 10;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        // steps>1: a single-jump move is an unrealistic pointer stream and
        // WebKit's pointer-event synthesis drops the marquee update for it.
        await page.mouse.move(startX + 200, box.y + 10, { steps: 5 });
        await page.mouse.up();

        await page.waitForTimeout(100);

        const selectedCount = await page.locator(".entry-item.selected").count();
        expect(selectedCount).toBeGreaterThan(0);
      });

      /** Helper: check if the app's drag state is stuck */
      async function isDragStuck(page: import("@playwright/test").Page, contentBox: { x: number; y: number; width: number; height: number }): Promise<boolean> {
        const selBefore = await page.locator(".entry-item.selected").count();
        await page.mouse.move(contentBox.x + 80, contentBox.y + 40);
        await page.waitForTimeout(50);
        await page.mouse.move(contentBox.x + 80, contentBox.y + contentBox.height - 30);
        await page.waitForTimeout(50);
        const selAfter = await page.locator(".entry-item.selected").count();
        const marqueeVisible = await page.locator(".marquee-rect").isVisible();
        return marqueeVisible || selAfter !== selBefore;
      }

      test("mousemove with buttons=0 does not update selection after drag", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 150, box.y + 80);
        await page.mouse.up();
        await page.waitForTimeout(100);

        expect(await isDragStuck(page, box)).toBe(false);
      });

      test("drag release registers even when mouseup fires on overlay element", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 150, box.y + 80);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(() => {
          const overlay = document.createElement("div");
          overlay.id = "test-overlay";
          overlay.style.cssText = "position:fixed;inset:0;z-index:9999;";
          overlay.addEventListener("mouseup", (e) => e.stopPropagation());
          document.body.appendChild(overlay);
        });

        await page.mouse.up();
        await page.waitForTimeout(50);

        await page.evaluate(() => document.getElementById("test-overlay")?.remove());
        await page.waitForTimeout(50);

        expect(await isDragStuck(page, box)).toBe(false);
      });

      test("native dragstart during marquee doesn't leave drag stuck", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + 80);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (el) {
            el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
            el.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
          }
        }, { x: box.x + 100, y: box.y + 80 });

        await page.waitForTimeout(100);

        expect(await isDragStuck(page, box)).toBe(false);
      });

      test("mousemove with buttons=0 is detected as stale drag", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 150, box.y + 80);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(({ x, y }) => {
          window.dispatchEvent(new MouseEvent("mousemove", {
            bubbles: true, clientX: x, clientY: y, buttons: 0
          }));
        }, { x: box.x + 200, y: box.y + 60 });


        await expect(marquee).not.toBeVisible();
      });

      test("window blur during drag cancels marquee", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + box.height - 130);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await page.waitForTimeout(100);

        expect(await isDragStuck(page, box)).toBe(false);
      });

      test("contextmenu during drag cancels marquee", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + box.height - 130);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (el) {
            el.dispatchEvent(new MouseEvent("contextmenu", {
              bubbles: true, clientX: x, clientY: y, button: 2
            }));
          }
        }, { x: box.x + 80, y: box.y + box.height - 100 });

        await page.waitForTimeout(100);

        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);

        await page.mouse.up();
        await page.waitForTimeout(100);

        expect(await isDragStuck(page, box)).toBe(false);
      });

      test("pointercancel during drag cancels marquee", async ({ page }) => {
        const content = page.locator(".file-list .content").first();
        const box = await content.boundingBox();
        expect(box, "file list must have a bounding box").not.toBeNull();
        if (!box) return;

        await page.mouse.move(box.x + 50, box.y + box.height - 50);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + box.height - 130);

        const marquee = page.locator(".marquee-rect");
        await expect(marquee).toBeVisible({ timeout: 2000 });

        await page.evaluate(({ x, y }) => {
          window.dispatchEvent(new PointerEvent("pointercancel", {
            bubbles: true, clientX: x, clientY: y, pointerId: 1
          }));
        }, { x: box.x + 100, y: box.y + box.height - 100 });

        await page.waitForTimeout(100);

        expect(await isDragStuck(page, box)).toBe(false);
      });
    });
  });
}

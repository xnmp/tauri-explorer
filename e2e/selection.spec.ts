import { test, expect } from "@playwright/test";

test.describe("Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    // Wait for files to load
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
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

      // Check for visual selection (border or background change)
      const styles = await file.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          background: computed.backgroundColor,
          border: computed.border,
        };
      });

      // Should have some visual indication (not default transparent)
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

      // Click on empty space in file list content area
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
      await secondFile.click({ modifiers: ["Control"] });

      await expect(firstFile).toHaveClass(/selected/);
      await expect(secondFile).toHaveClass(/selected/);
    });

    test("Shift+click selects range", async ({ page }) => {
      const files = page.locator(".entry-item");
      const count = await files.count();
      if (count < 3) {
        test.skip();
        return;
      }

      const firstFile = files.nth(0);
      const thirdFile = files.nth(2);

      await firstFile.click();
      await thirdFile.click({ modifiers: ["Shift"] });

      // All three should be selected
      await expect(files.nth(0)).toHaveClass(/selected/);
      await expect(files.nth(1)).toHaveClass(/selected/);
      await expect(files.nth(2)).toHaveClass(/selected/);
    });
  });

  test.describe("Drag Selection (Marquee)", () => {
    test("drag in empty space creates selection rectangle", async ({ page }) => {
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

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
      const files = page.locator(".entry-item");
      const count = await files.count();
      if (count < 2) { test.skip(); return; }

      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      const startX = box.x + 50;
      const startY = box.y + box.height - 20;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 200, box.y + 100);
      await page.mouse.up();

      await page.waitForTimeout(100);

      const selectedCount = await page.locator(".entry-item.selected").count();
      expect(selectedCount).toBeGreaterThan(0);
    });

    // =====================================================================
    // Bug investigation: drag select sometimes doesn't release properly.
    // Symptom: after releasing the mouse, moving the mouse still changes
    // selection — isDragging stays true.
    // =====================================================================

    /** Helper: check if the app's drag state is stuck (selection changes on mousemove without button) */
    async function isDragStuck(page: import("@playwright/test").Page, contentBox: { x: number; y: number; width: number; height: number }): Promise<boolean> {
      // Record current selection
      const selBefore = await page.locator(".entry-item.selected").count();

      // Move mouse to a different position (no buttons pressed)
      await page.mouse.move(contentBox.x + 80, contentBox.y + 40);
      await page.waitForTimeout(50);
      await page.mouse.move(contentBox.x + 80, contentBox.y + contentBox.height - 30);
      await page.waitForTimeout(50);

      const selAfter = await page.locator(".entry-item.selected").count();
      const marqueeVisible = await page.locator(".marquee-rect").isVisible();

      // If marquee is still visible or selection changed without clicking, drag is stuck
      return marqueeVisible || selAfter !== selBefore;
    }

    test("mousemove with buttons=0 does not update selection after drag", async ({ page }) => {
      // Core test: after a normal drag+release, subsequent mouse movement
      // (with no button pressed) should NOT change selection or show marquee
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      // Normal drag and release
      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + 80);
      await page.mouse.up();
      await page.waitForTimeout(100);

      expect(await isDragStuck(page, box)).toBe(false);
    });

    test("drag release registers even when mouseup fires on overlay element", async ({ page }) => {
      // Simulate: during marquee drag, an overlay appears (toast, dialog) and
      // mouseup fires on the overlay instead of the file list.
      // The overlay might stopPropagation, preventing window from seeing mouseup.
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + 80);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // Inject an overlay that stopPropagation on mouseup
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "test-overlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:9999;";
        overlay.addEventListener("mouseup", (e) => e.stopPropagation());
        document.body.appendChild(overlay);
      });

      // Release on the overlay — mouseup won't reach window
      await page.mouse.up();
      await page.waitForTimeout(50);

      // Remove overlay
      await page.evaluate(() => document.getElementById("test-overlay")?.remove());
      await page.waitForTimeout(50);

      // Now move mouse around — is drag stuck?
      expect(await isDragStuck(page, box)).toBe(false);
    });

    test("native dragstart during marquee doesn't leave drag stuck", async ({ page }) => {
      // If a native drag fires (from draggable items), mousemove/mouseup stop.
      // Simulate: marquee starts on background, then browser fires dragstart
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + 80);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // Simulate browser firing a dragstart (which suppresses subsequent mouse events)
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
          // After native drag, browser fires dragend instead of mouseup
          el.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
        }
      }, { x: box.x + 100, y: box.y + 80 });

      // No mouseup was fired — only dragstart/dragend
      await page.waitForTimeout(100);

      expect(await isDragStuck(page, box)).toBe(false);
    });

    test("mousemove with buttons=0 is detected as stale drag", async ({ page }) => {
      // Direct test: if mousemove fires with event.buttons === 0 while
      // isDragging is true, the drag should be cancelled.
      // This is the safety-net pattern used by VS Code, Windows Explorer, etc.
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + 80);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // Dispatch a mousemove with buttons=0 (simulating missed mouseup)
      await page.evaluate(({ x, y }) => {
        window.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true, clientX: x, clientY: y, buttons: 0
        }));
      }, { x: box.x + 200, y: box.y + 60 });

      await page.waitForTimeout(100);

      // The app should detect buttons=0 and cancel the drag
      await expect(marquee).not.toBeVisible();
    });

    test("window blur during drag cancels marquee", async ({ page }) => {
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + box.height - 130);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // Simulate Alt+Tab / window losing focus
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.waitForTimeout(100);

      expect(await isDragStuck(page, box)).toBe(false);
    });

    test("contextmenu during drag cancels marquee", async ({ page }) => {
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + box.height - 130);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // Raw contextmenu (e.g., touchpad two-finger tap — no right mousedown)
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, clientX: x, clientY: y, button: 2
          }));
        }
      }, { x: box.x + 80, y: box.y + box.height - 100 });

      await page.waitForTimeout(100);

      // Escape to close any context menu, then check
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);

      // Release left button
      await page.mouse.up();
      await page.waitForTimeout(100);

      expect(await isDragStuck(page, box)).toBe(false);
    });

    test("pointercancel during drag cancels marquee", async ({ page }) => {
      const content = page.locator(".file-list .content").first();
      const box = await content.boundingBox();
      if (!box) { test.skip(); return; }

      await page.mouse.move(box.x + 50, box.y + box.height - 50);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + box.height - 130);

      const marquee = page.locator(".marquee-rect");
      await expect(marquee).toBeVisible({ timeout: 2000 });

      // OS cancels the pointer (palm rejection, gesture, etc.)
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

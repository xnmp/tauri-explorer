/**
 * E2E: fixed-position overlays must open at the cursor while CSS-zoomed.
 *
 * Zoom bugs keep recurring (context menu #-, history dropdown, git graph
 * menu #221): raw clientX/Y written into a position:fixed element drifts by
 * the zoom factor. These specs drive the app's real zoom command (Ctrl+=)
 * and assert the overlay lands at the click point in *viewport* space.
 *
 * Chromium-specific by design — it's the engine the browser E2E suite runs
 * on, and the coordinate conversion (domain/zoom.ts) is engine-aware.
 */
import { test, expect, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries, pressShortcut } from "./helpers";

/** Bump the app zoom via the real command; returns the resulting factor. */
async function zoomIn(page: Page, steps: number): Promise<number> {
  for (let i = 0; i < steps; i++) {
    await pressShortcut(page, "=", { ctrlKey: true });
  }
  return page.evaluate(() => {
    const z = document.documentElement.style.zoom;
    return z ? parseFloat(z) / 100 : 1;
  });
}

/** Viewport-space bounding rect of the first element matching `selector`.
 *  On Chromium, getBoundingClientRect is already viewport-space under CSS
 *  zoom (a fixed left:100px element reports rect.left = 100 × zoom —
 *  verified empirically), so no conversion is needed. */
async function viewportRect(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

const TOLERANCE = 40; // px — menus may nudge to stay on-screen

test.describe("Overlay positioning under zoom", () => {
  // Chromium and WebKit (WKWebView model) both report getBoundingClientRect
  // in post-zoom viewport px, so the same measurement works for both engines
  // (#227 — the real app runs WebKit on Linux/macOS, so Chromium-only
  // coverage missed engine-specific drift). WebKitGTK's pre-zoom-rect quirk
  // is covered by unit tests on fixedFromClient/fixedFromRect.

  test("file context menu opens at the cursor while zoomed", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const zoom = await zoomIn(page, 3);
    expect(zoom).toBeGreaterThan(1);

    // Right-click the FIRST entry (near the top): the menu fits below the
    // cursor there, so the legitimate keep-on-screen clamp stays out of the
    // measurement. Clamping behavior near edges is by design, not drift.
    const entry = page.locator(".entry-item").first();
    const box = (await entry.boundingBox())!;
    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;
    await page.mouse.click(clickX, clickY, { button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    const rect = (await viewportRect(page, ".context-menu"))!;
    expect(Math.abs(rect.x - clickX)).toBeLessThan(TOLERANCE);
    expect(Math.abs(rect.y - clickY)).toBeLessThan(TOLERANCE);
  });

  test("git graph commit menu opens at the cursor while zoomed (#221)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    // Open the graph via its shortcut, then zoom.
    await page.keyboard.press("Control+Alt+g");
    await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible();
    const zoom = await zoomIn(page, 3);
    expect(zoom).toBeGreaterThan(1);

    const row = page.locator(".commit-row").nth(2);
    const box = (await row.boundingBox())!;
    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;
    await page.mouse.click(clickX, clickY, { button: "right" });

    const menu = page.locator('[data-testid="git-graph-menu"]');
    await expect(menu).toBeVisible();
    const rect = (await viewportRect(page, '[data-testid="git-graph-menu"]'))!;
    expect(Math.abs(rect.x - clickX)).toBeLessThan(TOLERANCE);
    expect(Math.abs(rect.y - clickY)).toBeLessThan(TOLERANCE);
  });

  test("context menu is exact at 100% zoom (control case)", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const entry = page.locator(".entry-item").first();
    const box = (await entry.boundingBox())!;
    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;
    await page.mouse.click(clickX, clickY, { button: "right" });

    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    const rect = (await viewportRect(page, ".context-menu"))!;
    expect(Math.abs(rect.x - clickX)).toBeLessThan(TOLERANCE);
    expect(Math.abs(rect.y - clickY)).toBeLessThan(TOLERANCE);
  });
});

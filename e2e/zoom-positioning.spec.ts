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
import { test, expect, type Page } from "./fixtures";
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
  test("file context menu opens at the cursor while zoomed", async ({ page, browserName }) => {
    // Playwright WebKit does not reproduce Tauri's WKWebView fixed-overlay
    // scaling. Its one-division result is deliberately unlike the macOS
    // engine, so the pure engine-parameterized tests cover that branch.
    test.skip(browserName !== "chromium", "WKWebView fixed-overlay math needs the domain seam");
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
    await page.screenshot({ path: "evidence/ac-1-context-menu-at-cursor.png" });
  });

  test("git graph commit menu opens at the cursor while zoomed (#221)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "WKWebView fixed-overlay math needs the domain seam");
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

  // Marquee selection under zoom (#241). The regression channel: domain/zoom's
  // client→CSS conversions kept a legacy "WebKitGTK reports pre-zoom rects"
  // branch after #227 standardized fixed-overlay math, so the rubber band
  // drifted from the cursor on the real Linux webview while Chromium stayed
  // green. This asserts BOTH the band's on-screen geometry and the selection
  // outcome; run it under WEBKIT=1 to cover the engine that regressed.
  test("marquee tracks the cursor and selects covered entries while zoomed (#241)", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);
    const zoom = await zoomIn(page, 3);
    expect(zoom).toBeGreaterThan(1);

    const files = page.locator(".entry-item");
    const count = await files.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Start on background below the visually lowest entry (#130).
    let maxBottom = 0;
    for (const item of await files.all()) {
      const b = await item.boundingBox();
      if (b) maxBottom = Math.max(maxBottom, b.y + b.height);
    }
    const content = page.locator(".file-list .content").first();
    const box = (await content.boundingBox())!;
    const startX = box.x + 40;
    const startY = Math.min(maxBottom + 10, box.y + box.height - 5);
    const endX = box.x + box.width - 40;
    // Stay below the header clamp (32 CSS px × zoom): the marquee's top edge
    // is clamped there by design, which would read as false drift.
    const endY = box.y + Math.ceil(32 * zoom) + 10;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // steps>1: WebKit's pointer synthesis drops single-jump marquee updates.
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.waitForTimeout(80); // let the rAF-throttled move flush

    // The rubber band must track the cursor in viewport space — drift by the
    // zoom factor is exactly the recurring bug.
    const rect = (await page.locator(".marquee-rect").boundingBox())!;
    const tol = 12;
    expect(Math.abs(rect.x - Math.min(startX, endX))).toBeLessThan(tol);
    expect(Math.abs(rect.y - Math.min(startY, endY))).toBeLessThan(tol);
    expect(Math.abs(rect.x + rect.width - Math.max(startX, endX))).toBeLessThan(tol);
    expect(Math.abs(rect.y + rect.height - Math.max(startY, endY))).toBeLessThan(tol);

    await page.mouse.up();
    await page.waitForTimeout(100);

    // Outcome: the sweep covered every entry, so every entry is selected.
    expect(await page.locator(".entry-item.selected").count()).toBe(count);
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

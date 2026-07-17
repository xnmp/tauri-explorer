/**
 * E2E test: Miller columns panel alongside any view mode (directories only).
 * Issue: feat/miller-view
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Miller columns panel", () => {
  test("miller columns appear when millerLayers > 0", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Enable 1 miller layer
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForTimeout(1000);
    await waitForEntries(page);

    // Navigate to a subdirectory so ancestor columns appear
    await page.locator(".entry-item").first().dblclick();

    // Miller columns should be visible
    await expect(page.locator(".miller-columns")).toBeVisible();
    const cols = page.locator(".miller-col");
    expect(await cols.count()).toBeGreaterThanOrEqual(1);
  });

  test("miller columns hidden when millerLayers = 0", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Disable miller columns
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 0;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });

    // Miller columns should not be visible
    await expect(page.locator(".miller-columns")).toHaveCount(0);
  });

  test("miller column header is contiguous with entries (no border)", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForTimeout(1000);
    await waitForEntries(page);

    await page.locator(".entry-item").first().dblclick();

    await expect(page.locator(".miller-columns")).toBeVisible();
    const header = page.locator(".col-header").first();
    await expect(header).toBeVisible();

    const borderBottom = await header.evaluate(
      (el) => getComputedStyle(el).borderBottomStyle,
    );
    expect(borderBottom).toBe("none");
  });

  test("miller column has ondrop handler for background drops", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForTimeout(1000);
    await waitForEntries(page);

    await page.locator(".entry-item").first().dblclick();

    await expect(page.locator(".miller-columns")).toBeVisible();
    const col = page.locator(".miller-col").first();

    // The column element should have drag event listeners bound (Svelte wires
    // them as properties). Verify the column responds to dragover by checking
    // that the event is handled (preventDefault called = accepts drop).
    const acceptsDrop = await col.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add("test", "application/x-explorer-path");
      const event = new DragEvent("dragover", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(acceptsDrop).toBe(true);
  });
});

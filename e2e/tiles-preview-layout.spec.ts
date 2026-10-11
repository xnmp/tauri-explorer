import { test, expect, type Page } from "./fixtures";
import { waitForEntries, switchViewMode, pressShortcut } from "./helpers";

// Instrument native delivery without delaying, replacing measurements, or
// mocking the app's observer. Sample before deferred Svelte work can run.
async function installLayoutProbe(page: Page) {
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    const samples: { width: number; expected: string; actual: string; fullscreen: boolean }[] = [];
    Object.assign(window, { tileLayoutSamples: samples });
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          callback(entries, observer);
          for (const entry of entries) {
            if (!entry.target.matches(".file-list > .content")) continue;
            const surface = entry.target.querySelector<HTMLElement>(".tiles-view");
            const row = surface?.querySelector<HTMLElement>(".tile-row");
            if (!surface || !row) continue;
            const style = getComputedStyle(surface);
            // Use the live row width, including any scrollbar space already
            // consumed by its viewport. It is independent of column count.
            const probe = document.createElement("div");
            probe.style.cssText = `position:absolute;visibility:hidden;display:grid;width:${row.getBoundingClientRect().width}px;grid-template-columns:repeat(auto-fill,minmax(${style.getPropertyValue("--tile-min-col")},1fr));gap:${style.getPropertyValue("--tile-gap")}`;
            // WebKit omits gaps from empty auto-fill grids. Populate every
            // possible track so the probe models a real row in both engines.
            const slots = Math.ceil(row.getBoundingClientRect().width / parseFloat(style.getPropertyValue("--tile-min-col")));
            for (let i = 0; i < slots; i++) probe.append(document.createElement("div"));
            document.body.append(probe);
            samples.push({
              width: entry.contentRect.width,
              expected: getComputedStyle(probe).gridTemplateColumns,
              actual: getComputedStyle(row).gridTemplateColumns,
              fullscreen: !!document.querySelector(".preview-pane.fullscreen"),
            });
            probe.remove();
          }
        });
      }
    };
  });
}

async function openTiles(page: Page) {
  await installLayoutProbe(page);
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await switchViewMode(page, "tiles");
  if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ");
  await page.locator(".tile-item").filter({ hasText: "photo1.jpg" }).click();
  await expect(page.locator(".preview-image")).toBeVisible();
}

async function clearSamples(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { tileLayoutSamples: unknown[] }).tileLayoutSamples.length = 0;
  });
}

async function expectMatchingDelivery(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { tileLayoutSamples: unknown[] }).tileLayoutSamples.length,
  )).toBeGreaterThan(0);
  const samples = await page.evaluate(() =>
    (window as unknown as { tileLayoutSamples: { expected: string; actual: string }[] }).tileLayoutSamples,
  );
  for (const sample of samples) expect(sample.actual, JSON.stringify(sample)).toBe(sample.expected);
}

for (const exit of ["Escape", "double-click"] as const) {
  test(`tile tracks match restored width during fullscreen ${exit} exit`, async ({ page }) => {
    await openTiles(page);
    const selected = page.locator(".tile-item.selected");
    await expect(selected).toHaveCount(1);
    const before = await selected.innerText();
    await page.locator(".preview-image").click();
    await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
    // Wait for the expanded background grid to settle before measuring exit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await clearSamples(page);
    if (exit === "Escape") await page.keyboard.press("Escape");
    // Target the pane handler directly: image descendants own their clicks.
    else await page.locator(".preview-pane").dispatchEvent("dblclick");
    await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
    await expectMatchingDelivery(page);
    await expect(selected).toHaveText(before);
    if (exit === "Escape") await page.screenshot({ path: "evidence/ac-1-fullscreen-exit-tiles.png" });
  });
}

test("tile tracks match window resize and docked preview visibility changes", async ({ page }) => {
  await openTiles(page);
  await clearSamples(page);
  await page.setViewportSize({ width: 900, height: 720 });
  await expectMatchingDelivery(page);
  for (const visible of [false, true]) {
    await clearSamples(page);
    await pressShortcut(page, " ");
    if (visible) await expect(page.locator(".preview-pane")).toBeVisible();
    else await expect(page.locator(".preview-pane")).toBeHidden();
    await expectMatchingDelivery(page);
  }
  await page.screenshot({ path: "evidence/ac-2-resized-docked-tiles.png" });
});

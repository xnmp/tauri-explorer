import { test, expect } from "./fixtures";

test("Details shows source resolution, unavailable cells and a persistent column toggle", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("explorer-settings")) localStorage.setItem("explorer-settings", JSON.stringify({ columnVisibility: { date: true, type: true, size: true } }));
    window.__mockControl = { imageResolution: path => path.endsWith("beach.jpg") ? null : { width: 1920, height: 1080 } };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  await expect(page.locator(".column-header.resolution-column")).toBeVisible();
  const photo = page.locator('.file-item[data-path="/home/user/Pictures/photo1.jpg"]');
  await expect(photo.locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  await page.screenshot({ path: "evidence/ac-1-source-resolution.png" });
  await expect(page.locator('.file-item[data-path="/home/user/Pictures/vacation"] .resolution-cell')).toHaveText("—");
  await page.goto("/?path=/home/user/Pictures/vacation&viewMode=details");
  await expect(page.locator('.file-item[data-path$="itinerary.txt"] .resolution-cell')).toHaveText("—");
  await expect(page.locator('.file-item[data-path$="beach.jpg"] .resolution-cell')).toHaveText("—");
  await page.screenshot({ path: "evidence/ac-2-unavailable-resolution.png" });
  await page.locator(".column-headers").click({ button: "right" });
  await page.locator(".column-menu-item").filter({ hasText: "Resolution" }).click();
  await page.reload();
  await expect(page.locator(".file-item").first()).toBeVisible();
  await expect(page.locator(".resolution-cell")).toHaveCount(0);
  await expect(page.locator(".column-header.resolution-column")).toHaveCount(0);
  await page.locator(".column-headers").click({ button: "right" });
  await expect(page.locator(".column-menu-item").filter({ hasText: "Resolution" }).locator(".column-menu-check")).toHaveText("");
  await page.screenshot({ path: "evidence/ac-3-persisted-visibility.png" });
  await page.locator(".column-menu-item").filter({ hasText: "Resolution" }).click();
  await expect(page.locator(".column-header.resolution-column")).toBeVisible();
});

test("visible metadata refreshes on replacement events without changing file-list fields", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  const photo = page.locator('.file-item[data-path="/home/user/Pictures/photo1.jpg"]');
  await expect(photo.locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  const details = await photo.locator(".date-cell, .size-cell").allTextContents();
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/api/mock-control.ts')");
    (await load()).getMockControl().imageResolution = () => ({ width: 600, height: 400 });
    const events = new Function("return import('/src/lib/state/file-events.ts')");
    (await events()).broadcastFileChange(["/home/user/Pictures"]);
  });
  await expect(photo.locator(".resolution-cell")).toHaveText("600 × 400 px");
  expect(await photo.locator(".date-cell, .size-cell").allTextContents()).toEqual(details);
  await page.screenshot({ path: "evidence/ac-4-refreshed-source-resolution.png" });
  const handle = page.getByRole("separator", { name: "Resize Resolution column" });
  const initial = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus(); await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", String(initial + 10));
});

test("large image folders request metadata only for mounted rows and admit rows after scrolling", async ({ page }) => {
  await page.addInitScript(() => {
    const reads: { path: string; mounted: boolean }[] = [];
    window.__mockControl = { imageResolution: path => {
      reads.push({ path, mounted: [...document.querySelectorAll<HTMLElement>(".details-view .file-item")].some(row => row.dataset.path === path) });
      document.documentElement.dataset.resolutionReads = JSON.stringify(reads);
      return { width: 3000, height: 2000 };
    } };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/perf/images-500&viewMode=details");
  const viewport = page.locator(".details-view .virtual-viewport");
  await expect(page.locator(".resolution-cell").last()).toHaveText("3000 × 2000 px");
  const initial = await page.evaluate(() => JSON.parse(document.documentElement.dataset.resolutionReads!) as { path: string; mounted: boolean }[]);
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.length).toBeLessThan(100);
  expect(initial.every(read => read.mounted)).toBe(true);
  const mounted = await page.locator(".details-view .file-item").evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.path!));
  expect(new Set(initial.map(read => read.path))).toEqual(new Set(mounted));
  const lastPath = "/perf/images-500/wedding-00489.jpg";
  expect(initial.map(read => read.path)).not.toContain(lastPath);
  await expect(page.locator(`.file-item[data-path="${lastPath}"]`)).toHaveCount(0);
  await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(`.file-item[data-path="${lastPath}"] .resolution-cell`)).toHaveText("3000 × 2000 px");
  const after = await page.evaluate(() => JSON.parse(document.documentElement.dataset.resolutionReads!) as { path: string; mounted: boolean }[]);
  expect(after.map(read => read.path)).toContain(lastPath);
  expect(after.every(read => read.mounted)).toBe(true);
  expect(after.length).toBeLessThan(200);
});

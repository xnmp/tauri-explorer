/**
 * One resize handle (#1925): every panel handle and split divider takes a
 * --resize-hit (10px) hit area without changing layout, draws its line from
 * the shared tokens, waits --resize-hover-delay before showing the active
 * line on hover, and shows it at once while dragging. Default draws a
 * hairline that grows to an accent bar; Floating Islands draws a capsule grip
 * in the gutter.
 */
import { test, expect, type Page, type Locator } from "./fixtures";
import { runPaletteCommand, seedSettings, waitForEntries } from "./helpers";

const SHOTS = "screenshots/feat/1925-unified-resize-handle";

async function openAll(page: Page, layoutTheme: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedSettings(page, { layoutTheme, showPreviewPane: true, theme: "light" }, { replace: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  // A longer delay than the 250ms default keeps the "not yet" read clear of a
  // loaded runner's latency; the default itself is a Vitest contract.
  await page.evaluate(() => document.documentElement.style.setProperty("--resize-hover-delay", "800ms"));
  await page.keyboard.press("Alt+m"); await page.keyboard.press("t");
  await expect(page.locator(".terminal-panel")).toBeVisible();
  await runPaletteCommand(page, "Split Pane Right");
  const divider = page.locator(".pane-tree:not(.retained) .pane-divider");
  await expect(divider).toHaveCount(1);
  // Measure only once the new pane's entrance has settled: the divider must
  // hold its place across two animation frames.
  await expect.poll(() => divider.evaluate(el => new Promise<boolean>(resolve => {
    const x = el.getBoundingClientRect().x;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.getBoundingClientRect().x === x)));
  }))).toBe(true);
}

const before = (handle: Locator, property: string) =>
  handle.evaluate((el, p) => getComputedStyle(el, "::before").getPropertyValue(p), property);

const width = (selector: string) => async (page: Page) => (await page.locator(selector).first().boundingBox())!.width;
const height = (selector: string) => async (page: Page) => (await page.locator(selector).first().boundingBox())!.height;

/** Each handle, the panel size it drives, and the pointer move that grows it by 40px. */
const HANDLES = [
  { name: "Resize sidebar", size: width(".sidebar-container"), dx: 40, dy: 0, grows: 40 },
  { name: "Resize preview", size: width(".preview-dock"), dx: -40, dy: 0, grows: 40 },
  { name: "Resize terminal", size: height(".terminal-panel"), dx: 0, dy: -40, grows: 40 },
  { name: "Resize panes", size: width('.pane-tree:not(.retained) [data-region="pane"]'), dx: 40, dy: 0, grows: 40 },
];

for (const layout of ["default", "floating-islands"]) {
  test.describe(`${layout} layout`, () => {
    for (const handle of HANDLES) {
      test(`${handle.name}: the hit area is at least --resize-hit and a drag from its edge resizes`, async ({ page }) => {
        await openAll(page, layout);
        const separator = page.getByRole("separator", { name: handle.name, exact: true }).first();
        const box = (await separator.evaluate(el => {
          // Split dividers widen their hit area with ::after; panel handles are the box itself.
          const r = el.getBoundingClientRect(), after = getComputedStyle(el, "::after");
          const vertical = el.getAttribute("aria-orientation") === "vertical";
          const extra = after.content === "none" ? 0
            : -parseFloat(vertical ? after.left : after.top);
          return vertical
            ? { x: r.x - extra, y: r.y, width: r.width + 2 * extra, height: r.height }
            : { x: r.x, y: r.y - extra, width: r.width, height: r.height + 2 * extra };
        }))!;
        const vertical = (await separator.getAttribute("aria-orientation")) === "vertical";
        expect(vertical ? box.width : box.height).toBeGreaterThanOrEqual(10);
        // Press half a pixel inside the hit area's outer edge.
        const x = vertical ? box.x + 0.5 : box.x + box.width / 2;
        const y = vertical ? box.y + box.height / 2 : box.y + 0.5;
        const start = await handle.size(page);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + handle.dx, y + handle.dy, { steps: 4 });
        await expect(separator).toHaveAttribute("data-dragging", /.*/);
        await page.mouse.up();
        // Within half a pixel: a press off the line moves nothing until the pointer does.
        await expect.poll(async () => (await handle.size(page)) - start).toBeCloseTo(handle.grows, 0);
      });
    }

    test("keyboard arrows resize the preview and terminal", async ({ page }) => {
      await openAll(page, layout);
      for (const [name, key] of [["Resize preview", "ArrowLeft"], ["Resize terminal", "ArrowUp"]]) {
        const separator = page.getByRole("separator", { name, exact: true });
        await separator.focus();
        const value = Number(await separator.getAttribute("aria-valuenow"));
        await page.keyboard.press(key);
        await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeGreaterThan(value);
      }
    });
  });
}

test("Default: a hairline at rest, the accent bar only after the hover delay, at once while dragging", async ({ page }) => {
  await openAll(page, "default");
  const accent = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  const sidebar = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await page.mouse.move(640, 300);
  await page.screenshot({ path: `${SHOTS}/default-layout-hairline-rest.png` });
  expect(await before(sidebar, "width")).toBe("1px");
  expect(await before(sidebar, "background-color")).not.toBe(accent);

  const box = (await sidebar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  // Within the delay the line has not changed.
  expect(await before(sidebar, "width")).toBe("1px");
  expect(await before(sidebar, "background-color")).not.toBe(accent);
  await expect.poll(() => before(sidebar, "background-color")).toBe(accent);
  await expect.poll(() => before(sidebar, "width")).toBe("3px");
  await page.screenshot({ path: `${SHOTS}/default-layout-hairline-hover.png` });

  // A drag shows the bar at once, with no delay.
  const preview = page.getByRole("separator", { name: "Resize preview", exact: true });
  const pb = (await preview.boundingBox())!;
  await page.mouse.move(640, 300);
  await expect.poll(() => before(sidebar, "width")).toBe("1px");
  await page.mouse.move(pb.x + pb.width / 2, pb.y + 200);
  await page.mouse.down();
  await page.mouse.move(pb.x - 30, pb.y + 200);
  await expect(preview).toHaveAttribute("data-dragging", /.*/);
  expect(await before(preview, "background-color")).toBe(accent);
  expect(await before(preview, "width")).toBe("3px");
  await page.screenshot({ path: `${SHOTS}/default-layout-dragging.png` });
  await page.mouse.up();
});

test("Floating Islands: no line; a capsule grip in the gutter after the delay, stretched and accent while dragging", async ({ page }) => {
  await openAll(page, "floating-islands");
  const sidebar = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const island = (await page.locator(".sidebar-container").boundingBox())!;
  const pane = (await page.locator('.pane-tree:not(.retained) [data-region="pane"]').first().boundingBox())!;
  const box = (await sidebar.boundingBox())!;
  // The strip spans the gutter without reaching over the panes island, and
  // its grip is centred in the gutter, within a pixel.
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x);
  const grip = box.x + parseFloat(await before(sidebar, "left")) + parseFloat(await before(sidebar, "width")) / 2;
  expect(Math.abs(grip - (island.x + island.width + pane.x) / 2)).toBeLessThanOrEqual(1);

  await page.mouse.move(640, 300);
  expect(await before(sidebar, "background-color")).toBe("rgba(0, 0, 0, 0)");
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  expect(await before(sidebar, "background-color")).toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => before(sidebar, "background-color")).not.toBe("rgba(0, 0, 0, 0)");
  expect(await before(sidebar, "width")).toBe("3px");
  expect(await before(sidebar, "height")).toBe("24px");
  await page.screenshot({ path: `${SHOTS}/floating-islands-gutter-hover.png` });

  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 300, { steps: 3 });
  await expect(sidebar).toHaveAttribute("data-dragging", /.*/);
  expect(await before(sidebar, "height")).toBe("48px");
  await page.screenshot({ path: `${SHOTS}/floating-islands-gutter-dragging.png` });
  await page.mouse.up();
});

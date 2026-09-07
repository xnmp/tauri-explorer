import { test, expect, type Page } from "./fixtures";

let errors: string[] = [];
test.beforeEach(({ page }) => { errors = []; page.on("pageerror", error => errors.push(error.message)); });
test.afterEach(() => expect(errors).toEqual([]));

async function openTerminal(page: Page, zoom = 100) {
  await page.addInitScript(value => localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value })), zoom);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?path=/home/user/Documents");
  await expect(page.locator(".file-list .entry-item").first()).toBeVisible();
  await page.keyboard.press("Control+`");
  await expect(page.locator(".terminal-panel .xterm")).toBeVisible();
}
async function savedHeight(page: Page) {
  return page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    return (await load()).settingsStore.terminalPanelHeight as number;
  });
}
async function begin(page: Page) {
  const handle = page.getByRole("separator", { name: "Resize terminal", exact: true });
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  return { x, y };
}
for (const zoom of [80, 150]) {
  test(`terminal drag follows visual pointer at ${zoom}% and commits on release`, async ({ page }) => {
    await openTerminal(page, zoom);
    const panel = page.locator(".terminal-panel");
    const before = (await panel.boundingBox())!.height, initial = await savedHeight(page);
    const { x, y } = await begin(page);
    await page.mouse.move(x, y - 60, { steps: 4 });
    await expect.poll(async () => (await panel.boundingBox())!.height - before).toBeCloseTo(60, 0);
    expect(await savedHeight(page)).toBe(initial);
    await page.mouse.up();
    await expect.poll(() => savedHeight(page)).toBe(Math.round(initial + 60 / (zoom / 100)));
  });
}
for (const retirement of ["blur", "hide"] as const) {
  test(`terminal ${retirement} retires the drag before later pointer input`, async ({ page }) => {
    await openTerminal(page);
    const initial = await savedHeight(page), { x, y } = await begin(page);
    if (retirement === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else { await page.keyboard.press("Control+`"); await expect(page.locator(".terminal-panel")).toBeHidden(); }
    await page.mouse.move(x, y - 60); await page.mouse.up();
    expect(await savedHeight(page)).toBe(initial);
    if (retirement === "hide") await page.keyboard.press("Control+`");
    await expect.poll(async () => (await page.locator(".terminal-panel").boundingBox())!.height).toBeCloseTo(initial, 0);
  });
}
test("external terminal height replaces an active draft without stale pointer overwrite", async ({ page }) => {
  await openTerminal(page);
  const { x, y } = await begin(page);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.setTerminalPanelHeight(320);
  });
  await expect.poll(async () => (await page.locator(".terminal-panel").boundingBox())!.height).toBeCloseTo(320, 0);
  await page.mouse.move(x, y - 30); await page.mouse.up();
  expect(await savedHeight(page)).toBe(320);
});
test("terminal separator supports bounded vertical keyboard resizing", async ({ page }, testInfo) => {
  await openTerminal(page);
  const handle = page.getByRole("separator", { name: "Resize terminal", exact: true });
  await expect(handle).toHaveAttribute("tabindex", "0");
  const initial = await savedHeight(page);
  await handle.focus(); await page.keyboard.press("ArrowUp");
  await expect.poll(() => savedHeight(page)).toBe(initial + 10);
  await expect.poll(async () => (await page.locator(".terminal-panel").boundingBox())!.height).toBeCloseTo(initial + 10, 0);
  await page.screenshot({ path: testInfo.outputPath("terminal-resize-keyboard.png") });
  await page.keyboard.press("Home"); expect(await savedHeight(page)).toBe(96);
  await page.keyboard.press("End"); expect(await savedHeight(page)).toBe(800);
});

test("disabling Terminal unmounts and releases a live drag", async ({ page }) => {
  await openTerminal(page);
  const initial = await savedHeight(page), { x, y } = await begin(page);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.toggleEnableTerminal();
  });
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  await page.mouse.move(x, y - 60); await page.mouse.up();
  expect(await savedHeight(page)).toBe(initial);
});

test("disabling Terminal after a published drag preserves the size without re-enabling the feature", async ({ page }) => {
  await openTerminal(page);
  const initial = await savedHeight(page), { x, y } = await begin(page);
  await page.mouse.move(x, y - 30);
  await expect.poll(async () => (await page.locator(".terminal-panel").boundingBox())!.height).toBeCloseTo(initial + 30, 0);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.toggleEnableTerminal();
  });
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  await page.mouse.move(x, y - 90); await page.mouse.up();
  await expect.poll(() => savedHeight(page)).toBe(initial + 30);
  const enabled = await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    return (await load()).settingsStore.enableTerminal;
  });
  expect(enabled).toBe(false);
});

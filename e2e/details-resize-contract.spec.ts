import { test, expect, type Page } from "./fixtures";

async function openDetails(page: Page, zoom = 100) {
  await page.addInitScript(value => localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value })), zoom);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user/Documents&viewMode=details");
  await expect(page.locator(".details-view .entry-item").first()).toBeVisible();
}
async function width(page: Page, column = "name") {
  return page.locator(".details-view").evaluate((element, key) => parseFloat(element.style.getPropertyValue(`--col-${key}`)), column);
}
async function begin(page: Page, index = 0) {
  const handle = page.locator(".column-resize-handle").nth(index);
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  return { x, y };
}
let errors: string[] = [];
test.beforeEach(({ page }) => { errors = []; page.on("pageerror", error => errors.push(error.message)); });
test.afterEach(() => expect(errors).toEqual([]));

test("blur retires the column drag before subsequent pointer input", async ({ page }) => {
  await openDetails(page);
  const initial = await width(page), { x, y } = await begin(page);
  await page.mouse.move(x + 30, y);
  await expect.poll(() => width(page)).toBe(initial + 30);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.move(x + 80, y); await page.mouse.up();
  expect(await width(page)).toBe(initial + 30);
});

test("a queued sample cannot move a replacement column", async ({ page }) => {
  await openDetails(page);
  const before = await width(page, "date");
  // Dispatch both gestures in one task, before the browser can publish the old frame.
  await page.evaluate(() => {
    const handles = document.querySelectorAll<HTMLElement>(".column-resize-handle");
    for (const handle of handles) handle.setPointerCapture = () => {};
    const send = (target: EventTarget, type: string, clientX: number) => target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX }),
    );
    send(handles[0], "pointerdown", 300);
    handles[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
    send(handles[0], "pointermove", 350);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 350 }));
    send(handles[1], "pointerdown", 480);
    handles[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 480 }));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await width(page, "date")).toBe(before);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
});

test("column separators resize through keyboard without sorting or changing selection", async ({ page }, testInfo) => {
  await openDetails(page);
  const handle = page.locator(".column-resize-handle").first();
  await expect(handle).toHaveAttribute("tabindex", "0");
  const initial = await width(page);
  const selected = await page.locator(".entry-item.selected").allTextContents();
  await handle.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(page)).toBe(initial + 10);
  await expect(handle).toHaveAttribute("aria-valuenow", String(initial + 10));
  await expect(page.locator(".column-header.name-column")).toHaveClass(/active/);
  expect(await page.locator(".entry-item.selected").allTextContents()).toEqual(selected);
  await page.screenshot({ path: testInfo.outputPath("details-resize-keyboard.png") });
  await page.keyboard.press("Home");
  await expect.poll(() => width(page)).toBe(150);
});

for (const zoom of [80, 150]) {
  test(`continuous column drag follows visual pointer at ${zoom}%`, async ({ page }) => {
    await openDetails(page, zoom);
    const header = page.locator(".column-header-wrapper").first();
    const initial = (await header.boundingBox())!.width;
    const { x, y } = await begin(page);
    for (const delta of [30, 60]) {
      await page.mouse.move(x + delta, y);
      await expect.poll(async () => (await header.boundingBox())!.width - initial).toBeCloseTo(delta, 0);
    }
    await page.mouse.up();
    await expect.poll(async () => (await header.boundingBox())!.width - initial).toBeCloseTo(60, 0);
  });
}

async function toggleDate(page: Page) {
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.toggleColumn("date");
  });
}

test("hiding the dragged column retains only published work and retires input", async ({ page }) => {
  await openDetails(page);
  const initial = await width(page, "date"), { x, y } = await begin(page, 1);
  await page.mouse.move(x + 30, y);
  await expect.poll(() => width(page, "date")).toBe(initial + 30);
  await toggleDate(page);
  await expect(page.getByRole("separator", { name: "Resize Date modified column" })).toHaveCount(0);
  await page.mouse.move(x + 90, y); await page.mouse.up();
  await toggleDate(page);
  await expect(page.getByRole("separator", { name: "Resize Date modified column" })).toBeVisible();
  expect(await width(page, "date")).toBe(initial + 30);
  expect(await width(page, "type")).toBe(140);
});

test("keying another column retires the old draft before changing the key", async ({ page }) => {
  await openDetails(page);
  const { x, y } = await begin(page);
  await page.mouse.move(x + 30, y);
  await expect.poll(() => width(page)).toBe(330);
  const date = page.getByRole("separator", { name: "Resize Date modified column" });
  await date.focus(); await page.keyboard.press("ArrowRight");
  expect(await width(page)).toBe(330);
  expect(await width(page, "date")).toBe(190);
  await page.mouse.move(x + 90, y); await page.mouse.up();
  expect(await width(page)).toBe(330);
  expect(await width(page, "date")).toBe(190);
  await page.keyboard.press("End");
  await expect.poll(() => width(page, "date")).toBe(4096);
  await page.keyboard.press("Home");
  await expect.poll(() => width(page, "date")).toBe(80);
});

test("late capture loss from the old handle cannot retire the replacement handle", async ({ page }) => {
  await openDetails(page);
  await page.evaluate(() => {
    const [name, date] = document.querySelectorAll<HTMLElement>(".column-resize-handle");
    // Model a capture transfer with a delayed loss notification from the old target.
    // Browser pointer capture itself is exercised by all real-mouse cases above.
    name.setPointerCapture = date.setPointerCapture = () => {};
    const send = (target: HTMLElement, type: string, clientX: number) => target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 7, isPrimary: true, button: 0, buttons: 1, clientX }),
    );
    send(name, "pointerdown", 300);
    send(date, "pointerdown", 480);
    send(name, "lostpointercapture", 300);
    send(date, "pointermove", 510);
    send(date, "pointerup", 510);
  });
  expect(await width(page)).toBe(300);
  expect(await width(page, "date")).toBe(210);
});

test("real pointer capture can transfer between column handles", async ({ page }) => {
  await openDetails(page);
  await page.locator(".column-resize-handle").first().evaluate(handle => {
    handle.addEventListener("pointerdown", event => handle.setAttribute("data-pointer", String((event as PointerEvent).pointerId)), { once: true });
  });
  const origin = await begin(page);
  await page.mouse.move(origin.x + 30, origin.y);
  await expect.poll(() => width(page)).toBe(330);
  const point = await page.evaluate(() => {
    const [name, date] = document.querySelectorAll<HTMLElement>(".column-resize-handle");
    const box = date.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    date.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: Number(name.dataset.pointer), isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
    return { x, y };
  });
  await page.mouse.move(point.x + 30, point.y);
  await page.mouse.up();
  expect(await width(page)).toBe(330);
  expect(await width(page, "date")).toBe(210);
});

test("unmounting Details retires a drag before a new view handles input", async ({ page }) => {
  await openDetails(page);
  const { x, y } = await begin(page);
  await page.mouse.move(x + 30, y);
  await expect.poll(() => width(page)).toBe(330);
  const changeView = async (mode: string) => page.evaluate(async viewMode => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    for (const explorer of (await load()).windowTabsManager.getAllExplorers()) explorer.setViewMode(viewMode);
  }, mode);
  await changeView("list");
  await expect(page.locator(".details-view")).toHaveCount(0);
  await page.mouse.move(x + 90, y); await page.mouse.up();
  const file = page.locator('.file-list .entry-item[data-path="/home/user/Documents/notes.md"]');
  await file.click(); await expect(file).toHaveClass(/selected/);
  await changeView("details");
  await expect.poll(() => width(page)).toBe(300); // Column widths are session-local to this mounted view.
  const handle = page.getByRole("separator", { name: "Resize Name column" });
  await handle.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => width(page)).toBe(310);
});

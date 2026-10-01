import { test, expect, type Page } from "./fixtures";

type Dock = "right" | "top" | "bottom";
async function openPreview(page: Page, dock: Dock = "right", zoom = 100, width = 0) {
  await page.addInitScript(settings => {
    if (localStorage.getItem("explorer-settings") === null) localStorage.setItem("explorer-settings", JSON.stringify(settings));
  },
    { zoomLevel: zoom, showPreviewPane: true, previewPanePosition: dock, previewPaneWidth: width });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user");
  await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
  await expect(page.locator(".preview-markdown")).toBeVisible();
}
async function preferences(page: Page) {
  return page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    const store = (await load()).settingsStore;
    return { width: store.previewPaneWidth as number, height: store.previewPaneHeight as number };
  });
}
async function begin(page: Page) {
  const handle = page.locator(".preview-pane .resize-handle");
  await handle.evaluate(element => element.addEventListener("pointerdown", event => {
    element.setAttribute("data-pointer", String((event as PointerEvent).pointerId));
  }, { once: true }));
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  return { x, y };
}
let errors: string[] = [];
test.beforeEach(({ page }) => { errors = []; page.on("pageerror", error => errors.push(error.message)); });
test.afterEach(() => expect(errors).toEqual([]));

for (const dock of ["right", "top", "bottom"] as const) {
  for (const zoom of [80, 150]) {
    test(`${dock} preview follows continuous visual movement at ${zoom}% and commits once released`, async ({ page }) => {
      await openPreview(page, dock, zoom);
      const dimension = dock === "right" ? "width" : "height";
      const pane = page.locator(".preview-pane"), initial = (await pane.boundingBox())![dimension];
      const before = await preferences(page), { x, y } = await begin(page);
      for (const delta of [30, 60]) {
        await page.mouse.move(dock === "right" ? x - delta : x, dock === "right" ? y : y + delta * (dock === "top" ? 1 : -1));
        await expect.poll(async () => (await pane.boundingBox())![dimension] - initial).toBeCloseTo(delta, 0);
        expect(await preferences(page)).toEqual(before);
      }
      await page.mouse.up();
      const expected = (dock === "right" ? 280 : 240) + 60 / (zoom / 100);
      await expect.poll(async () => (await preferences(page))[dimension]).toBeCloseTo(expected, 1);
      await page.reload();
      await expect.poll(async () => (await pane.boundingBox())?.[dimension]).toBeCloseTo(initial + 60, 0);
    });
  }
  test(`${dock} separator supports dock-aware keyboard bounds`, async ({ page }, info) => {
    await openPreview(page, dock);
    const handle = page.locator(".preview-pane .resize-handle");
    await expect(handle).toHaveAttribute("tabindex", "0");
    await expect(handle).toHaveAttribute("aria-orientation", dock === "right" ? "vertical" : "horizontal");
    await handle.focus();
    await page.keyboard.press(dock === "right" ? "ArrowLeft" : dock === "top" ? "ArrowDown" : "ArrowUp");
    const dimension = dock === "right" ? "width" : "height", expected = dock === "right" ? 290 : 250;
    await expect.poll(async () => (await preferences(page))[dimension]).toBe(expected);
    await expect(handle).toHaveAttribute("aria-valuenow", String(expected));
    await page.screenshot({ path: info.outputPath(`preview-resize-${dock}.png`) });
    await page.keyboard.press("Home");
    await expect.poll(async () => (await preferences(page))[dimension]).toBe(dock === "right" ? 160 : 120);
    await page.keyboard.press("End");
    await expect.poll(async () => (await preferences(page))[dimension]).toBe(600);
  });
}

test("blur retires preview input before later movement", async ({ page }) => {
  await openPreview(page);
  const before = await preferences(page), { x, y } = await begin(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.move(x - 60, y); await page.mouse.up();
  expect(await preferences(page)).toEqual(before);
});

test("switching top to bottom discards the old-direction draft", async ({ page }) => {
  await openPreview(page, "top");
  const { x, y } = await begin(page);
  await page.mouse.move(x, y + 30);
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.height).toBeCloseTo(270, 0);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.setPreviewPanePosition("bottom");
  });
  await expect(page.locator(".preview-pane")).toHaveClass(/dock-bottom/);
  await page.mouse.move(x, y + 80); await page.mouse.up();
  expect((await preferences(page)).height).toBe(0);
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.height).toBeCloseTo(240, 0);
});

for (const [initial, external] of [[280, 0], [0, 280]] as const) {
  test(`external ${initial} → ${external} wins over a same-size source at synchronous release`, async ({ page }) => {
    await openPreview(page, "right", 100, initial);
    const { x, y } = await begin(page);
    await page.mouse.move(x - 30, y);
    await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(310, 0);
    await page.evaluate(async value => {
      const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
      (await load()).settingsStore.setPreviewPaneWidth(value);
      const handle = document.querySelector<HTMLElement>(".preview-pane .resize-handle")!;
      handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: Number(handle.dataset.pointer), isPrimary: true }));
    }, external);
    await page.mouse.move(x - 80, y); await page.mouse.up();
    expect((await preferences(page)).width).toBe(external);
    await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(280, 0);
  });
}

test("double-clicking a resize separator does not enter fullscreen", async ({ page }) => {
  await openPreview(page);
  await page.locator(".preview-pane .resize-handle").dblclick();
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
  expect(await preferences(page)).toEqual({ width: 0, height: 0 });
});

test("fullscreen retires the dock resize and exposes no active dock handle", async ({ page }) => {
  await openPreview(page);
  const { x, y } = await begin(page);
  await page.mouse.move(x - 30, y);
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(310, 0);
  await page.locator(".preview-header").dispatchEvent("dblclick");
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  await expect(page.locator(".preview-pane .resize-handle")).toHaveCount(0);
  await page.mouse.move(x - 60, y); await page.mouse.up();
  expect((await preferences(page)).width).toBe(310);
  await page.keyboard.press("Escape");
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(310, 0);
});

for (const [from, to] of [["right", "bottom"], ["top", "right"]] as const) {
  test(`switching ${from} → ${to} cannot commit the draft into either dimension`, async ({ page }) => {
    await openPreview(page, from);
    const { x, y } = await begin(page), dimension = from === "right" ? "width" : "height";
    await page.mouse.move(from === "right" ? x - 30 : x, from === "right" ? y : y + 30);
    await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())![dimension])
      .toBeCloseTo(from === "right" ? 310 : 270, 0);
    await page.evaluate(async dock => {
      const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
      (await load()).settingsStore.setPreviewPanePosition(dock);
    }, to);
    if (to === "right") await expect(page.locator(".preview-pane")).not.toHaveClass(/vertical/);
    else await expect(page.locator(".preview-pane")).toHaveClass(/dock-bottom/);
    await page.mouse.move(x - 80, y + 80); await page.mouse.up();
    expect(await preferences(page)).toEqual({ width: 0, height: 0 });
    await expect(page.locator(".preview-markdown")).toBeVisible();
    const box = (await page.locator(".preview-pane").boundingBox())!;
    expect(to === "right" ? box.width : box.height).toBeCloseTo(to === "right" ? 280 : 240, 0);
  });
}

test("unmounting preview retains the published size and ignores late input", async ({ page }) => {
  await openPreview(page);
  const { x, y } = await begin(page);
  await page.mouse.move(x - 30, y);
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(310, 0);
  const toggle = () => page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.togglePreviewPane();
  });
  await toggle(); await expect(page.locator(".preview-pane")).toHaveCount(0);
  await page.mouse.move(x - 80, y); await page.mouse.up();
  expect((await preferences(page)).width).toBe(310);
  await toggle(); await expect(page.locator(".preview-markdown")).toBeVisible();
  await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())!.width).toBeCloseTo(310, 0);
});

test("markdown links do not trigger the pane fullscreen gesture", async ({ page }) => {
  await openPreview(page);
  await page.locator(".preview-markdown a").dispatchEvent("dblclick");
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
});

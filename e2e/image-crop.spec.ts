import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries, VIEW_MODES } from "./helpers";

const source = "/home/user/Pictures/screenshot.png";
async function open(page: Page, mode: string, zoom = 1, fullscreen = false, dock = "right") {
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, { showPreviewPane: true, viewMode: mode, zoomLevel: zoom * 100, previewPanePosition: dock });
  await expect.poll(() => page.evaluate(() => {
    const value = document.documentElement.style.zoom;
    return value.endsWith("%") ? parseFloat(value) / 100 : Number(value);
  })).toBe(zoom);
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  if (fullscreen) {
    await page.locator(".preview-image").click();
    await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  }
  await page.getByRole("button", { name: "Crop image…", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Right crop edge" })).toHaveAttribute("aria-valuenow", "512");
}
async function imageData(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const { invoke } = await import("/src/lib/api/common.ts");
    return invoke<string>("read_image_data_url", { path });
  }, path);
}
async function dragEdge(page: Page, edge: string, position: number) {
  const edges = ["left", "top", "right", "bottom"];
  const values = () => page.locator(".crop-edge").evaluateAll((handles) => Object.fromEntries(handles.map((handle) => [handle.getAttribute("aria-label")!.split(" ")[0].toLowerCase(), Number(handle.getAttribute("aria-valuenow"))])));
  const before = await values();
  const slider = page.getByRole("slider", { name: `${edge[0].toUpperCase()}${edge.slice(1)} crop edge` });
  await slider.scrollIntoViewIfNeeded();
  const geometry = await page.locator(".crop-image img").boundingBox();
  const handle = await slider.boundingBox();
  if (!geometry || !handle) throw new Error("Crop geometry is unavailable");
  // Native pointers have whole client pixels. WebKit also truncates synthetic
  // floats. Fit can show more source pixels than client pixels; verify the
  // nearest reachable boundary, then use the documented precise arrow keys.
  const horizontal = edge === "left" || edge === "right";
  const x = Math.round(horizontal ? geometry.x + position / 512 * geometry.width : handle.x + handle.width / 2);
  const y = Math.round(!horizontal ? geometry.y + position / 384 * geometry.height : handle.y + handle.height / 2);
  const nearest = Math.round(horizontal ? (x - geometry.x) / geometry.width * 512 : (y - geometry.y) / geometry.height * 384);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(x, y, { steps: 3 }); await page.mouse.up();
  await expect(slider).toHaveAttribute("aria-valuenow", String(nearest));
  const after = await values();
  for (const other of edges.filter((item) => item !== edge)) expect(after[other]).toBe(before[other]);
  expect(Math.abs(nearest - position)).toBeLessThanOrEqual(1);
  await slider.focus();
  const key = horizontal ? nearest > position ? "ArrowLeft" : "ArrowRight" : nearest > position ? "ArrowUp" : "ArrowDown";
  for (let i = 0; i < Math.abs(nearest - position); i++) await page.keyboard.press(key);
  await expect(slider).toHaveAttribute("aria-valuenow", String(position));
}
for (const mode of VIEW_MODES) {
  for (const zoom of [1, 1.5]) for (const fullscreen of [false, true]) {
    test(`crop edges and saved PNG pixels in ${mode}, app zoom ${zoom}, fullscreen ${fullscreen}`, async ({ page }) => {
      await open(page, mode, zoom, fullscreen);
      const before = await imageData(page, source);
      for (const [edge, position] of [["left", 32], ["top", 24], ["right", 480], ["bottom", 360]] as const) await dragEdge(page, edge, position);
      const left = page.getByRole("slider", { name: "Left crop edge" });
      await left.focus(); await page.keyboard.press("Shift+ArrowRight");
      await expect(left).toHaveAttribute("aria-valuenow", "42");
      await page.keyboard.press("Shift+ArrowLeft");
      await expect(page.locator(".crop-output")).toHaveText("Selected: 448 × 336 px");
      await page.getByRole("button", { name: "Zoom in crop" }).click();
      await page.getByRole("button", { name: "Zoom in crop" }).click();
      await page.locator(".crop-scroller").evaluate((element) => { element.scrollLeft = 140; element.scrollTop = 100; });
      await expect(left).toHaveAttribute("aria-valuenow", "32");
      await dragEdge(page, "left", 40);
      await left.focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".crop-output")).toHaveText("Selected: 448 × 336 px");
      await page.getByRole("button", { name: "Save copy", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Crop image", exact: true })).toBeHidden();
      expect(await imageData(page, source)).toBe(before);
      const target = "/home/user/Pictures/screenshot - Cropped.png";
      const saved = await imageData(page, target);
      expect(await page.evaluate(async ({ original, saved }) => {
        const load = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image; };
        const images = await Promise.all([load(original), load(saved)]);
        const pixels = (image: HTMLImageElement, x: number, y: number, w: number, h: number) => {
          const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
          const context = canvas.getContext("2d")!; context.drawImage(image, x, y, w, h, 0, 0, w, h);
          return context.getImageData(0, 0, w, h).data;
        };
        const expected = pixels(images[0], 32, 24, 448, 336); const actual = pixels(images[1], 0, 0, 448, 336);
        return { size: [images[1].naturalWidth, images[1].naturalHeight], exact: actual.every((value, i) => value === expected[i]), alpha: actual[(168 * 448 + 224) * 4 + 3] };
      }, { original: before, saved })).toEqual({ size: [448, 336], exact: true, alpha: 0 });
      if (fullscreen) await page.keyboard.press("Escape");
      const row = page.locator(".entry-item", { hasText: "screenshot - Cropped.png" });
      await expect(row).toBeVisible(); await row.click();
      await expect.poll(() => page.locator(".preview-image").evaluate((image) => [(image as HTMLImageElement).naturalWidth, (image as HTMLImageElement).naturalHeight])).toEqual([448, 336]);
    });
  }
  test(`cancel and explicit replacement in ${mode}`, async ({ page }) => {
    await open(page, mode);
    const before = await imageData(page, source);
    await page.getByRole("spinbutton", { name: "left pixel position" }).fill("32");
    await page.getByRole("button", { name: "Replace original…", exact: true }).click();
    await expect(page.getByRole("group", { name: "Confirm replacement" })).toContainText("This changes the original image");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    expect(await imageData(page, source)).toBe(before);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await imageData(page, source)).toBe(before);
    await page.getByRole("button", { name: "Crop image…", exact: true }).click();
    await page.getByRole("spinbutton", { name: "left pixel position" }).fill("32");
    await page.getByRole("button", { name: "Replace original…", exact: true }).click();
    await page.getByRole("button", { name: "Confirm replacement", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Crop image", exact: true })).toBeHidden();
    expect(await imageData(page, source)).not.toBe(before);
    await expect.poll(() => page.locator(".preview-image").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(480);
  });
}

test("pixel positions can be typed digit by digit and commit on blur or Enter", async ({ page }) => {
  await open(page, "details");
  const left = page.getByRole("spinbutton", { name: "left pixel position" });
  await left.fill("32"); await left.press("Tab");
  const right = page.getByRole("spinbutton", { name: "right pixel position" });
  await right.focus(); await right.press("ControlOrMeta+A"); await right.pressSequentially("480");
  await expect(right).toHaveValue("480");
  await right.press("Tab");
  await expect(page.getByRole("slider", { name: "Right crop edge" })).toHaveAttribute("aria-valuenow", "480");
  await left.fill(""); await left.press("Tab");
  await expect(left).toHaveValue("32");
  await right.fill("470"); await right.press("Enter");
  await expect(page.locator(".crop-output")).toHaveText("Selected: 438 × 384 px");
});

test("an accepted save keeps modal input ownership through Escape and settles once", async ({ page }) => {
  await open(page, "details");
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const control = getMockControl();
    control.imageCropSave = async () => {
      document.documentElement.dataset.cropSaveAccepted = "true";
      await new Promise<void>((resolve) => window.addEventListener("release-crop-save", () => resolve(), { once: true }));
      delete control.imageCropSave;
      throw new Error("Held native save refused for this fixture");
    };
  });
  await page.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cropSaveAccepted)).toBe("true");
  await page.keyboard.press("Escape"); await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.locator(".command-palette-dialog")).toBeHidden();
  await expect(page.getByRole("dialog", { name: "Crop image", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-crop-save")));
  await expect(page.getByRole("alert")).toHaveText("Held native save refused for this fixture");
  const count = await page.evaluate(async () => (await import("/src/lib/api/mock-control.ts")).getMockControl().invokeCounts?.save_image_crop);
  expect(count).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Crop image", exact: true })).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.locator(".command-palette-dialog")).toBeVisible();
});

for (const dock of ["right", "top", "bottom"]) {
  test(`resizing a zoomed ${dock} preview keeps crop controls keyboard reachable`, async ({ page }) => {
    await open(page, "details", 1.5, false, dock);
    await page.setViewportSize({ width: 640, height: 480 });
    const dialog = page.getByRole("dialog", { name: "Crop image", exact: true });
    const left = page.getByRole("slider", { name: "Left crop edge" });
    await left.focus(); await page.keyboard.press("ArrowRight");
    await expect(left).toHaveAttribute("aria-valuenow", "1");
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    const save = page.getByRole("button", { name: "Save copy", exact: true });
    await save.focus();
    const bounds = await save.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(481);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    const target = "/home/user/Pictures/screenshot - Cropped.png";
    expect(await page.evaluate(async (url) => {
      const image = new Image(); image.src = url; await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, await imageData(page, target))).toEqual([511, 384]);
  });
}

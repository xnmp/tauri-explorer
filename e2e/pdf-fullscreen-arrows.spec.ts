import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

const PDF_PATH = "/home/user/Documents/report.pdf";
const PAGE_COLORS = [
  [255, 0, 0, 255],
  [153, 0, 204, 255],
  [255, 128, 0, 255],
];

async function openPdf(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings", JSON.stringify({
      showPreviewPane: false, previewPaneWidth: 420, zoomLevel: 150, theme: "light",
    }));
  });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator(`.entry-item[data-path="${PDF_PATH}"]`).click();
  await page.keyboard.press("Space");
  await expectPdfPage(page, 1, false);
  await page.getByRole("button", { name: "View PDF fullscreen", exact: true }).click();
  await page.locator(".pdf-viewport").focus();
  await expectPdfPage(page, 1);
}

async function expectPdfPage(page: Page, number: number, fullscreen = true) {
  await expect(page.locator(".pdf-preview")).toHaveAttribute("data-path", PDF_PATH);
  await expect(page.locator(".entry-item.selected")).toHaveCount(1);
  await expect(page.locator(".entry-item.selected")).toHaveAttribute("data-path", PDF_PATH);
  await expect(page.locator(".page-count")).toHaveText(`${number} / 3`);
  await expect(page.locator(".pdf-page.ready")).toBeVisible();
  await expect.poll(() => page.locator(".pdf-canvas canvas").evaluate((canvas: HTMLCanvasElement) => [
    ...canvas.getContext("2d")!.getImageData(
      Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1,
    ).data,
  ])).toEqual(PAGE_COLORS[number - 1]);
  if (fullscreen) await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  else await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
}

for (const zoomed of [false, true]) {
  test(`fullscreen PDF arrows render pages and clamp boundaries, zoomed=${zoomed}`, async ({ page }, testInfo) => {
    await openPdf(page);
    const pressArrow = async (key: string, number: number) => {
      // Page selection resets PDF zoom. Enlarge again before every arrow so
      // both directions and both boundaries exercise the zoomed handler.
      if (zoomed) {
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        for (let i = 0; i < 3; i++)
          await page.getByRole("button", { name: "Zoom PDF in", exact: true }).click();
        await expect(page.locator(".pdf-zoom")).toHaveText("130%");
      }
      await page.locator(".pdf-viewport").focus();
      await page.keyboard.press(key);
      await expectPdfPage(page, number);
    };

    await pressArrow("ArrowLeft", 1);
    await pressArrow("ArrowRight", 2);
    if (!zoomed) await page.screenshot({ path: testInfo.outputPath("forward-page-2.png"), animations: "disabled" });
    await pressArrow("ArrowLeft", 1);
    await pressArrow("ArrowRight", 2);
    await pressArrow("ArrowRight", 3);
    await pressArrow("ArrowRight", 3);
    if (!zoomed) await page.screenshot({ path: testInfo.outputPath("last-page-boundary.png"), animations: "disabled" });
    await pressArrow("ArrowLeft", 2);
  });
}

test("fullscreen PDF arrows respect focused links, buttons and modal controls", async ({ page }, testInfo) => {
  await openPdf(page);
  const link = page.locator('a.pdf-link[href="https://example.com/pdf-proof"]');
  await link.focus();
  await page.keyboard.press("ArrowRight");
  await expectPdfPage(page, 1);
  await page.keyboard.press("ArrowLeft");
  await expectPdfPage(page, 1);
  await expect(link).toBeFocused();
  await link.click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __mockControl?: { openedPdfUrl?: string } }).__mockControl?.openedPdfUrl,
  )).toBe("https://example.com/pdf-proof");

  const next = page.getByRole("button", { name: "Next PDF page", exact: true });
  await next.focus();
  await page.keyboard.press("ArrowRight");
  await expectPdfPage(page, 1);
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expectPdfPage(page, 2);

  await page.keyboard.press("Control+,");
  const settings = page.locator(".settings-dialog");
  await expect(settings).toBeVisible();
  // Async language-model settings insert selects before Theme. Keep every
  // focus assertion attached to the same control as those sections load.
  const control = settings.locator(".color-theme-select");
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeFocused();
  for (const key of ["ArrowRight", "ArrowLeft", "PageDown"]) {
    await page.keyboard.press(key);
    await expectPdfPage(page, 2);
    await expect(control).toBeFocused();
  }
  await control.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("modal-owns-keys.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await page.locator(".pdf-viewport").focus();
  await page.keyboard.press("ArrowLeft");
  await expectPdfPage(page, 1);
});

test("PDF page buttons, vertical page keys, zoom and docked sibling arrows remain usable", async ({ page }) => {
  await openPdf(page);
  await page.getByRole("button", { name: "Next PDF page", exact: true }).click();
  await expectPdfPage(page, 2);
  await page.getByRole("button", { name: "Previous PDF page", exact: true }).click();
  await expectPdfPage(page, 1);
  await page.locator(".pdf-viewport").focus();
  await page.keyboard.press("PageDown");
  await expectPdfPage(page, 2);
  await page.keyboard.press("PageUp");
  await expectPdfPage(page, 1);
  await page.keyboard.press("+");
  await expect(page.locator(".pdf-zoom")).toHaveText("110%");
  await page.keyboard.press("-");
  await expect(page.locator(".pdf-zoom")).toHaveText("100%");
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  await expect(page.locator(".pdf-zoom")).toHaveText("100%");
  await page.keyboard.press("Escape");
  await expectPdfPage(page, 1, false);
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".entry-item.selected")).toHaveAttribute("data-path", "/home/user/Documents/presentation.pptx");
  await expect(page.locator(".pdf-preview")).toHaveCount(0);
  await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
});

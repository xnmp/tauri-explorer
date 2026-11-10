/**
 * E2E: the PDF preview's controls stay on one row at every supported preview
 * width, at 100 % and 130 % UI zoom (#1583). The bar used to wrap below about
 * 310px and strand the fullscreen button alone on a second row at the 280px
 * default. Page navigation and fullscreen stay available down to the 160px
 * minimum; the default width keeps every control.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings, waitForEntries } from "./helpers";

const PDF_PATH = "/home/user/Documents/report.pdf";
/** The resize bounds' minimum, steps up to the default, and a roomy width. */
const WIDTHS = [160, 200, 240, 280, 320, 420] as const;
const DEFAULT_WIDTH = 280;
const ZOOMS = [100, 130] as const;

const ESSENTIAL = ["Previous PDF page", "Next PDF page", "View PDF fullscreen"];
const ZOOM_CONTROLS = ["Zoom PDF out", "Zoom PDF in"];

interface BarLayout {
  rows: number;
  /**
   * Viewport px of control boxes outside the bar on either side: a centred
   * row clips both ends, and `scrollWidth` sees only the right one (and is
   * off by one under WebKit's root zoom even when nothing overflows).
   */
  overflow: number;
  visibleLabels: string[];
  fitVisible: boolean;
  magnificationVisible: boolean;
  pageCountVisible: boolean;
  paneWidth: number;
}

async function openPdf(page: Page, settings: Record<string, unknown>): Promise<void> {
  await seedSettings(page, { showPreviewPane: true, previewPanePosition: "right", ...settings });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator(`.entry-item[data-path="${PDF_PATH}"]:visible`).click();
  await expect(page.locator(".pdf-page.ready")).toBeVisible({ timeout: 15000 });
}

/** Rows are counted from the rendered control boxes, not from a class. */
function barLayout(page: Page): Promise<BarLayout> {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".pdf-controls")!;
    const shown = (el: Element | null) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const leaves = [...bar.querySelectorAll("button, output, .page-count")].filter(shown);
    const centres = leaves.map((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    const rows: number[] = [];
    for (const centre of centres) if (!rows.some((row) => Math.abs(row - centre) < 4)) rows.push(centre);
    const box = bar.getBoundingClientRect();
    const clipped = leaves.map((el) => {
      const rect = el.getBoundingClientRect();
      return Math.max(0, box.left - rect.left, rect.right - box.right);
    });
    // Sub-pixel rounding of zoomed boxes is not clipping.
    const overflow = Math.max(0, ...clipped);
    return {
      rows: rows.length,
      overflow: overflow < 0.75 ? 0 : overflow,
      visibleLabels: leaves.map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""),
      fitVisible: shown(bar.querySelector(".fit-button")),
      magnificationVisible: shown(bar.querySelector(".pdf-zoom")),
      pageCountVisible: shown(bar.querySelector(".page-count")),
      paneWidth: document.querySelector<HTMLElement>(".pdf-preview")!.offsetWidth,
    };
  });
}

for (const zoom of ZOOMS) {
  for (const width of WIDTHS) {
    test(`PDF controls stay on one row at ${width}px and ${zoom}% zoom`, async ({ page }) => {
      await openPdf(page, { previewPaneWidth: width, zoomLevel: zoom });
      const layout = await barLayout(page);

      expect(layout.rows, JSON.stringify(layout)).toBe(1);
      expect(layout.overflow, JSON.stringify(layout)).toBeLessThanOrEqual(0);
      expect(layout.pageCountVisible).toBe(true);
      for (const label of ESSENTIAL) expect(layout.visibleLabels).toContain(label);
      if (width >= DEFAULT_WIDTH) {
        for (const label of ZOOM_CONTROLS) expect(layout.visibleLabels).toContain(label);
        expect(layout.magnificationVisible).toBe(true);
        expect(layout.fitVisible).toBe(true);
      }
    });
  }
}

test("the default-width PDF controls are one row in the light and dark themes", async ({ page }) => {
  for (const theme of ["light", "dark"]) {
    await openPdf(page, { previewPaneWidth: 0, theme });
    const layout = await barLayout(page);
    expect(layout.rows, `${theme}: ${JSON.stringify(layout)}`).toBe(1);
    expect(layout.visibleLabels).toEqual(expect.arrayContaining([...ESSENTIAL, ...ZOOM_CONTROLS]));
    expect(layout.fitVisible).toBe(true);
    if (theme === "light") {
      await page.locator(".preview-pane").screenshot({
        path: "screenshots/fix/content-search-late-cancel/pdf-controls-narrow-fixed.png",
        animations: "disabled",
      });
    }
  }
});

test("narrowed-away zoom controls still work from the keyboard", async ({ page }) => {
  await openPdf(page, { previewPaneWidth: 160 });
  await page.locator(".pdf-viewport").focus();
  await page.keyboard.press("+");
  await page.locator(".pdf-viewport").focus();
  await expect(page.locator(".pdf-zoom")).toHaveCount(0);
  // The magnification readout is gone at this width; the fullscreen bar shows it.
  await page.getByRole("button", { name: "View PDF fullscreen" }).click();
  await expect(page.getByRole("button", { name: "Zoom PDF in" })).toBeVisible();
  const layout = await barLayout(page);
  expect(layout.rows).toBe(1);
  expect(layout.visibleLabels).toEqual(expect.arrayContaining([...ZOOM_CONTROLS, "Exit PDF fullscreen"]));
  await expect(page.locator(".pdf-zoom:visible")).toHaveText("110%");
});

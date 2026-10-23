import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const documentSource = `<!doctype html><html><head><style>
body { margin: 24px; background: #f1f5f9; color: #16324f; font: 16px sans-serif; }
h1 { color: #156e63; } .card { background: white; border-radius: 12px; padding: 20px; }
</style></head><body><div class="card"><h1>Project overview</h1><p>A rendered HTML document.</p><ul><li>Design complete</li><li>Ready for review</li></ul></div>
<script>parent.document.body.dataset.htmlEscaped = 'yes'; while(true) {}</script>
<img src="https://example.invalid/preview-tracker"><a href="https://example.invalid" target="_top">External link</a>
${"\n".repeat(220)}<p>End of document</p></body></html>`;

// A fixed-width desktop layout: wider than any docked preview pane.
const wideDocumentSource = `<!doctype html><html><body style="margin:0">
<div class="wide" style="width:1200px;height:900px;background:linear-gradient(90deg,#156e63,#16324f)"><h1 style="color:white;margin:0;padding:24px">Quarterly report</h1></div>
</body></html>`;

// A responsive page: three columns at desktop widths, fewer when narrow.
const cardsDocumentSource = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<style>.wide-only{display:none}@media (min-width:1500px){.wide-only{display:block}}</style>
<main style="max-width:1100px;margin:0 auto;padding:24px"><h1>Shortlist</h1><p class="wide-only">Wide layout</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
${[1, 2, 3, 4, 5, 6].map(n => `<section class="card" style="height:200px;background:#e8eefc">Card ${n}</section>`).join("")}
</div>${"<p>Paragraph text.</p>".repeat(60)}</main></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ source, wideSource, cardsSource }) => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    control.directoryEntries = path => path === "/home/html-preview" ? ["page.html", "page.HTM", "slow.html", "source.txt", "wide.html", "cards.html"].map(name => ({
      name, path: `${path}/${name}`, kind: "file" as const, size: 2048, modified: "2026-01-01T00:00:00Z",
    })) : [];
    control.previewReadText = path => {
      if (path.endsWith("slow.html")) {
        document.body.dataset.htmlReadPending = "yes";
        return new Promise<string>(resolve => document.addEventListener("finish-html-read", () => {
          delete document.body.dataset.htmlReadPending;
          resolve("<h1>Obsolete preview</h1>");
        }, { once: true }));
      }
      if (path.endsWith("cards.html")) return cardsSource;
      if (path.endsWith("wide.html")) {
        document.body.dataset.wideReads = String(Number(document.body.dataset.wideReads ?? 0) + 1);
        return wideSource;
      }
      return path.endsWith("source.txt") ? "<h1>Keep this as source</h1>" : source;
    };
  }, { source: documentSource, wideSource: wideDocumentSource, cardsSource: cardsDocumentSource });
  await page.goto("/?path=/home/html-preview");
  await waitForEntries(page);
  if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ", {});
});

for (const name of ["page.html", "page.HTM"]) {
  test(`renders ${name} as an isolated document and preserves text source`, async ({ page }) => {
    let remoteImageRequests = 0;
    await page.route("https://example.invalid/preview-tracker", async route => {
      remoteImageRequests++;
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>' });
    });
    await page.locator(`[data-path="/home/html-preview/${name}"]`).click();
    const frame = page.frameLocator('iframe[title="HTML preview"]');
    await expect(frame.locator("h1")).toHaveText("Project overview");
    await expect(frame.locator("body")).toContainText("End of document");
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(21, 110, 99)");
    await expect(page.locator(".preview-text")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-html-escaped");
    expect(await page.locator("iframe").evaluate((element: HTMLIFrameElement) => element.contentDocument === null)).toBe(true);
    // Assert the image's actual blocked result. WebKit omits requestfailed
    // events for CSP; a fulfilled route makes a missing CSP load successfully
    // instead of accidentally passing because example.invalid cannot resolve.
    await expect.poll(() => frame.locator('img').evaluate((image: HTMLImageElement) => ({
      complete: image.complete, width: image.naturalWidth,
    }))).toEqual({ complete: true, width: 0 });
    expect(remoteImageRequests).toBe(0);
    if (name === "page.html") await page.screenshot({ path: "evidence/1332-html-preview.png" });
    await page.locator('[data-path="/home/html-preview/source.txt"]').click();
    await expect(page.locator(".preview-text")).toHaveText("<h1>Keep this as source</h1>");
    await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
  });
}

test("selection and navigation proceed while an HTML read is pending", async ({ page }) => {
  await page.locator('[data-path="/home/html-preview/slow.html"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-html-read-pending", "yes");
  await page.locator('[data-path="/home/html-preview/source.txt"]').click();
  await expect(page.locator(".preview-text")).toHaveText("<h1>Keep this as source</h1>");
  await page.evaluate(() => document.dispatchEvent(new Event("finish-html-read")));
  await expect(page.locator("body")).not.toHaveAttribute("data-html-read-pending");
  await expect(page.locator(".preview-text")).toHaveText("<h1>Keep this as source</h1>");
  await page.locator('[data-path="/home/html-preview/slow.html"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-html-read-pending", "yes");
  await page.getByRole("button", { name: "Go up one level", exact: true }).click();
  await expect(page.locator('[data-path="/home/html-preview/slow.html"]')).toHaveCount(0);
  await page.evaluate(() => document.dispatchEvent(new Event("finish-html-read")));
  await expect(page.locator('iframe[title="HTML preview"]')).toHaveCount(0);
});

test("HTML preview fits wide documents by default and zooms on request (#1352)", async ({ page }) => {
  await page.locator('[data-path="/home/html-preview/wide.html"]').click();
  const viewport = page.locator(".html-viewport");
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  const zoomLabel = page.getByLabel("HTML magnification");
  await expect(frame.locator("h1")).toHaveText("Quarterly report");
  const pane = (await viewport.boundingBox())!;
  expect(pane.width).toBeLessThan(1200);

  const visibleWidth = async () => (await frame.locator(".wide").boundingBox())!.width;
  // Fit: the whole 1200px layout is painted inside the pane.
  await expect.poll(visibleWidth).toBeLessThanOrEqual(pane.width + 1);
  const fitWidth = await visibleWidth();
  expect(fitWidth).toBeGreaterThan(pane.width * 0.8);
  const fitLabel = Number.parseInt((await zoomLabel.textContent())!, 10);
  expect(fitLabel).toBeLessThan(100);

  await page.getByRole("button", { name: "Zoom HTML in" }).click();
  await expect.poll(async () => Number.parseInt((await zoomLabel.textContent())!, 10)).toBeGreaterThan(fitLabel);
  await expect.poll(visibleWidth).toBeGreaterThan(fitWidth);

  // 100%: one CSS pixel per screen pixel. The desktop page overflows the pane,
  // which scrolls horizontally; the frame stays exactly as tall as the pane.
  await page.getByRole("button", { name: "100%" }).click();
  await expect(zoomLabel).toHaveText("100%");
  await expect.poll(visibleWidth).toBeCloseTo(1200, 0);
  const scrollRange = () => viewport.evaluate((el) => el.scrollWidth - el.clientWidth);
  await expect.poll(scrollRange).toBeGreaterThan(1200 - pane.width - 2);
  const iframe = page.locator('iframe[title="HTML preview"]');
  const visibleHeight = await viewport.evaluate((el) => el.clientHeight);
  expect(Math.abs((await iframe.boundingBox())!.height - visibleHeight)).toBeLessThan(2);
  const leftBefore = (await frame.locator(".wide").boundingBox())!.x;
  await viewport.hover({ position: { x: 20, y: 20 } });
  await page.mouse.wheel(300, 0);
  await expect.poll(async () => (await frame.locator(".wide").boundingBox())!.x).toBeLessThan(leftBefore - 50);

  // A watcher/local-change reload of the same document keeps the chosen zoom.
  const reads = Number(await page.locator("body").getAttribute("data-wide-reads"));
  await page.evaluate(async () => {
    const events = await import(/* @vite-ignore */ "/src/lib/state/file-events.ts");
    events.broadcastFileChange(["/home/html-preview"]);
  });
  await expect(page.locator("body")).toHaveAttribute("data-wide-reads", String(reads + 1));
  await expect(frame.locator("h1")).toHaveText("Quarterly report");
  await expect(zoomLabel).toHaveText("100%");
  await expect.poll(visibleWidth).toBeCloseTo(1200, 0);

  // Zooming out reveals more of the page: the horizontal scroll range shrinks (#1361).
  const range100 = await scrollRange();
  await page.getByRole("button", { name: "Zoom HTML out" }).click();
  await expect.poll(scrollRange).toBeLessThan(range100 - 50);

  await page.getByRole("button", { name: "Fit" }).click();
  await expect(zoomLabel).toHaveText(`${fitLabel}%`);
  await expect.poll(scrollRange).toBeLessThanOrEqual(1);

  // A newly selected document starts at Fit again.
  await page.getByRole("button", { name: "100%" }).click();
  await page.locator('[data-path="/home/html-preview/page.html"]').click();
  await expect(page.locator('iframe[title="HTML preview"]').contentFrame().locator("h1")).toHaveText("Project overview");
  await page.locator('[data-path="/home/html-preview/wide.html"]').click();
  await expect(zoomLabel).toHaveText(`${fitLabel}%`);
  await page.screenshot({ path: "evidence/1352-html-preview-fit.png" });
});

test("HTML zoom magnifies a responsive page without reflowing it (#1361)", async ({ page }) => {
  await page.locator('[data-path="/home/html-preview/cards.html"]').click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.locator("h1")).toHaveText("Shortlist");
  const zoomLabel = page.getByLabel("HTML magnification");
  /** Distinct card columns in the first row, as painted. */
  const firstRowCards = () => frame.locator(".card").evaluateAll((cards) => {
    const top = cards[0].getBoundingClientRect().top;
    return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 1).length;
  });
  await expect.poll(firstRowCards).toBe(3);
  for (const step of ["100%", "Zoom HTML out", "Zoom HTML out"]) {
    await page.getByRole("button", { name: step }).click();
    await expect.poll(firstRowCards, { message: `after ${step} (${await zoomLabel.textContent()})` }).toBe(3);
  }
  await page.getByRole("button", { name: "100%" }).click();
  await page.screenshot({ path: "evidence/1361-html-zoom-no-reflow.png" });
});

test("zooming in a wide pane magnifies the same layout without switching breakpoints (#1361)", async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 900 });
  await page.locator('[data-path="/home/html-preview/cards.html"]').click();
  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.locator("h1")).toHaveText("Shortlist");
  await page.getByRole("button", { name: "View HTML fullscreen" }).click();
  const viewport = page.locator(".html-viewport");
  await expect.poll(() => viewport.evaluate((el) => el.clientWidth)).toBeGreaterThan(1500);
  await expect(frame.locator(".wide-only")).toBeVisible();
  const zoomLabel = page.getByLabel("HTML magnification");
  await expect(zoomLabel).toHaveText("100%");
  while ((await zoomLabel.textContent()) !== "200%") await page.getByRole("button", { name: "Zoom HTML in" }).click();
  // Still the >=1500px layout, now magnified: the page scrolls instead of reflowing.
  await expect(frame.locator(".wide-only")).toBeVisible();
  await expect.poll(() => viewport.evaluate((el) => el.scrollWidth / el.clientWidth)).toBeCloseTo(2, 1);
});

test("zooming in keeps the visible centre of the page (#1361)", async ({ page }) => {
  await page.locator('[data-path="/home/html-preview/wide.html"]').click();
  await expect(page.frameLocator('iframe[title="HTML preview"]').locator("h1")).toHaveText("Quarterly report");
  const viewport = page.locator(".html-viewport");
  await page.getByRole("button", { name: "100%" }).click();
  const { scrollLeft, clientWidth, scrollWidth } = await viewport.evaluate((el) => ({
    scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
  }));
  // Fit showed the whole page, so its centre is the page centre.
  expect(Math.abs(scrollLeft + clientWidth / 2 - scrollWidth / 2)).toBeLessThan(3);
});

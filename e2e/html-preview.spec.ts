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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ source, wideSource }) => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    control.directoryEntries = path => path === "/home/html-preview" ? ["page.html", "page.HTM", "slow.html", "source.txt", "wide.html"].map(name => ({
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
      if (path.endsWith("wide.html")) {
        document.body.dataset.wideReads = String(Number(document.body.dataset.wideReads ?? 0) + 1);
        return wideSource;
      }
      return path.endsWith("source.txt") ? "<h1>Keep this as source</h1>" : source;
    };
  }, { source: documentSource, wideSource: wideDocumentSource });
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

  // 100%: one CSS pixel per screen pixel, so the layout overflows and scrolls.
  await page.getByRole("button", { name: "100%" }).click();
  await expect(zoomLabel).toHaveText("100%");
  await expect.poll(visibleWidth).toBeCloseTo(1200, 0);
  const iframe = page.locator('iframe[title="HTML preview"]');
  const covered = (await iframe.boundingBox())!;
  expect(Math.abs(covered.width - pane.width)).toBeLessThan(2);
  expect(Math.abs(covered.height - pane.height)).toBeLessThan(2);
  await iframe.hover();
  await page.mouse.wheel(300, 0);
  await expect.poll(async () => (await frame.locator(".wide").boundingBox())!.x).toBeLessThan(covered.x - 50);

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

  await page.getByRole("button", { name: "Fit" }).click();
  await expect(zoomLabel).toHaveText(`${fitLabel}%`);

  // A newly selected document starts at Fit again.
  await page.getByRole("button", { name: "100%" }).click();
  await page.locator('[data-path="/home/html-preview/page.html"]').click();
  await expect(page.locator('iframe[title="HTML preview"]').contentFrame().locator("h1")).toHaveText("Project overview");
  await page.locator('[data-path="/home/html-preview/wide.html"]').click();
  await expect(zoomLabel).toHaveText(`${fitLabel}%`);
  await page.screenshot({ path: "evidence/1352-html-preview-fit.png" });
});

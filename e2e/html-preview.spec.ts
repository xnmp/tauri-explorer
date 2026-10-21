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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((source) => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    control.directoryEntries = path => path === "/home/html-preview" ? ["page.html", "page.HTM", "slow.html", "source.txt"].map(name => ({
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
      return path.endsWith("source.txt") ? "<h1>Keep this as source</h1>" : source;
    };
  }, documentSource);
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

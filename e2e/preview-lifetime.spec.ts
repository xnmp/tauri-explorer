import { test, expect, type Page } from "./fixtures";
import { pressShortcut, waitForEntries } from "./helpers";

async function openPreview(page: Page, path: string, filename: string) {
  await page.goto(`/?path=${encodeURIComponent(path)}`);
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("explorer-settings") ?? "{}");
    localStorage.setItem("explorer-settings", JSON.stringify({ ...settings, showPreviewPane: true }));
  });
  await page.reload();
  await waitForEntries(page);
  await expect(page.locator(".preview-pane")).toBeVisible();
  await page.locator(".entry-item", { hasText: filename }).first().click();
}

async function reviseAndRefresh(page: Page, path: string) {
  await page.evaluate((target) => {
    (window as unknown as { __mockPreviewRevision(path: string): void }).__mockPreviewRevision(target);
  }, path);
  await page.keyboard.press("F5");
}

test.describe("Preview request lifetime", () => {
  test("a delayed text response cannot overwrite a newer revision of the same path", async ({ page }) => {
    await page.addInitScript(() => {
      const resolvers: Array<(value: string) => void> = [];
      const w = window as unknown as {
        __mockPreviewReadText(path: string): Promise<string>;
        __previewTextResolvers: Array<(value: string) => void>;
      };
      w.__previewTextResolvers = resolvers;
      w.__mockPreviewReadText = () => new Promise((resolve) => resolvers.push(resolve));
    });

    const path = "/home/user/Documents/project/src/App.tsx";
    await openPreview(page, "/home/user/Documents/project/src", "App.tsx");
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __previewTextResolvers: unknown[] }).__previewTextResolvers.length,
    )).toBe(1);

    await reviseAndRefresh(page, path);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __previewTextResolvers: unknown[] }).__previewTextResolvers.length,
    )).toBe(2);
    await page.evaluate(() => {
      (window as unknown as { __previewTextResolvers: Array<(value: string) => void> })
        .__previewTextResolvers[1]("NEW REVISION");
    });
    await expect(page.locator(".preview-code")).toContainText("NEW REVISION");

    await page.evaluate(() => {
      (window as unknown as { __previewTextResolvers: Array<(value: string) => void> })
        .__previewTextResolvers[0]("STALE REVISION");
    });
    await expect(page.locator(".preview-code")).toContainText("NEW REVISION");
    await expect(page.locator(".preview-code")).not.toContainText("STALE REVISION");
  });

  test("stale and unmounted image blobs are revoked without replacing the current image", async ({ page }) => {
    await page.addInitScript(() => {
      const resolvers: Array<(color: string) => void> = [];
      const urls: string[] = [];
      const revoked: string[] = [];
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => { revoked.push(url); originalRevoke(url); };
      const w = window as unknown as {
        __mockPreviewReadImage(path: string): Promise<string>;
        __previewImageResolvers: Array<(color: string) => void>;
        __previewImageUrls: string[];
        __previewRevokedUrls: string[];
      };
      w.__previewImageUrls = urls;
      w.__previewRevokedUrls = revoked;
      w.__previewImageResolvers = resolvers;
      w.__mockPreviewReadImage = () => new Promise((resolve) => resolvers.push((color) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="${color}"/></svg>`;
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        urls.push(url);
        resolve(url);
      }));
    });

    const path = "/home/user/Pictures/photo1.jpg";
    await openPreview(page, "/home/user/Pictures", "photo1.jpg");
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __previewImageResolvers: unknown[] }).__previewImageResolvers.length,
    )).toBe(1);
    await reviseAndRefresh(page, path);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __previewImageResolvers: unknown[] }).__previewImageResolvers.length,
    )).toBeGreaterThanOrEqual(2);

    await page.waitForTimeout(100);
    const currentIndex = await page.evaluate(() =>
      (window as unknown as { __previewImageResolvers: unknown[] }).__previewImageResolvers.length - 1,
    );

    await page.evaluate((index) => {
      (window as unknown as { __previewImageResolvers: Array<(color: string) => void> })
        .__previewImageResolvers[index]("green");
    }, currentIndex);
    await expect(page.locator(".preview-image")).toBeVisible();
    const currentSrc = await page.locator(".preview-image").getAttribute("src");
    await page.evaluate((winningIndex) => {
      const resolvers = (window as unknown as { __previewImageResolvers: Array<(color: string) => void> })
        .__previewImageResolvers;
      resolvers.forEach((resolve, index) => { if (index !== winningIndex) resolve("red"); });
    }, currentIndex);
    await expect(page.locator(".preview-image")).toHaveAttribute("src", currentSrc!);

    await pressShortcut(page, " ", {});
    await expect(page.locator(".preview-pane")).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const w = window as unknown as { __previewImageUrls: string[]; __previewRevokedUrls: string[] };
      return w.__previewImageUrls.every((url) => w.__previewRevokedUrls.includes(url));
    })).toBe(true);
  });

  test("unmount during resize removes the document drag listeners", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ", {});
    const handle = page.locator(".preview-pane .resize-handle");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 2, box!.y + 2);
    await page.mouse.down();
    await pressShortcut(page, " ", {});
    await expect(page.locator(".preview-pane")).toBeHidden();
    const widthAfterUnmount = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("explorer-settings") ?? "{}").previewPaneWidth ?? 0,
    );
    await page.mouse.move(box!.x - 120, box!.y + 2);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem("explorer-settings") ?? "{}").previewPaneWidth ?? 0,
    )).toBe(widthAfterUnmount);
  });
});

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("selected image displays its recorded source, operation, and output", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace).toContainText("No recorded edits for this image.");

  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 3,
      artifacts: [
        { id: 3, path: "/home/user/Pictures/screenshot.png", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:01Z", generatingRun: 2 },
        { id: 1, path: "/home/user/Pictures/source.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null },
      ],
      runs: [{ id: 2, operation: "image.crop", parameters: { rect: { left: 20, top: 10, right: 420, bottom: 310 }, viewport: { width: 512, height: 384 } }, createdAt: "2026-10-03T00:00:01Z", inputIds: [1] }],
    });
    traceInvalidation.bump();
  });

  const provenance = trace.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("source.png");
  await expect(provenance).toContainText("Crop");
  await expect(provenance).toContainText("400 × 300");
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance.locator('[aria-current="true"]')).toContainText("screenshot.png");
});

test("two source images remain visible when one operation joins them", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      artifacts: [
        { id: 1, path: "/home/user/Pictures/screenshot.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null },
        { id: 2, path: "/home/user/Pictures/photo2.jpg", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:00Z", generatingRun: null },
        { id: 4, path: "/home/user/Pictures/composite.png", digest: "cccccccccccccccc", createdAt: "2026-10-03T00:00:01Z", generatingRun: 3 },
      ],
      runs: [{ id: 3, operation: "image.compose", parameters: {}, createdAt: "2026-10-03T00:00:01Z", inputIds: [1, 2] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance).toContainText("photo2.jpg");
  await expect(provenance).toContainText("compose");
  await expect(provenance).toContainText("composite.png");
});

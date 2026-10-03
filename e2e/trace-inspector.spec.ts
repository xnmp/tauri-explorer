import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

for (const mode of ALL_VIEW_MODES) test(`${mode}: selected image displays its recorded source, operation, and output`, async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await switchViewMode(page, mode);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace).toContainText("No recorded edits for this image.");

  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 3,
      selectedRevisionStatus: "matched",
      artifacts: [
        { id: 3, path: "/home/user/Pictures/screenshot.png", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:01Z", generatingRun: 2, pathState: "present" },
        { id: 1, path: "/home/user/Pictures/source.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "missing" },
      ],
      runs: [{ id: 2, operation: "image.crop", parameters: { rect: { left: 20, top: 10, right: 420, bottom: 310 }, viewport: { width: 512, height: 384 } }, createdAt: "2026-10-03T00:00:01Z", status: "succeeded", finishedAt: "2026-10-03T00:00:02Z", error: null, recovered: false, inputIds: [1] }],
    });
    traceInvalidation.bump();
  });

  const provenance = trace.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("source.png");
  await expect(provenance).toContainText("Crop");
  await expect(provenance).toContainText("400 × 300");
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance.locator('[aria-current="true"]')).toContainText("screenshot.png");

  const details = trace.getByRole("region", { name: "Trace details" });
  await expect(details).toContainText("ARTIFACT REVISION");
  await provenance.getByRole("button", { name: /Crop/ }).click();
  await expect(details).toContainText("OPERATION");
  await expect(details).toContainText("source.png");
  await expect(details).toContainText('"left": 20');
  await provenance.getByRole("button", { name: /source.png/ }).focus();
  await page.keyboard.press("Enter");
  await expect(details).toContainText("Earlier origin unknown");
  await expect(details).toContainText("Missing from recorded path");
});

test("two source images remain visible when one operation joins them", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = (path) => ({
      currentArtifactId: path.endsWith("photo2.jpg") ? 2 : 1,
      selectedRevisionStatus: "matched",
      artifacts: [
        { id: 1, path: "/home/user/Pictures/screenshot.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" },
        { id: 2, path: "/home/user/Pictures/photo2.jpg", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" },
        { id: 4, path: "/home/user/Pictures/composite.png", digest: "cccccccccccccccc", createdAt: "2026-10-03T00:00:01Z", generatingRun: 3, pathState: "present" },
      ],
      runs: [{ id: 3, operation: "image.compose", parameters: {}, createdAt: "2026-10-03T00:00:01Z", status: "succeeded", finishedAt: "2026-10-03T00:00:02Z", error: null, recovered: false, inputIds: [1, 2] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance).toContainText("photo2.jpg");
  await expect(provenance).toContainText("compose");
  await expect(provenance).toContainText("composite.png");
  await provenance.getByRole("button", { name: /compose/ }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await expect(details).toContainText("screenshot.png, photo2.jpg");
  await expect(details).toContainText("composite.png");
  await page.locator(".entry-item", { hasText: "photo2.jpg" }).click();
  await expect(details).toContainText("ARTIFACT REVISION");
  await expect(details).toContainText("photo2.jpg");
  await expect(provenance.getByRole("button", { name: /photo2.jpg/ })).toHaveAttribute("aria-pressed", "true");
});

test("externally changed bytes show the last recorded revision without claiming a current match", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "changed",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [],
    });
    traceInvalidation.bump();
  });
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace.getByRole("status")).toContainText("This file changed since it was recorded");
  await expect(trace.getByRole("list", { name: "Image provenance" })).toContainText("Last recorded");
  await expect(trace.locator('[aria-current="true"]')).toHaveCount(0);
});

test("a large image reports that its revision was not verified", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "unverified",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [],
    });
    traceInvalidation.bump();
  });
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace.getByRole("status")).toContainText("current bytes were not checked");
  await expect(trace.getByRole("status")).not.toContainText("changed");
});

test("a failed crop remains visible from its source without an invented output", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "matched",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [{ id: 2, operation: "image.crop", parameters: {}, createdAt: "2026-10-03T00:00:01Z", status: "failed", finishedAt: "2026-10-03T00:00:02Z", error: "crop_failed", recovered: false, inputIds: [1] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance.getByRole("button", { name: /Crop failed/ })).toBeVisible();
  await expect(provenance.getByRole("button")).toHaveCount(2);
  await provenance.getByRole("button", { name: /Crop failed/ }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await expect(details).toContainText("failed");
  await expect(details).toContainText("No recorded output");
  await expect(details).toContainText("crop_failed");
});

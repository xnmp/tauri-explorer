/**
 * #1022: a folder load stuck past 5 s is recorded while it is still stuck,
 * and the record — naming the slow phase — reaches the in-app report relay.
 *
 * The delay is injected through the mock backend's per-command latency hook,
 * so the listing command itself is what never returns within the threshold.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS, type MockControl } from "../src/lib/api/mock-control";

test("a folder load stuck past 5 s produces a diagnostic naming the slow phase", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(HOME_URL);
  await waitForEntries(page);

  await page.evaluate(() => {
    ((globalThis as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).latency = {
      list_directory_fresh: 30_000,
    };
  });
  await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
  await expect(page.locator(".file-list .status", { hasText: "Loading..." })).toBeVisible();

  // Captured at the threshold while the listing is still pending.
  await expect.poll(
    () => page.evaluate(() => (globalThis as unknown as { __mockControl?: MockControl }).__mockControl?.invokeCounts?.record_slow_load ?? 0),
    { timeout: 9_000, intervals: [250] },
  ).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".file-list .status", { hasText: "Loading..." })).toBeVisible();

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  const diagnostics = dialog.getByRole("region", { name: "Slow folder-load diagnostics" });
  await expect(diagnostics.getByLabel("Include 1 recent slow folder load")).toBeChecked();
  await expect(diagnostics).toContainText("which will be public in the issue");
  await expect(diagnostics).toContainText("File names are not included");
  await diagnostics.getByText("Show what will be sent").click();
  const preview = diagnostics.locator(".diagnostics-preview");
  await expect(preview).toContainText("1. /home/user/Documents");
  await expect(preview).toContainText("still pending when captured");
  await expect(preview).toContainText("stuck in: native — native listing command");
  await dialog.screenshot({
    path: process.env.CAPTURE_EVIDENCE ? "evidence/1022/report-dialog-slow-load.png" : "test-results/1022-slow-load-report.png",
  });

  await dialog.getByLabel("Title").fill("Folder never loads");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), MOCK_LOCAL_KEYS.submittedReport);
  expect(submitted.diagnostics).toContain("/home/user/Documents");
  expect(submitted.diagnostics).toContain("stuck in: native");
});

test("unchecking the diagnostics keeps them out of the report", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(() => {
    ((globalThis as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).latency = {
      list_directory_fresh: 5_600,
    };
  });
  await page.locator(".entry-item", { hasText: "Pictures" }).first().dblclick();
  // The load finishes just after the threshold: recorded while pending, then
  // the record is replaced with its outcome.
  await expect.poll(
    () => page.evaluate(() => (globalThis as unknown as { __mockControl?: MockControl }).__mockControl?.invokeCounts?.record_slow_load ?? 0),
    { timeout: 12_000, intervals: [250] },
  ).toBe(2);
  await expect(page.locator(".breadcrumbs-container")).toContainText("Pictures");

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  const diagnostics = dialog.getByRole("region", { name: "Slow folder-load diagnostics" });
  await diagnostics.getByText("Show what will be sent").click();
  await expect(diagnostics.locator(".diagnostics-preview")).toContainText("/home/user/Pictures");
  await expect(diagnostics.locator(".diagnostics-preview")).toContainText("· ok ·");
  await diagnostics.getByLabel(/Include 1 recent slow folder load/).uncheck();
  await dialog.getByLabel("Title").fill("Unrelated bug");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), MOCK_LOCAL_KEYS.submittedReport);
  expect(submitted.diagnostics).toBeNull();
});

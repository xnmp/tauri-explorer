/**
 * Crash notice (#184, #1684): after a crash, the next launch shows a banner offering
 * to report the saved crash through Report Issue, exactly once.
 */

import { test, expect } from "./fixtures";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

test("crash notice appears after a crash and dismisses", async ({ page }) => {
  // Seed the flag, then reload — addInitScript would re-seed it on every
  // navigation and defeat the consumed-on-read assertion below.
  await page.goto("/");
  await page.evaluate((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.crashReport);
  await page.reload();

  const notice = page.locator('[data-testid="crash-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("crashed last time");
  await expect(notice).toContainText("crash-1700000000.txt");
  await expect(notice).toContainText("nothing was sent anywhere");
  await expect
    .poll(() => notice.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toMatch(/^rgb\([^)]*\)$|^rgba\([^)]*,\s*1\)$/);
  await notice.screenshot({ path: "evidence/ac-1-crash-report-opaque.png" });

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();

  // Consumed on read: a reload must not offer the same crash again.
  await page.reload();
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});

test("no crash notice on a clean launch", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});

test("a frontend error is recorded and offered as a crash on next launch", async ({ page }) => {
  await page.goto("/");
  // goto resolves before any app JS runs under Vite dev, so wait until the
  // app is interactive — dispatching earlier races handler installation and
  // the error would go unrecorded.
  await page.waitForSelector(".file-list");

  // Trigger an uncaught error the global handler captures + records.
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", { message: "synthetic frontend boom", filename: "app.js" }),
    );
  });

  // record_frontend_crash persists the record for the next launch.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.frontendCrash))
    .not.toBeNull();

  // Next launch: the notice offers the frontend crash exactly like a Rust one.
  await page.reload();
  const notice = page.locator('[data-testid="crash-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("crashed last time");
  await expect(notice).toContainText("nothing was sent anywhere");

  // Consumed on read: a further reload must not re-offer the same crash.
  await page.reload();
  await expect(page.locator('[data-testid="crash-notice"]')).not.toBeVisible();
});

test("reporting a crash submits it through the report dialog, not a GitHub URL (#1684)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.crashReport);
  await page.reload();

  const notice = page.locator('[data-testid="crash-notice"]');
  await notice.getByRole("button", { name: "Report…" }).click();
  await expect(notice).not.toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  await expect(dialog.getByLabel("Title")).toHaveValue("Crash: mock panic for testing");
  const section = dialog.getByRole("region", { name: "Crash report" });
  await expect(section.getByLabel("Include the crash report")).toBeChecked();
  await expect(section).toContainText("crash-1700000000.txt");
  await section.getByText("Show what will be sent").click();
  await expect(section.locator(".diagnostics-preview")).toContainText("panic: mock panic for testing");
  await expect(section.locator(".diagnostics-preview")).toContainText("location: src/lib.rs:1:1");
  if (process.env.CAPTURE_EVIDENCE) {
    await dialog.screenshot({
      path: "screenshots/feat/crash-report-via-relay/report-dialog-crash.png",
      animations: "disabled",
    });
  }

  await dialog.getByLabel("Description (optional)").fill("Opened a large folder, then it closed.");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    MOCK_LOCAL_KEYS.submittedReport,
  );
  expect(submitted.title).toBe("Crash: mock panic for testing");
  expect(submitted.kind).toBe("bug");
  expect(submitted.diagnostics).toEqual([
    expect.objectContaining({ kind: "crash-report", text: expect.stringContaining("panic: mock panic for testing") }),
  ]);

  // Submitted: a new report no longer offers the crash.
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Crash report" })).toHaveCount(0);
});

test("unchecking the crash report keeps it out of the submission (#1684)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.crashReport);
  await page.reload();
  await page.locator('[data-testid="crash-notice"]').getByRole("button", { name: "Report…" }).click();
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  await dialog.getByRole("region", { name: "Crash report" }).getByLabel("Include the crash report").uncheck();
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    MOCK_LOCAL_KEYS.submittedReport,
  );
  expect(submitted.diagnostics).toBeNull();
});

test("a crash that does not fit beside a long description is kept for the next report (#1684)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => localStorage.setItem(key, "1"), MOCK_LOCAL_KEYS.crashReport);
  await page.reload();
  await page.locator('[data-testid="crash-notice"]').getByRole("button", { name: "Report…" }).click();
  const dialog = page.getByRole("dialog", { name: "Report Issue" });
  const section = dialog.getByRole("region", { name: "Crash report" });
  await expect(section.getByLabel("Include the crash report")).toBeChecked();

  await dialog.getByLabel("Description (optional)").fill("x".repeat(7700));
  await expect(section).toContainText("does not fit alongside this description");
  await expect(section.getByLabel("Include the crash report")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #5470");
  const submitted = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    MOCK_LOCAL_KEYS.submittedReport,
  );
  expect(submitted.diagnostics).toBeNull();

  // Never shown, so not consumed: the next report offers it again.
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Report Issue");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("region", { name: "Crash report" }).getByLabel("Include the crash report")).toBeChecked();
});


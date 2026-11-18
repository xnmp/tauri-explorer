/**
 * #1685 / #1688: opt-in "Recent errors" and "Recent actions" sections in the
 * report dialog. Each is previewed verbatim, off by default, and reaches the
 * submitted payload only while ticked.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

const ERRORS = [
  "This session:",
  "[ERROR][tauri_explorer_lib::files] cannot read ~/Documents/plans: permission denied",
  "[WARN][tauri_explorer_lib::git] status probe slow",
].join("\n");

async function palette(page: Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

async function openDialog(page: Page) {
  await palette(page, "Report Issue");
  return page.getByRole("dialog", { name: "Report Issue" });
}

async function submitted(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), MOCK_LOCAL_KEYS.submittedReport);
}

async function start(page: Page) {
  await page.addInitScript(
    ([key, text]) => localStorage.setItem(key, text),
    [MOCK_LOCAL_KEYS.recentErrors, ERRORS] as const,
  );
  await page.goto("/");
  await waitForEntries(page);
}

test("recent errors are previewed, off by default, and sent only when ticked", async ({ page }) => {
  await start(page);
  const dialog = await openDialog(page);
  const section = dialog.getByRole("region", { name: "Recent errors" });
  await expect(section.getByLabel("Include recent errors")).not.toBeChecked();
  await section.getByText("Show what will be sent").click();
  await expect(section.locator(".diagnostics-preview")).toContainText("cannot read ~/Documents/plans");
  await section.locator(".diagnostics-preview").scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: "screenshots/feat/report-recent-errors/recent-errors-preview.png", animations: "disabled" });

  await dialog.getByLabel("Title").fill("Unticked");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #");
  const unticked = await submitted(page);
  expect(unticked.diagnostics ?? null).toBeNull();
  expect(JSON.stringify(unticked)).not.toContain("permission denied");
});

test("ticking recent errors sends exactly the previewed text", async ({ page }) => {
  await start(page);
  const dialog = await openDialog(page);
  const section = dialog.getByRole("region", { name: "Recent errors" });
  await section.getByLabel("Include recent errors").check();
  const preview = (await section.locator(".diagnostics-preview").textContent())?.trim();
  await dialog.getByLabel("Title").fill("Ticked");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #");
  const payload = await submitted(page);
  expect(payload.diagnostics).toEqual([{ kind: "recent-errors", text: preview }]);
  expect(payload.diagnostics[0].text).toContain("permission denied");
});

test("the dialog starts unticked again on every open", async ({ page }) => {
  await start(page);
  let dialog = await openDialog(page);
  await dialog.getByRole("region", { name: "Recent errors" }).getByLabel("Include recent errors").check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  dialog = await openDialog(page);
  await expect(dialog.getByLabel("Include recent errors")).not.toBeChecked();
});

test("the actions trail lists what the reporter did, by identifier only", async ({ page }) => {
  await start(page);
  await palette(page, "List View");
  await expect(page.locator(".file-list").first()).toBeVisible();
  const dialog = await openDialog(page);
  const section = dialog.getByRole("region", { name: "Recent actions" });
  await expect(section.getByLabel("Include my recent actions")).not.toBeChecked();
  await section.getByText("Show what will be sent").click();
  const preview = section.locator(".diagnostics-preview");
  await expect(preview).toContainText("view.list");
  await expect(preview).toContainText("help.reportIssue");
  const text = (await preview.textContent()) ?? "";
  expect(text).not.toMatch(/[/\\]/); // no paths
  await dialog.screenshot({ path: "screenshots/feat/report-recent-errors/recent-actions-preview.png", animations: "disabled" });

  await section.getByLabel("Include my recent actions").check();
  await dialog.getByLabel("Title").fill("With trail");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".toast.success")).toContainText("Issue #");
  const payload = await submitted(page);
  expect(payload.diagnostics).toEqual([{ kind: "recent-actions", text: text.trim() }]);
});

test("feature requests do not offer the diagnostics sections", async ({ page }) => {
  await start(page);
  const dialog = await openDialog(page);
  await expect(dialog.getByRole("region", { name: "Recent errors" })).toBeVisible();
  await dialog.getByRole("button", { name: "Feature" }).click();
  await expect(dialog.getByRole("region", { name: "Recent errors" })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Recent actions" })).toHaveCount(0);
});

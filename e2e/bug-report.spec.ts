/** In-app bug and feature reports (#547). */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

for (const command of ["Report a Bug", "Request a Feature"]) {
  test(`${command} submits in-app and links the created issue`, async ({ page }) => {
    await page.goto("/");
    await waitForEntries(page);

    await runPaletteCommand(page, command);
    const dialog = page.getByRole("dialog", { name: /report|request/i });
    await dialog.getByLabel("Title").fill(`${command} title`);
    await dialog.getByLabel("Description").fill("Typed description");
    await dialog.getByLabel(/How can we reach you/).fill("@playwright-reporter");
    await page.keyboard.press("Control+Enter");

    await expect(dialog).toBeHidden();
    const toast = page.locator(".toast.success");
    await expect(toast).toContainText("Issue #5470");
    await expect(toast.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/xnmp/tauri-explorer/issues/5470",
    );
  });
}

test("failed submission preserves the draft in the GitHub fallback", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "daily_cap"));

  await runPaletteCommand(page, "Request a Feature");
  const dialog = page.getByRole("dialog", { name: /request/i });
  await dialog.getByLabel("Title").fill("Keep my feature title");
  await dialog.getByLabel("Description").fill("Keep my typed description 🐛");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Reports are temporarily unavailable",
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .not.toBeNull();
  const url = new URL(
    (await page.evaluate(() => localStorage.getItem("mock-opened-url")))!,
  );
  expect(url.searchParams.get("title")).toBe("Keep my feature title");
  expect(url.searchParams.get("body")).toContain("Keep my typed description 🐛");
  expect(url.searchParams.get("labels")).toBe("enhancement");
});

test("draft stays editable when both relay and browser fallback fail", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => {
    localStorage.setItem("mock-report-error", "network_unreachable");
    localStorage.setItem("mock-open-url-error", "1");
  });

  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Do not lose this title");
  await dialog.getByLabel("Description").fill("Do not lose this description");
  await dialog.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("alert")).toContainText("your report is still here");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Do not lose this title");
  await expect(dialog.getByLabel("Description")).toHaveValue(
    "Do not lose this description",
  );
  await expect(dialog.getByRole("button", { name: "Submit" })).toBeEnabled();
});

test("Open Logs Folder navigates the pane to the log directory", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);

  await runPaletteCommand(page, "Open Logs Folder");

  await expect(page.locator(".status-path")).toHaveAttribute(
    "title",
    "/tmp/tauri-explorer/logs",
  );
});

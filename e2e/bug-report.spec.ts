/**
 * Bug-report + logs palette commands (#197). The mock records
 * open_external_url calls so the test asserts the real outcome: a GitHub
 * new-issue URL carrying version and OS diagnostics.
 */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

test("Report a Bug opens a pre-filled GitHub issue with diagnostics", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);

  await runPaletteCommand(page, "Report a Bug");

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .not.toBeNull();
  const url = (await page.evaluate(() => localStorage.getItem("mock-opened-url")))!;
  expect(url).toContain("https://github.com/xnmp/tauri-explorer/issues/new");
  const decoded = decodeURIComponent(url);
  expect(decoded).toContain("Tauri Explorer: v0.0.0-mock");
  expect(decoded).toContain("OS: linux (x86_64)");
  expect(decoded).toContain("What happened?");
  // #302: the report carries a recent-logs tail so maintainers get context
  // (the user reviews it in the GitHub form before submitting).
  expect(decoded).toContain("## Recent logs");
  expect(decoded).toContain("tauri_explorer");
  // Stay under the URL length cap even with logs attached.
  expect(url.length).toBeLessThanOrEqual(6000);
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

/** Regression and evidence for the solid report-fallback notification (#555). */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

function evidencePath(name: string): string {
  return process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;
}

async function runPaletteCommand(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill(query);
  await page.keyboard.press("Enter");
}

test("report fallback keeps a solid toast over contrasting app content", async ({ page }) => {
  await page.goto("/");
  await waitForEntries(page);
  await page.evaluate(() => localStorage.setItem("mock-report-error", "network_unreachable"));

  await runPaletteCommand(page, "Report a Bug");
  const dialog = page.getByRole("dialog", { name: /report a bug/i });
  await dialog.getByLabel("Title").fill("Opaque fallback toast");
  await dialog.getByLabel("Description").fill("Keep this report in GitHub.");
  await dialog.getByRole("button", { name: "Submit" }).click();

  const toast = page.locator(".toast.error");
  await expect(toast).toContainText("Could not submit in-app — opening GitHub instead");
  await expect.poll(() => toast.evaluate((element) => {
    const style = getComputedStyle(element);
    const channels = style.backgroundColor.match(/[\d.]+/g) ?? [];
    return {
      alpha: style.backgroundColor.startsWith("rgba") ? Number(channels[3]) : 1,
      backgroundImage: style.backgroundImage,
    };
  })).toEqual({ alpha: 1, backgroundImage: "none" });

  // The theme picker puts a real dimmed modal backdrop behind the still-visible
  // fallback toast, making translucency visually observable in the capture.
  await runPaletteCommand(page, "Switch Theme");
  await expect(page.locator(".theme-picker-dialog")).toBeVisible();
  await page.screenshot({ path: evidencePath("ac-2-report-fallback-toast.png") });

  if (!process.env.CAPTURE_EVIDENCE) return;
  const url = await page.evaluate(() => localStorage.getItem("mock-opened-url"));
  expect(url).not.toBeNull();
  const github = await page.context().newPage();
  await github.goto(url!, { waitUntil: "domcontentloaded" });
  await expect(github).toHaveURL(/github\.com\/(?:login|xnmp\/tauri-explorer\/issues\/new)/);
  await github.screenshot({ path: evidencePath("ac-1-github-fallback.png") });
  await github.close();
});

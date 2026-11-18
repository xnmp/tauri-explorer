/**
 * Details "Date opened" with OS recent-file sources (#1526): a file opened only
 * in another application shows the OS time; the setting turns that off.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings } from "./helpers";

const SHOTS = "screenshots/feat/os-recent-sources";
const DOCS = "/home/user/Documents";
const OS_TIME = Date.UTC(2020, 10, 12, 9, 30);
const row = (page: Page, name: string) => page.locator(`.details-view .entry-item[data-path="${DOCS}/${name}"]`);

async function openDocuments(page: Page, osRecentSources: boolean) {
  await page.addInitScript((seed) => localStorage.setItem("mock-os-opened-times", JSON.stringify(seed)), { [`${DOCS}/report.pdf`]: OS_TIME });
  await seedSettings(page, { zoomLevel: 100, osRecentSources, columnVisibility: { prompt: true, date: true, type: true, size: true, length: false, resolution: false, opened: true } }, { replace: true });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`/?path=${DOCS}&viewMode=details`);
  await expect(row(page, "report.pdf")).toBeVisible();
}

test("a file opened only in another app shows the OS open time", async ({ page }) => {
  await openDocuments(page, true);
  const cell = row(page, "report.pdf").locator(".opened-cell");
  await expect(cell).not.toHaveText("");
  await expect(cell).toHaveAttribute("title", /2020/);
  await expect(row(page, "notes.md").locator(".opened-cell")).toHaveText("");
  await page.locator(".details-view").screenshot({ path: `${SHOTS}/details-date-opened-os.png`, animations: "disabled" });
});

test("a more recent in-app open wins over the OS time", async ({ page }) => {
  await openDocuments(page, true);
  await row(page, "report.pdf").dblclick();
  await expect(row(page, "report.pdf").locator(".opened-cell")).not.toHaveAttribute("title", /2020/);
});

test("disabling OS sources leaves Date opened to the app history", async ({ page }) => {
  await openDocuments(page, false);
  await expect(row(page, "report.pdf").locator(".opened-cell")).toHaveText("");
});

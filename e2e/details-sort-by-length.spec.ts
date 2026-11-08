/**
 * Details sort by Length (#1531): clicking the Length header orders rows by
 * playback length (mock `get_media_durations`), unknown lengths after known
 * ones; clicking again reverses. Plugin `lengthSeconds` (#1523) sort the same
 * way through the demo plugin's `.demorec` recordings.
 */
import { test, expect, type Page } from "./fixtures";
import { runPaletteCommand, seedSettings } from "./helpers";

const SHOTS = "screenshots/feat/sort-by-length";

async function openVideos(page: Page) {
  await seedSettings(page, { zoomLevel: 100 }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/?path=/home/user/Videos&viewMode=details");
  await expect(page.locator(".details-view .entry-item:visible").first()).toBeVisible();
}

const header = (page: Page) => page.locator(".details-view:visible .column-header.length-column");
const rowNames = (page: Page) =>
  page.locator(".details-view:visible .entry-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-path")!.split("/").pop()!));

test("clicking Length orders rows by duration; clicking again reverses", async ({ page }) => {
  await openVideos(page);
  await expect.poll(() => rowNames(page)).toEqual(["recording.mp4", "soundtrack.mp3", "tutorial.mkv", "unreadable.avi"]);

  await header(page).click();
  await expect(header(page)).toHaveClass(/active/);
  await expect(header(page).locator(".sort-indicator")).toBeVisible();
  // 12:34, 1:02:05, then unknown lengths (not a video; unreadable) by name.
  await expect.poll(() => rowNames(page)).toEqual(["recording.mp4", "tutorial.mkv", "soundtrack.mp3", "unreadable.avi"]);
  await expect(page.locator('.details-view .entry-item[data-path="/home/user/Videos/tutorial.mkv"] .length-cell')).toHaveText("1:02:05");
  await page.locator(".details-view:visible").screenshot({ path: `${SHOTS}/details-sorted-by-length.png`, animations: "disabled" });

  await header(page).click();
  await expect.poll(() => rowNames(page)).toEqual(["unreadable.avi", "soundtrack.mp3", "tutorial.mkv", "recording.mp4"]);
  await page.locator(".details-view:visible").screenshot({ path: `${SHOTS}/details-sorted-by-length-descending.png`, animations: "disabled" });
});

test("the Length sort persists for the folder and is offered in the command palette", async ({ page }) => {
  await openVideos(page);
  await runPaletteCommand(page, "Sort by Length");
  await expect.poll(() => rowNames(page)).toEqual(["recording.mp4", "tutorial.mkv", "soundtrack.mp3", "unreadable.avi"]);
  await page.reload();
  await expect(header(page)).toHaveClass(/active/);
  await expect.poll(() => rowNames(page)).toEqual(["recording.mp4", "tutorial.mkv", "soundtrack.mp3", "unreadable.avi"]);
});

test("sorting by Length loads lengths that no rendered row requested", async ({ page }) => {
  // With the Length column hidden, rows never probe durations: only the
  // folder-wide Length-sort requests can supply the order.
  await seedSettings(page, { zoomLevel: 100, columnVisibility: { date: true, type: true, size: true, length: false } }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/?path=/home/user/Videos&viewMode=details");
  await expect(page.locator(".details-view .entry-item:visible").first()).toBeVisible();
  await expect(header(page)).toHaveCount(0);
  await runPaletteCommand(page, "Sort by Length");
  await expect.poll(() => rowNames(page)).toEqual(["recording.mp4", "tutorial.mkv", "soundtrack.mp3", "unreadable.avi"]);
});

test("plugin lengthSeconds sort: demo recordings by length, then files without one", async ({ page }) => {
  await seedSettings(page, { zoomLevel: 100 }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/?path=/home/user/Videos&viewMode=details");
  await expect(page.locator(".details-view .entry-item:visible").first()).toBeVisible();
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const plugin = page.locator('.plugins-dialog .setting-row:has-text("Demo Plugin")').first();
  if (!(await plugin.locator('input[type="checkbox"]').first().isChecked())) await plugin.locator("label.toggle").click();
  await expect(plugin.locator('input[type="checkbox"]').first()).toBeChecked();
  await page.locator(".plugins-dialog .close-btn").click();
  await expect(page.locator(".plugins-dialog")).toBeHidden();
  await runPaletteCommand(page, "Demo: Open Virtual Folder");
  await expect(page.locator('.entry-item[data-path="demo://practice.demorec"]:visible')).toBeVisible();

  await header(page).click();
  // final-game (12:14) before practice (21:01); files without a length by name.
  await expect.poll(() => rowNames(page)).toEqual(["subfolder", "final-game.demorec", "practice.demorec", "hello.txt", "readme.md", "theme-source.png"]);
  await header(page).click();
  await expect.poll(() => rowNames(page)).toEqual(["subfolder", "theme-source.png", "readme.md", "hello.txt", "practice.demorec", "final-game.demorec"]);
});

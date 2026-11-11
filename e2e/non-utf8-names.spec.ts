/**
 * File names that are not valid UTF-8 (#1592, ADR 0031). The backend lists
 * `bad\xff.txt` as the wire name `bad.txt`; every view shows it as
 * U+FFFD while keeping its wire path as the identity, distinct from a real
 * file named with U+FFFD. Inline rename edits display text and leaves an
 * unchanged name alone.
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

const RAW = "/raw/bad.txt";
const LOOKALIKE = "/raw/bad�.txt";
const DISPLAY = "bad�.txt";

async function openRawFolder(page: Page) {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const entry = (name: string, kind: "file" | "directory") => ({
      name,
      path: `/raw/${name}`,
      kind,
      size: 12,
      modified: "2026-11-11T00:00:00Z",
    });
    const control = getMockControl();
    control.invokeCounts = {};
    control.directoryEntries = (path) =>
      path === "/raw"
        ? [entry("bad.txt", "file"), entry("bad�.txt", "file"), entry("dir", "directory")]
        : [];
    await windowTabsManager.getActiveExplorer()!.navigateTo("/raw");
  });
  await expect(page.locator(`.entry-item[data-path="${RAW}"]:visible`)).toBeVisible();
}

for (const viewMode of VIEW_MODES) {
  test.describe(`non-UTF-8 names [${viewMode}]`, () => {
    test("shows escaped bytes as U+FFFD while the raw entry keeps its own identity", async ({ page }) => {
      await openRawFolder(page);
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      const raw = page.locator(`.entry-item[data-path="${RAW}"]:visible .entry-name`);
      const lookalike = page.locator(`.entry-item[data-path="${LOOKALIKE}"]:visible .entry-name`);
      await expect(raw).toHaveText(DISPLAY);
      await expect(lookalike).toHaveText(DISPLAY);
      await expect(page.locator(`.entry-item[data-path="/raw/dir"]:visible .entry-name`)).toHaveText(
        "dir�",
      );
      // No reserved character reaches the screen.
      const shown = await page.locator(".entry-item:visible .entry-name").allTextContents();
      expect(shown.join("")).not.toMatch(/[-]/);
      await page.screenshot({ path: `screenshots/fix/non-utf8-filenames/${viewMode}.png` });
    });

    test("inline rename edits display text and leaves an unchanged name alone", async ({ page }) => {
      await openRawFolder(page);
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      await page.locator(`.entry-item[data-path="${RAW}"]:visible`).click();
      await page.keyboard.press("F2");
      const input = page.locator(".rename-input:visible");
      await expect(input).toHaveValue(DISPLAY);
      await page.keyboard.press("Enter");
      await expect(input).toBeHidden();
      const renames = await page.evaluate(async () => {
        const { getMockControl } = await import("/src/lib/api/mock-control.ts");
        return getMockControl().invokeCounts?.rename_entry ?? 0;
      });
      expect(renames).toBe(0);
      await expect(page.locator(`.entry-item[data-path="${RAW}"]:visible .entry-name`)).toHaveText(DISPLAY);
    });
  });
}

test("an AI suggestion that echoes a wire escape is accepted as display text, not escaped twice", async ({
  page,
}) => {
  await openRawFolder(page);
  await page.evaluate(async () => {
    const { renameSuggestionStore } = await import("/src/lib/state/rename-suggestion.svelte.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().invokeArgs = { rename_entry: [] };
    // A provider that saw the wire name echoes its escape (U+EFFF = byte FF).
    renameSuggestionStore.setProvider(async () => "bad-notes.txt");
  });
  await page.locator(`.entry-item[data-path="${RAW}"]:visible`).click();
  await page.keyboard.press("F2");
  await expect(page.locator(".rename-suggestion")).toBeVisible();
  await page.keyboard.press("Tab");
  const input = page.locator(".rename-input:visible");
  await expect(input).toHaveValue("bad�-notes.txt");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { getMockControl } = await import("/src/lib/api/mock-control.ts");
        return getMockControl().invokeArgs?.rename_entry ?? [];
      }),
    )
    .toEqual([expect.objectContaining({ path: RAW, newName: "bad�-notes.txt" })]);
});

import { expect, test } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

const shown = ".pane-tree:not(.retained)";

test("List places a caretless folder Open control at the row's far right", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
    settingsStore.update({ folderPeek: true, folderPeekCarets: false });
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode("list");
    await explorer.navigateTo("/folder-peek", { autoEnterSingleSubdir: false });
  });

  const row = page.locator(`${shown} .entry-item[data-path="/folder-peek/Alpha"]`);
  const open = row.getByRole("button", { name: "Open Alpha", exact: true });
  await row.hover();
  await expect(open).toHaveCSS("opacity", "1");
  const rightGap = await row.evaluate(element => (
    element.getBoundingClientRect().right
      - element.querySelector(".peek-open")!.getBoundingClientRect().right
  ));
  expect(rightGap).toBeGreaterThanOrEqual(0);
  expect(rightGap).toBeLessThanOrEqual(16);
  await page.screenshot({ path: "evidence/ac-1-list-caretless-open-far-right.png" });

  await open.click();
  await expect(page.locator(`${shown} .entry-item[data-path="/folder-peek/Alpha/same.txt"]`)).toBeVisible();
  await page.screenshot({ path: "evidence/ac-2-list-caretless-open-navigates.png" });
});

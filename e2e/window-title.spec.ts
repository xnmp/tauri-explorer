import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

test("window title follows navigation without an empty startup overwrite", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __titleHistory: string[] }).__titleHistory = [];
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "title");
    if (!descriptor?.get || !descriptor.set) throw new Error("Document.title is not interceptable");
    Object.defineProperty(Document.prototype, "title", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value: string) {
        (window as unknown as { __titleHistory: string[] }).__titleHistory.push(value);
        descriptor.set!.call(this, value);
      },
    });
  });
  await page.goto("/?path=/home/user&home=/home/user");
  await waitForEntries(page);
  await expect(page).toHaveTitle("~ - Tauri Explorer");

  // A second tab inherits home, then navigates independently.
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  const folder = page.locator(".entry-item.directory").first();
  const folderName = (await folder.locator(".entry-name").textContent())?.trim();
  expect(folderName).toBeTruthy();
  await folder.dblclick();
  await expect(page).toHaveTitle(`${folderName} - Tauri Explorer`);

  // Switching tabs follows each tab's active directory.
  await page.locator(".tab").first().click();
  await expect(page).toHaveTitle("~ - Tauri Explorer");
  await page.locator(".tab").nth(1).click();
  await expect(page).toHaveTitle(`${folderName} - Tauri Explorer`);

  // A split opens the parent as the active pane; focus back to the original
  // pane restores its directory title.
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".explorer-pane")).toHaveCount(2);
  await expect(page).toHaveTitle("~ - Tauri Explorer");
  await page.locator(".explorer-pane").first().click();
  await expect(page).toHaveTitle(`${folderName} - Tauri Explorer`);

  const history = await page.evaluate(
    () => (window as unknown as { __titleHistory: string[] }).__titleHistory,
  );
  expect(history).not.toContain("Tauri Explorer");
});

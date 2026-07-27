import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

test("window title follows navigation without an empty startup overwrite", async ({ page }) => {
  await page.goto("/?path=/home/user&home=/home/user");
  await waitForEntries(page);
  await expect(page).toHaveTitle("~ - Tauri Explorer");

  const folder = page.locator(".entry-item.directory").first();
  const folderName = (await folder.locator(".entry-name").textContent())?.trim();
  expect(folderName).toBeTruthy();
  await folder.dblclick();

  await expect(page).toHaveTitle(`${folderName} - Tauri Explorer`);
});

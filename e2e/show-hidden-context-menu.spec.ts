/**
 * E2E: the file-list background context menu offers a discoverable
 * "Show hidden files" switch (#1116). The mock home directory holds a
 * `.config` dot-folder, standing in for `.bashrc` and friends.
 */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries } from "./helpers";

const dotFolder = (page: Page) =>
  page.locator(".entry-item .entry-name", { hasText: /^\.config$/ });

async function openBackgroundMenu(page: Page) {
  const box = (await page.locator(".file-list").first().boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 6, { button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  return menu;
}

for (const viewMode of ALL_VIEW_MODES) {
  test(`View menu toggles dotfile visibility [${viewMode}]`, async ({ page }) => {
    await page.goto(`/?path=/home/user&viewMode=${viewMode}`);
    await waitForEntries(page);

    // Hidden display is off by default: no dotfiles are listed.
    await expect(page.locator(".entry-item .entry-name", { hasText: "readme.txt" })).toHaveCount(1);
    await expect(dotFolder(page)).toHaveCount(0);

    let menu = await openBackgroundMenu(page);
    let toggle = menu.getByRole("menuitemcheckbox", { name: /Show hidden files/ });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();

    await expect(menu).toBeHidden();
    await expect(dotFolder(page)).toHaveCount(1);

    menu = await openBackgroundMenu(page);
    toggle = menu.getByRole("menuitemcheckbox", { name: /Show hidden files/ });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();

    await expect(menu).toBeHidden();
    await expect(dotFolder(page)).toHaveCount(0);
  });
}

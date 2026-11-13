import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

// #1661: right-clicking the sidebar Recent heading chooses how many recent
// locations it lists, and the choice persists as the shared setting.
const now = new Date("2026-10-01T12:00:00Z");
const paths = Array.from({ length: 8 }, (_, i) => `/home/user/Documents/project/r${i}`);

test("Recent header context menu changes the number of listed recent locations", async ({ page }) => {
  await page.clock.setFixedTime(now);
  await page.addInitScript(({ paths, now }) => {
    if (localStorage.getItem("fixture-1661")) return;
    localStorage.setItem("fixture-1661", "1");
    localStorage.setItem("explorer-frecency", JSON.stringify(
      paths.map((path, i) => ({ path, accesses: [now - (i + 1) * 60_000] })),
    ));
  }, { paths, now: now.getTime() });
  await page.goto("/?path=/home/user");
  await waitForEntries(page);

  const items = page.locator(".recent-item");
  const header = page.locator('.section-header:has(> span:text-is("Recent"))');
  await expect(items).toHaveCount(6);

  await header.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Recent items to show" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "6", exact: true })).toHaveAttribute("aria-checked", "true");

  await menu.getByRole("menuitemradio", { name: "3", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(items).toHaveCount(3);

  await header.click({ button: "right" });
  await expect(menu.getByRole("menuitemradio", { name: "3", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "10", exact: true }).click();
  await expect(items).toHaveCount(8);

  await page.reload();
  await waitForEntries(page);
  await expect(items).toHaveCount(8);
});

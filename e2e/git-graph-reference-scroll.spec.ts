import { test, expect } from "./fixtures";
import { seedSettings, waitForEntries } from "./helpers";

test("covered scroll delivery preserves tag actions while new movement dismisses them", async ({ page }) => {
  await seedSettings(page, { zoomLevel: 150 }, { replace: true });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const view = page.getByTestId("git-graph-view");
  const tag = view.locator(".commit-row", { hasText: "Bump version to 1.0" });
  await expect(tag).toHaveCount(1);
  const position = await tag.evaluate(row => {
    const scroller = row.closest<HTMLElement>(".graph-scroller")!;
    const before = scroller.scrollTop;
    row.scrollIntoView({ block: "center", inline: "nearest" });
    const after = scroller.scrollTop;
    row.querySelector<HTMLButtonElement>('button[aria-label^="Show all references"]')!.click();
    // Native scroll delivery can follow a click even though positioning is done.
    scroller.dispatchEvent(new Event("scroll"));
    return { before, after };
  });
  expect(position.after).toBeGreaterThan(position.before);
  const menu = view.getByTestId("git-graph-menu");
  await menu.getByRole("menuitem", { name: "Tag: v1.0", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "Delete Tag 'v1.0'…", exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-4-reference-menu-scroll.png", animations: "disabled" });
  await view.locator(".graph-scroller").evaluate(el => { el.scrollTop -= 24; });
  await expect(menu).toBeHidden();
});

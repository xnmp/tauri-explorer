/**
 * E2E: split tab titles (#1935). A multi-pane tab names each pane separately
 * and, on the active tab, dims every name but the focused pane's; its layout
 * icon fills the focused pane's cell. Focus moving between panes moves both.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("split tab title highlights the focused pane and follows focus", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);

  // Split opens the parent as the new, focused pane; open Documents there.
  await page.keyboard.press("Control+\\");
  const panes = page.locator(".explorer-pane:visible");
  await expect(panes).toHaveCount(2);
  await panes.nth(1).locator(".entry-item.directory", { hasText: "Documents" }).first().dblclick();

  const tab = page.locator(".tab.active");
  const names = tab.locator(".tab-pane");
  await expect(names).toHaveText(["Pictures", "Documents"]);
  await expect(tab.locator(".tab-pane-sep")).toHaveCount(1);
  await expect(tab.locator(".tab-icon-split")).toBeVisible();

  // Right pane focused: its name is full strength, the other dimmed, and the
  // icon's filled cell sits in the right half of the layout frame.
  await expect(names.nth(1)).toHaveCSS("opacity", "1");
  await expect(names.nth(0)).toHaveCSS("opacity", "0.5");
  const focusX = () => tab.locator(".split-focus").getAttribute("x").then(Number);
  expect(await focusX()).toBeGreaterThan(8);
  await tab.screenshot({ path: "screenshots/feat/split-tab-title-polish/split-tab-right-focused.png" });

  await panes.nth(0).click();
  await expect(names.nth(0)).toHaveCSS("opacity", "1");
  await expect(names.nth(1)).toHaveCSS("opacity", "0.5");
  expect(await focusX()).toBeLessThan(8);
  await tab.screenshot({ path: "screenshots/feat/split-tab-title-polish/split-tab-left-focused.png" });
});

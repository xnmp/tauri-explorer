/**
 * Window tabs with pane layout trees (#228): the window owns one tab
 * strip; each tab owns a splittable pane layout. Covers: single shared
 * strip, multi-pane tab titles joining folder names, directional splits
 * beyond two panes, rename-to-workspace, and reopening a workspace from
 * the command palette.
 */

import { test, expect, type Page } from "@playwright/test";

const panes = (page: Page) => page.locator(".explorer-pane");

async function openDualPane(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+\\");
  await expect(panes(page)).toHaveCount(2);
  // The second pane opens at the parent directory (/home) by design.
  await expect(
    panes(page).nth(1).locator(".entry-item").filter({ hasText: "user" }).first()
  ).toBeVisible();
}

test.describe("Window tabs with panes", () => {
  test("the window has ONE tab strip; splitting adds panes, not tabs", async ({ page }) => {
    await openDualPane(page);

    await expect(page.locator(".tab-area")).toHaveCount(1);
    await expect(page.locator(".tab")).toHaveCount(1);
  });

  test("a multi-pane tab's title joins both folder names", async ({ page }) => {
    await openDualPane(page);

    // Left pane at /home/user, right pane at /home → "user | home".
    await expect(page.locator(".tab .tab-cwd")).toHaveText("user | home");
  });

  test("directional split creates a third pane (Ctrl+Alt+; = split down)", async ({ page }) => {
    await openDualPane(page);

    await page.keyboard.press("Control+Alt+Semicolon");

    await expect(panes(page)).toHaveCount(3);
    // The new pane duplicated the focused pane's directory and is browsable.
    await expect(panes(page).nth(2).locator(".entry-item").first()).toBeVisible();
  });

  test("generic New Pane command adds a pane (Ctrl+M, dwindle layout)", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+m");
    await expect(panes(page)).toHaveCount(2);

    await page.keyboard.press("Control+m");
    await expect(panes(page)).toHaveCount(3);
  });

  test("Ctrl+W closes the focused pane of a multi-pane tab, not the tab", async ({ page }) => {
    await openDualPane(page);

    await page.keyboard.press("Control+w");

    await expect(panes(page)).toHaveCount(1);
    await expect(panes(page).first().locator(".entry-item").first()).toBeVisible();
  });

  test("Ctrl+Shift+W closes the whole tab even with multiple panes", async ({ page }) => {
    await openDualPane(page);
    // A second tab so closing the first leaves a window to assert on.
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    // Back to the multi-pane tab.
    await page.locator(".tab").first().click();
    await expect(panes(page)).toHaveCount(2);

    await page.keyboard.press("Control+Shift+W");

    // The multi-pane tab is gone entirely; the single-pane tab remains.
    await expect(panes(page)).toHaveCount(1);
  });

  test("Ctrl+Shift+T restores the last closed pane into its split position", async ({ page }) => {
    await openDualPane(page);

    await page.keyboard.press("Control+w");
    await expect(panes(page)).toHaveCount(1);

    await page.keyboard.press("Control+Shift+T");

    // The pane returns showing its old directory (/home, the parent).
    await expect(panes(page)).toHaveCount(2);
    await expect(
      panes(page).nth(1).locator(".entry-item").filter({ hasText: "user" }).first()
    ).toBeVisible();
  });

  test("a multi-pane tab can be renamed and reopened from the command palette", async ({ page }) => {
    await openDualPane(page);

    // Double-click the tab title → inline rename input.
    await page.locator(".tab").first().dblclick();
    const input = page.locator(".tab-rename-input");
    await expect(input).toBeVisible();
    await input.fill("My Workspace");
    await input.press("Enter");

    await expect(page.locator(".tab .tab-cwd")).toHaveText("My Workspace");

    // Collapse to a single pane so the restore visibly changes the layout.
    await page.keyboard.press("Control+\\");
    await expect(panes(page)).toHaveCount(1);

    // The rename saved a workspace — reopen it via the single palette
    // command, which opens a second menu listing the workspaces (#229).
    await page.keyboard.press("Control+Shift+P");
    const palette = page.locator(".command-palette-dialog");
    await palette.locator(".search-input").fill("Workspaces: Open");
    await palette
      .locator(".command-item")
      .filter({ hasText: "Workspaces: Open..." })
      .click();

    const picker = page.locator(".option-picker-dialog");
    await expect(picker).toBeVisible();
    await picker
      .locator(".option-picker-item")
      .filter({ hasText: "My Workspace" })
      .click();

    // The two-pane layout is back, with its custom name.
    await expect(panes(page)).toHaveCount(2);
    await expect(page.locator(".tab .tab-cwd")).toHaveText("My Workspace");
  });

  test("the tab strip lives in the title bar, above the sidebar (#229)", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.keyboard.press("Control+t");

    // The strip renders inside the top title bar, not inside the pane area.
    await expect(page.locator(".titlebar .tab-area")).toHaveCount(1);
    await expect(page.locator(".pane-container .tab-area")).toHaveCount(0);

    // The sidebar starts BELOW the title bar row.
    const barBox = await page.locator(".titlebar").boundingBox();
    const sidebarBox = await page.locator(".sidebar-container").boundingBox();
    expect(sidebarBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1);
  });

  test("single-pane tabs cannot be renamed by double-click", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    // Open a second tab so the strip is visible.
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);

    await page.locator(".tab").first().dblclick();
    await expect(page.locator(".tab-rename-input")).toHaveCount(0);
  });
});

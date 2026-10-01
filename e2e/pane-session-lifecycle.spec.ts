import { test, expect } from "./fixtures";
import { VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

for (const mode of VIEW_MODES) {
  test(`restored inactive tab loads its saved path on first activation (${mode})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("explorer-tabs", JSON.stringify({
        version: 3,
        activeTabId: "home-tab",
        tabs: [
          {
            id: "home-tab",
            kind: "explorer",
            name: "Restored Home",
            activePaneId: "home-pane",
            layout: { type: "leaf", id: "home-pane", path: "/home/user" },
          },
          {
            id: "documents-tab",
            kind: "explorer",
            name: "Restored Documents",
            activePaneId: "documents-pane",
            layout: { type: "leaf", id: "documents-pane", path: "/home/user/Documents" },
          },
        ],
      }));
    });
    await page.goto("/");
    await waitForEntries(page);
    await expect(page.locator('.entry-item[data-path="/home/user/readme.txt"]')).toBeVisible();

    await page.locator(".tab").nth(1).click();
    await switchViewMode(page, mode);
    await expect(page.locator(`.${mode}-view`)).toBeVisible();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    await page.locator('.entry-item[data-path="/home/user/Documents/project"]').dblclick();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project/package.json"]')).toBeVisible();

    await page.locator(".tab").first().click();
    await expect(page.locator('.entry-item[data-path="/home/user/readme.txt"]')).toBeVisible();
    await page.locator(".tab").nth(1).click();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project/package.json"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test(`restored split tab loads both panes and survives tab remount (${mode})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("explorer-tabs", JSON.stringify({
        version: 3,
        activeTabId: "home-tab",
        tabs: [
          {
            id: "home-tab",
            kind: "explorer",
            name: "Restored Home",
            activePaneId: "home-pane",
            layout: { type: "leaf", id: "home-pane", path: "/home/user" },
          },
          {
            id: "split-tab",
            kind: "explorer",
            name: "Restored Split",
            activePaneId: "downloads-pane",
            layout: {
              type: "split",
              id: "saved-split",
              direction: "row",
              ratio: 0.5,
              first: { type: "leaf", id: "documents-pane", path: "/home/user/Documents" },
              second: { type: "leaf", id: "downloads-pane", path: "/home/user/Downloads" },
            },
          },
        ],
      }));
    });
    await page.goto("/");
    await waitForEntries(page);
    await page.locator(".tab").nth(1).click();

    const panes = page.locator(".explorer-pane");
    await expect(panes).toHaveCount(2);
    await expect(panes.first().locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    await expect(panes.nth(1).locator('.entry-item[data-path="/home/user/Downloads/archive.zip"]')).toBeVisible();
    await page.locator(".tab").first().click();
    await expect(page.locator('.entry-item[data-path="/home/user/readme.txt"]')).toBeVisible();
    await page.locator(".tab").nth(1).click();
    await expect(panes).toHaveCount(2);
    await expect(panes.first().locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    await expect(panes.nth(1).locator('.entry-item[data-path="/home/user/Downloads/archive.zip"]')).toBeVisible();
    expect(errors).toEqual([]);

    if (mode === "details") {
      await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/lazy-restored-split-tab.png" });
    }
  });

  test(`pane close and restore retains working navigation (${mode})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await switchViewMode(page, mode);
    await page.keyboard.press("Control+m");
    const panes = page.locator(".explorer-pane");
    await expect(panes).toHaveCount(2);
    const active = page.locator(".explorer-pane.active");
    await expect(active.locator(`.${mode}-view`)).toBeVisible();
    await active.locator('.entry-item[data-path="/home/user/Documents"]').dblclick();
    await expect(active.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    await page.keyboard.press("Control+w");
    await expect(panes).toHaveCount(1);
    await page.keyboard.press("Control+Shift+T");
    await expect(panes).toHaveCount(2);
    await expect(active.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    await page.keyboard.press("Control+Alt+ArrowUp");
    await expect(active.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
    expect(errors).toEqual([]);
    if (mode === "details") {
      await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/pane-restoration.png" });
    }
  });
}

import { expect, test } from "@playwright/test";
import { waitForEntries, HOME_URL } from "./helpers";

const root = "/home/user/Documents";
const row = (page: import("@playwright/test").Page, path: string) => page.locator(`.pane-tree:not(.retained) .entry-item[data-path="${path}"]`);
async function start(page: import("@playwright/test").Page) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async path => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode("details");
    await explorer.navigateTo(path, { autoEnterSingleSubdir: false });
  }, root);
  await expect(row(page, `${root}/project`)).toBeVisible();
}

test.beforeEach(async ({ page }) => start(page));

test("caret toggles only its branch, preserves selection, and restores nested peeks", async ({ page }) => {
  const project = row(page, `${root}/project`);
  const selected = await page.locator('.pane-tree:not(.retained) .entry-item.selected').evaluateAll(elements => elements.map(e => e.getAttribute("data-path")));
  await project.getByRole("button", { name: "Expand project", exact: true }).click();
  const src = row(page, `${root}/project/src`);
  await expect(src).toBeVisible();
  expect(await page.locator('.pane-tree:not(.retained) .entry-item.selected').evaluateAll(elements => elements.map(e => e.getAttribute("data-path")))).toEqual(selected);
  await expect(project.locator(".entry-name")).toHaveCSS("font-weight", "600");
  await expect(src.locator(".name-cell")).toHaveCSS("padding-left", "22px");
  await expect(page.getByRole("treegrid", { name: "Files" })).toBeVisible();
  await expect(src.locator("..")).toHaveAttribute("aria-level", "2");
  await src.getByRole("button", { name: "Expand src", exact: true }).click();
  await expect(row(page, `${root}/project/src/components`)).toBeVisible();
  await project.getByRole("button", { name: "Collapse project", exact: true }).click();
  await expect(src).toHaveCount(0);
  await project.getByRole("button", { name: "Expand project", exact: true }).click();
  await expect(row(page, `${root}/project/src/components`)).toBeVisible();
  await expect(project.locator("..").locator(".peek-guide").first()).toHaveCount(0);
  await expect(src.locator("..").locator(".peek-guide").first()).toHaveCSS("width", "1.5px");
  await page.reload(); await waitForEntries(page);
  expect(await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.expandedPaths.size)).toBe(0);
});

test("List and Tiles stay flat and returning to Details restores expansion", async ({ page }) => {
  await row(page, `${root}/project`).getByRole("button", { name: "Expand project", exact: true }).click();
  await expect(row(page, `${root}/project/src`)).toBeVisible();
  for (const mode of ["list", "tiles", "details"] as const) {
    await page.evaluate(async mode => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      windowTabsManager.getActiveExplorer()!.setViewMode(mode);
    }, mode);
    if (mode === "details") await expect(row(page, `${root}/project/src`)).toBeVisible();
    else { await expect(page.locator(".peek-caret")).toHaveCount(0); await expect(row(page, `${root}/project/src`)).toHaveCount(0); }
  }
});

test("an empty peek is a nonselectable row and the root count stays unchanged", async ({ page }) => {
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.navigateTo("/home/user", { autoEnterSingleSubdir: false });
  });
  await row(page, "/home/user/Archive").getByRole("button", { name: "Expand Archive", exact: true }).click();
  await expect(page.locator(".peek-state")).toHaveText("Empty folder");
  await expect(page.locator(".peek-state[data-index]")).toHaveCount(0);
});

export { start, row, root };

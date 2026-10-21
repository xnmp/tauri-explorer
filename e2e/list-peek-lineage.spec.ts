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

test("nested List peeks show lineage guides like Details", async ({ page }) => {
  await row(page, `${root}/project`).getByRole("button", { name: "Expand project", exact: true }).click();
  await row(page, `${root}/project/src`).getByRole("button", { name: "Expand src", exact: true }).click();
  await expect(row(page, `${root}/project/src/components`)).toBeVisible();

  const detailsGuides = row(page, `${root}/project/src/components`).locator("..").locator(".peek-guide");
  await expect(detailsGuides).toHaveCount(2);
  await expect(detailsGuides.first()).toBeVisible();

  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    windowTabsManager.getActiveExplorer()!.setViewMode("list");
  });
  const listCard = page.locator(`.pane-tree:not(.retained) [data-card-scroll][data-path="${root}/project"]`);
  await expect(listCard.locator(`.entry-item[data-path="${root}/project/src/components"]`)).toBeVisible();
  const listGuides = listCard.locator(".list-guide");
  await expect(listGuides).toHaveCount(2);
  await expect(listGuides.first()).toBeVisible();
  await listCard.evaluate(el => { el.scrollTop = 120; });
  await expect(listCard.locator(`.entry-item[data-path="${root}/project/src/components"]`)).toBeInViewport();
  for (const guide of await listGuides.all()) {
    await expect(guide).toHaveCSS("width", "1.5px");
    await expect(guide).toHaveCSS("pointer-events", "none");
    await expect(guide).toBeInViewport();
    expect(await guide.evaluate(el => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
  }
  await page.mouse.move(1100, 650);
  await page.screenshot({ path: "evidence/ac-1-list-peek-lineage.png" });
});


import { test, expect, type Locator, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: Page, zoom: number, width: number, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(value => {
    localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value }));
  }, zoom);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/?path=/home/user/Documents/project${query}`);
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const view = page.getByTestId("git-graph-view");
  await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  return { view, errors };
}

async function expectColumnsAligned(view: Locator) {
  await expect.poll(() => view.evaluate(element => {
    const rows = [...element.querySelectorAll<HTMLElement>(".commit-row:not(.uncommitted)")];
    if (!rows.length) return Infinity;
    return Math.max(...rows.flatMap(row => [
      [".gh-author", ".author"], [".gh-date", ".date"],
      [".gh-oid:not(.gh-parent)", ".oid:not(.parent-col)"], [".gh-parent", ".parent-col"],
    ].flatMap(([headerSelector, rowSelector]) => {
      const header = element.querySelector(headerSelector)?.getBoundingClientRect();
      const cell = row.querySelector(rowSelector)?.getBoundingClientRect();
      if (!header && !cell) return [0];
      return header && cell ? [Math.abs(header.left - cell.left), Math.abs(header.right - cell.right)] : [Infinity];
    })));
  })).toBeLessThanOrEqual(1);
}

for (const [zoom, width, resized] of [[80, 1280, 1040], [100, 1280, 1440], [150, 1100, 900]]) {
  test(`graph header tracks its rows and keeps the filter usable at ${zoom}%`, async ({ page }) => {
    const { view, errors } = await openGraph(page, zoom, width);
    await expectColumnsAligned(view);
    await page.setViewportSize({ width: resized, height: 800 });
    await expectColumnsAligned(view);

    await view.locator(".graph-header").click({ button: "right" });
    await view.getByRole("menuitemcheckbox", { name: /Author/ }).click();
    await page.keyboard.press("Escape");
    await expect(view.locator(".gh-author")).toHaveCount(0);
    await expectColumnsAligned(view);

    // The header must remain overflow-visible: the real filter opens below it.
    await view.getByTestId("branch-filter-btn").click();
    const filter = view.getByTestId("git-graph-file-path-filter");
    await filter.fill("src/file-9.ts");
    await expect(view.locator(".commit-row")).toHaveCount(1);
    await expect(view.locator(".commit-row")).toContainText("Implement feature X");
    await expectColumnsAligned(view);

    // Removing the scroller must not retain its old width when a replacement
    // appears after the viewport changes while there are no matching commits.
    await filter.fill("does-not-exist-in-this-repository");
    await expect(view.locator(".commit-row")).toHaveCount(0);
    await page.setViewportSize({ width, height: 800 });
    await filter.fill("");
    await expect(view.locator(".commit-row")).toHaveCount(18);
    await page.keyboard.press("Escape");
    await expect(view.getByTestId("branch-popover")).toBeHidden();
    await expectColumnsAligned(view);
    await view.locator(".graph-header").click({ button: "right" });
    await view.getByRole("menuitemcheckbox", { name: /Author/ }).click();
    await page.keyboard.press("Escape");
    await expect(view.locator(".gh-author")).toBeVisible();
    await expectColumnsAligned(view);
    expect(errors).toEqual([]);
    if (zoom === 100) await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/graph-header-layout.png" });
  });
}

for (const zoom of [80, 100, 150]) {
  test(`horizontal graph scrolling preserves columns and clamps after hiding them at ${zoom}%`, async ({ page }) => {
    const { view, errors } = await openGraph(page, zoom, 900);
    // A wide configured graph gutter exercises overflow even below 100% zoom.
    const handle = view.getByTestId("handle-graph");
    await handle.focus();
    await page.keyboard.press("End");
    await view.locator(".graph-header").click({ button: "right", position: { x: 20, y: 13 } });
    await view.getByRole("menuitemcheckbox", { name: /Parent/ }).click();
    await page.keyboard.press("Escape");
    await expectColumnsAligned(view);
    const scroller = view.locator(".graph-scroller");
    await expect.poll(() => scroller.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
    await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    await expectColumnsAligned(view);
    const merge = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
    await expect(merge.locator(".parent-col")).toBeInViewport();
    await expect(merge.locator(".parent-col")).not.toHaveText("—");

    for (const column of ["Parent", "Commit", "Date", "Author"]) {
      await view.locator(".graph-header").click({ button: "right" });
      await view.getByRole("menuitemcheckbox", { name: new RegExp(`(?:^| )${column}$`) }).click();
      await page.keyboard.press("Escape");
      await expectColumnsAligned(view);
      await expect.poll(() => scroller.evaluate(el => Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth)))).toBeLessThanOrEqual(1);
    }
    await scroller.evaluate(el => { el.scrollLeft = 0; });
    await expectColumnsAligned(view);
    await handle.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => scroller.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await view.getByTestId("branch-filter-btn").click();
    await view.getByTestId("git-graph-file-path-filter").fill("src/file-9.ts");
    await expect(view.locator(".commit-row")).toHaveCount(1);
    await expect(view.locator(".commit-row")).toContainText("Implement feature X");
    await page.keyboard.press("Escape");
    await expect(view.getByTestId("branch-popover")).toBeHidden();
    expect(errors).toEqual([]);
  });
}

test("all references exposes a clipped PR and scoped branch actions at high zoom", async ({ page }) => {
  const { view, errors } = await openGraph(page, 150, 900, "&gitGraphBaseUpdateFixture");
  const row = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  const trigger = row.getByRole("button", { name: /Show all references/ });
  // main + origin + release precede this PR: the compact inline cell cannot
  // expose it, even when the whole table is scrolled to the right.
  await expect.poll(() => row.locator(".ref-pr").evaluate(el => {
    const bounds = el.closest(".message-content")!.getBoundingClientRect();
    return el.getBoundingClientRect().left >= bounds.right;
  })).toBe(true);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = view.getByTestId("git-graph-menu");
  await expect(view.getByTestId("git-graph-detail")).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Branch: main (origin/main)", exact: true })).toBeFocused();
  await menu.getByRole("menuitem", { name: /PR #27:/ }).click();
  await expect(view.getByTestId("git-graph-pr-detail")).toContainText("Keep release branch current");
  await expect(menu).toBeHidden();
  await view.getByRole("button", { name: "Close PR details", exact: true }).click();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "Branch: release", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("menuitem", { name: "Checkout release", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Delete Branch 'release'/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const beforeScroll = await view.locator(".graph-scroller").evaluate(el => {
    const before = el.scrollLeft;
    el.scrollLeft = before > 0 ? 0 : el.scrollWidth;
    return before;
  });
  await expect.poll(() => view.locator(".graph-scroller").evaluate(el => el.scrollLeft)).not.toBe(beforeScroll);
  await expect(menu).toBeHidden();
  await expectColumnsAligned(view);
  expect(errors).toEqual([]);
  await view.locator(".graph-scroller").evaluate(el => { el.scrollLeft = 0; });
  await trigger.click();
  await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/graph-references-access.png" });
});

test("reference disclosure retains long names, tags, remotes, and stashes", async ({ page }) => {
  const { view, errors } = await openGraph(page, 150, 900);
  const tip = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  await tip.click({ button: "right" });
  const menu = view.getByTestId("git-graph-menu");
  await menu.getByRole("menuitem", { name: "Create Branch…", exact: true }).click();
  const prompt = view.getByTestId("git-graph-prompt");
  const longName = "release/" + "a-long-descriptive-branch-name-".repeat(6);
  await prompt.locator("input").fill(longName);
  await prompt.getByRole("button", { name: "Create branch", exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(tip).toContainText(longName);
  await tip.getByRole("button", { name: /Show all references/ }).click();
  const branch = menu.getByRole("menuitem", { name: `Branch: ${longName}`, exact: true });
  await expect(branch).toBeInViewport();
  await expect(menu.getByRole("menuitem", { name: "Branch: main (origin/main)", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const remote = view.locator(".commit-row", { hasText: "Refactor config loader" });
  await remote.getByRole("button", { name: /Show all references/ }).click();
  await menu.getByRole("menuitem", { name: "Remote: origin/legacy-import", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "Checkout legacy-import (tracking origin/legacy-import)", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const tag = view.locator(".commit-row", { hasText: "Bump version to 1.0" });
  await tag.getByRole("button", { name: /Show all references/ }).click();
  await menu.getByRole("menuitem", { name: "Tag: v1.0", exact: true }).click();
  await expect(menu.getByRole("menuitem", { name: "Delete Tag 'v1.0'…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await view.locator(".commit-row", { hasText: "WIP on main" }).getByRole("button", { name: /Show all references/ }).click();
  await expect(menu.getByRole("menuitem", { name: "Stash: stash@{0}", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectColumnsAligned(view);
  expect(errors).toEqual([]);
});

test("commit row Enter selects its commit without activating the retained file selection", async ({ page }) => {
  const { view, errors } = await openGraph(page, 100, 1280);
  const row = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  const path = await page.locator(".status-path").getAttribute("title");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(view.getByTestId("git-graph-detail")).toContainText("Merge hotfix into main");
  await expect(row).toHaveClass(/selected/);
  await expect(row).toBeFocused();
  await expect(page.locator(".status-path")).toHaveAttribute("title", path!);
  await expect(view).toBeVisible();
  expect(errors).toEqual([]);
});

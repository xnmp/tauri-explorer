import fs from "node:fs";
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, VIEW_MODES, type ViewMode } from "./helpers";
const target = "/home/user/Documents/project";
const other = `${target}/src`;
const now = new Date("2026-10-01T12:00:00Z");
const proof = "screenshots/fix/754-removing-items-from-recent-should-reduce-their-frecency-score";
const recent = (page: Page, path: string) => page.locator(`.recent-item[title="${path}"]`);
async function scores(page: Page) {
  return page.evaluate(async ({ target, other }) => {
    const modulePath = "/src/lib/state/frecency.svelte.ts";
    const { computeFrecencyScore } = await import(modulePath);
    const entries = JSON.parse(localStorage.getItem("explorer-frecency") || "[]") as Array<{ path: string; accesses: number[] }>;
    const score = (path: string) => computeFrecencyScore(entries.find((entry) => entry.path === path)?.accesses || [], Date.now());
    return { target: score(target), other: score(other) };
  }, { target, other });
}
async function capture(page: Page, name: string) {
  if (process.env.CAPTURE_754 !== "1") return;
  fs.mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: `${proof}/${name}.png` });
}
async function switchViewMode(page: Page, mode: ViewMode) {
  const label = `${mode[0].toUpperCase()}${mode.slice(1)} View`;
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill(label);
  await palette.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: new RegExp(`^${label}$`) }) }).click();
  await expect(palette).toBeHidden();
  await expect(page.locator(`.${mode}-view`)).toBeVisible();
}
async function navigate(page: Page, path: string) {
  await page.keyboard.press("Control+l");
  await page.locator(".path-input").fill(path);
  await page.keyboard.press("Enter");
  await waitForEntries(page);
}
for (const mode of VIEW_MODES) test(`Recent dismissal persists across browse/reload and recovers after file preview [${mode}]`, async ({ page }) => {
  await page.clock.setFixedTime(now);
  await page.addInitScript(({ target, other, now }) => {
    if (localStorage.getItem("fixture-754")) return;
    localStorage.setItem("fixture-754", "1");
    localStorage.setItem("explorer-frecency", JSON.stringify([
      { path: target, accesses: [now - 10_800_000, now - 7_200_000, now - 3_600_000, now] },
      { path: other, accesses: [now - 14_400_000, now - 14_400_000] },
    ]));
  }, { target, other, now: now.getTime() });
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  await switchViewMode(page, mode);
  await expect(recent(page, target)).toBeVisible();
  await expect(recent(page, other)).toBeVisible();
  const before = await scores(page);
  await capture(page, `${mode}-recent-before-removal`);
  await recent(page, target).hover();
  await recent(page, target).getByRole("button", { name: "Remove project from recent locations" }).click();
  await expect(recent(page, target)).toHaveCount(0);
  await expect(recent(page, other)).toBeVisible();
  const reduced = await scores(page);
  expect(reduced.target).toBeGreaterThan(0);
  expect(reduced.target).toBeLessThan(before.target);
  expect(reduced.other).toBe(before.other);
  await capture(page, `${mode}-recent-after-downvote`);
  await navigate(page, target);
  await expect(page.locator(`.entry-item[data-path="${target}/README.md"]`)).toBeVisible();
  await expect(recent(page, target)).toHaveCount(0);
  expect(await scores(page)).toEqual(reduced);
  await capture(page, `${mode}-removed-folder-open-row-absent`);
  await page.reload();
  await waitForEntries(page);
  await expect(recent(page, target)).toHaveCount(0);
  expect(await scores(page)).toEqual(reduced);
  await navigate(page, target);
  await switchViewMode(page, mode);
  await expect(recent(page, target)).toHaveCount(0);
  await page.locator(`.entry-item[data-path="${target}/README.md"]`).click();
  await page.keyboard.press("Space");
  await expect(page.locator(".preview-pane")).toBeVisible();
  await expect(recent(page, target)).toBeVisible();
  const recovered = await scores(page);
  expect(recovered.target).toBeGreaterThan(reduced.target);
  expect(recovered.other).toBe(reduced.other);
  await capture(page, `${mode}-qualifying-preview-restores-recent`);
  await page.reload();
  await waitForEntries(page);
  await expect(recent(page, target)).toBeVisible();
  console.log(JSON.stringify({ before, reduced, recovered }));
});

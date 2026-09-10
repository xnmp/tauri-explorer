/** Whole-workspace replacement must dispose old panes and remain usable. */
import { test, expect, type Page } from "@playwright/test";
import { openApp, createTabAndOpenGraph, loadRepoPath, forceGcAndGetHeap, MB } from "./load-helpers";

const CYCLES = Number(process.env.LOAD_CYCLES ?? 25);
if (!Number.isSafeInteger(CYCLES) || CYCLES < 1) {
  throw new Error("LOAD_CYCLES must be a positive safe integer");
}
const GRAPH = '[data-testid="git-graph-view"]';

async function command(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill(label);
  await palette.locator(".command-item").filter({ hasText: label }).click();
  await expect(palette).toBeHidden();
}

async function saveWorkspace(page: Page, name: string): Promise<void> {
  await command(page, "Workspaces: Manage...");
  const dialog = page.locator(".dialog-backdrop .dialog");
  await dialog.getByRole("button", { name: "Save Current Layout" }).click();
  await dialog.locator(".save-input").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.locator(".workspace-name").filter({ hasText: name })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

async function restoreWorkspace(page: Page, expanded: boolean): Promise<void> {
  await command(page, "Workspaces: Open...");
  const picker = page.locator(".option-picker-dialog");
  await picker.locator(".option-picker-item").filter({
    hasText: expanded ? "Expanded load workspace" : "Base load workspace",
  }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator(".explorer-pane")).toHaveCount(expanded ? 2 : 1);
  await expect(page.locator(".tab")).toHaveCount(expanded ? 2 : 1);
  await expect(page.locator(GRAPH)).toHaveCount(expanded ? 1 : 0);
  if (expanded) {
    await expect(page.locator(`${GRAPH} .commit-row`).first()).toContainText("[load-repo-0]");
  }
  await expect(page.locator(`.entry-item[data-path="${loadRepoPath(0)}"]`).first()).toBeVisible();
}

test("saved workspace replacement stays within its retained JS heap budget", async ({ page }) => {
  test.setTimeout(120_000 + CYCLES * 5_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openApp(page);
  await saveWorkspace(page, "Base load workspace");
  await createTabAndOpenGraph(page, loadRepoPath(0));
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".explorer-pane")).toHaveCount(2);
  await saveWorkspace(page, "Expanded load workspace");

  // Load optional modules and exercise both restoration paths before baseline.
  await restoreWorkspace(page, false);
  await restoreWorkspace(page, true);
  await restoreWorkspace(page, false);
  const client = await page.context().newCDPSession(page);
  async function sample(cycle: number): Promise<number> {
    const heap = await forceGcAndGetHeap(page);
    expect(heap, "precise Chromium heap measurement is required").not.toBeNull();
    const dom = await client.send("Memory.getDOMCounters");
    console.log(`[LOAD] workspace cycle=${cycle} heap=${((heap as number) / MB).toFixed(2)} MiB documents=${dom.documents} nodes=${dom.nodes} listeners=${dom.jsEventListeners}`);
    return heap as number;
  }
  const baseline = await sample(0);
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    await restoreWorkspace(page, true);
    await restoreWorkspace(page, false);
    if (cycle % 25 === 0 || cycle === CYCLES) {
      expect(await sample(cycle) - baseline).toBeLessThanOrEqual(25 * MB);
    }
  }
  expect(errors).toEqual([]);
  await client.detach();
  await restoreWorkspace(page, true);
  await page.screenshot({
    path: "screenshots/refactor/repo-health-cleanup/workspace-retention.png",
  });
});

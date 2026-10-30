/**
 * Lineage prompt labels (#1449): a lineage provider's `labels` add a Details
 * Prompt column and label each lineage child by its prompt. A + B were merged
 * into m; A was edited into c and d.
 */
import { expect, test, type Page } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

const root = "/lineage-prompts";
const P = (name: string) => `${root}/${name}`;
const pane = ".pane-tree:not(.retained)";
const rows = (page: Page, name: string) => page.locator(`${pane} .entry-item[data-path="${P(name)}"]`);
const nameOf = (page: Page, name: string) => rows(page, name).locator(".entry-name");
const promptCell = (page: Page, name: string) => rows(page, name).locator('[data-cell="prompt"]');
const promptHeader = (page: Page) => page.locator(`${pane} .column-header.prompt-column`);
const LINEAGE = { "c.png": ["A.png"], "d.png": ["A.png"], "m.png": ["A.png", "B.png"] };
const WINTER = "Make the fox blue and add a snowy winter forest behind it, keeping the original pose and lighting";
const LABELS = {
  "A.png": { prompt: "Red fox sitting in tall grass" },
  "B.png": { prompt: "Pine forest at dusk" },
  "c.png": { prompt: WINTER, title: "Blue fox in winter" },
  "d.png": { prompt: "Crop to a square around the face" },
  "m.png": { prompt: "Place the fox from A into the forest from B" },
};

async function start(page: Page, options: { labels?: boolean } = {}) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async ({ root, lineage, labels }) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    const at = Date.UTC(2026, 0, 1);
    const file = (name: string) => ({ name, path: `${root}/${name}`, kind: "file" as const, size: 4096, modified: new Date(at).toISOString() });
    mockFiles[root] = ["A.png", "B.png", "c.png", "d.png", "m.png", "notes.txt"].map(file);
    (await import("/src/test-support/lineage-provider.ts")).install(root, lineage, labels ? { labels } : {});
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode("details");
    await explorer.navigateTo(root, { autoEnterSingleSubdir: false });
  }, { root, lineage: LINEAGE, labels: options.labels === false ? null : LABELS });
  await expect(rows(page, "A.png")).toBeVisible();
}

const expand = (page: Page, name: string) => rows(page, name).getByRole("button", { name: `Expand ${name}`, exact: true }).click();
const explorerEval = <T>(page: Page, fn: string) => page.evaluate(async source => {
  const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
  return new Function("explorer", `return (${source})`)(windowTabsManager.getActiveExplorer()!) as T;
}, fn);

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => (await import("/src/test-support/lineage-provider.ts")).uninstall()).catch(() => {});
});

test("labels add a Prompt column and label lineage children by their prompt", async ({ page }) => {
  await start(page);
  await expect(promptHeader(page)).toHaveText("Prompt");
  // Every file the provider knows shows its prompt; other files show "—".
  await expect(promptCell(page, "A.png")).toHaveText(LABELS["A.png"].prompt);
  await expect(promptCell(page, "notes.txt")).toHaveText("—");
  // Depth 0 keeps filenames.
  await expect(nameOf(page, "A.png")).toHaveText("A.png");

  await expand(page, "A.png");
  // A child shows its title (preferred), else its prompt; the filename stays in the tooltip.
  await expect(nameOf(page, "c.png")).toHaveText("Blue fox in winter");
  await expect(nameOf(page, "c.png")).toHaveAttribute("title", `c.png\n${WINTER}`);
  await expect(nameOf(page, "d.png")).toHaveText(LABELS["d.png"].prompt);
  await expect(nameOf(page, "m.png")).toHaveText(LABELS["m.png"].prompt);
  // The column keeps the full prompt on one line, truncated, with the full text in its tooltip.
  await expect(promptCell(page, "c.png")).toHaveText(WINTER);
  await expect(promptCell(page, "c.png")).toHaveAttribute("title", WINTER);
  const cell = await promptCell(page, "c.png").evaluate(element => ({ overflow: getComputedStyle(element).textOverflow, wrap: getComputedStyle(element).whiteSpace, clipped: element.scrollWidth > element.clientWidth }));
  expect(cell).toEqual({ overflow: "ellipsis", wrap: "nowrap", clipped: true });
  await page.screenshot({ path: "screenshots/feat/lineage-prompt-labels/details-prompt-column.png" });
  // The merge output under B is labelled too (its group row keeps "with A.png").
  await expand(page, "B.png");
  await expect(nameOf(page, "m.png")).toHaveText([LABELS["m.png"].prompt, LABELS["m.png"].prompt]);
  await page.screenshot({ path: "screenshots/feat/lineage-prompt-labels/expanded-parents-labelled.png" });
  await rows(page, "B.png").getByRole("button", { name: "Collapse B.png", exact: true }).click();

  // Selecting a labelled child keeps file identity: the status bar names the file.
  await rows(page, "c.png").click();
  const selected = await explorerEval<string[]>(page, "explorer.getSelectedEntries().map(entry => entry.name)");
  expect(selected).toEqual(["c.png"]);
});

test("F2 on a labelled child edits the filename", async ({ page }) => {
  await start(page);
  await expand(page, "A.png");
  await rows(page, "c.png").click();
  await page.keyboard.press("F2");
  const input = rows(page, "c.png").locator(".rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("c.png");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(nameOf(page, "c.png")).toHaveText("Blue fox in winter");
});

test("turning Show traces off restores filenames and hides the column", async ({ page }) => {
  await start(page);
  await expand(page, "A.png");
  await expect(nameOf(page, "c.png")).toHaveText("Blue fox in winter");
  await explorerEval(page, `explorer.setEntryLineageShown("e2e.lineage", false)`);
  await expect(promptHeader(page)).toHaveCount(0);
  await expect(page.locator(`${pane} [data-cell="prompt"]`)).toHaveCount(0);
  await expect(nameOf(page, "c.png")).toHaveText("c.png");
  await explorerEval(page, `explorer.setEntryLineageShown("e2e.lineage", true)`);
  await expect(promptHeader(page)).toBeVisible();
  await expect(promptCell(page, "A.png")).toHaveText(LABELS["A.png"].prompt);
});

test("the Prompt column hides and returns from the header menu, with its row cells", async ({ page }) => {
  await start(page);
  const header = page.locator(`${pane} .column-headers`);
  const cells = page.locator(`${pane} .entry-item [data-cell="prompt"]`);
  expect(await cells.count()).toBeGreaterThan(0);
  await expect(cells).toHaveCount(await page.locator(`${pane} .entry-item`).count());
  await header.click({ button: "right" });
  await page.locator(".column-menu-item", { hasText: "Prompt" }).click();
  await expect(promptHeader(page)).toHaveCount(0);
  await expect(cells).toHaveCount(0);
  await header.click({ button: "right" });
  await page.locator(".column-menu-item", { hasText: "Prompt" }).click();
  await expect(promptHeader(page)).toBeVisible();
  await expect(cells).toHaveCount(await page.locator(`${pane} .entry-item`).count());
});

test("sorting by Prompt orders files by their text, files without one last", async ({ page }) => {
  await start(page);
  await promptHeader(page).click();
  const order = () => page.locator(`${pane} .entry-item`).evaluateAll(elements => elements.map(element => element.getAttribute("data-path")!.split("/").pop()));
  // "Pine forest…" < "Red fox…" (name order is the reverse); notes.txt has no prompt.
  await expect.poll(order).toEqual(["B.png", "A.png", "notes.txt"]);
  await promptHeader(page).click();
  await expect.poll(order).toEqual(["notes.txt", "A.png", "B.png"]);
});

test("the name filter matches prompts as well as filenames", async ({ page }) => {
  await start(page);
  await explorerEval(page, `(explorer.openFilter(), explorer.setFilter("winter"))`);
  await expect(rows(page, "c.png")).toHaveCount(1);
  await expect(rows(page, "A.png")).toHaveCount(0);
  // Grouping is suspended, so the match is a depth-0 row and keeps its filename.
  await expect(nameOf(page, "c.png")).toHaveText("c.png");
});

test("a provider without labels shows no Prompt column and keeps filenames", async ({ page }) => {
  await start(page, { labels: false });
  await expand(page, "A.png");
  await expect(rows(page, "c.png")).toBeVisible();
  await expect(nameOf(page, "c.png")).toHaveText("c.png");
  await expect(promptHeader(page)).toHaveCount(0);
  await expect(page.locator(`${pane} [data-cell="prompt"]`)).toHaveCount(0);
  await page.locator(`${pane} .column-headers`).click({ button: "right" });
  await expect(page.locator(".column-menu-item", { hasText: "Date modified" })).toBeVisible();
  await expect(page.locator(".column-menu-item", { hasText: "Prompt" })).toHaveCount(0);
});

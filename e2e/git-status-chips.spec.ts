/**
 * Git status chips and tinted names (#1852), in every file-list renderer.
 *
 * The mock repo (/home/user/Documents/project, src/lib/api/mock-git.ts) has
 * CHANGELOG.md Modified, .env.example Untracked, babel.config.js Ignored and
 * package.json clean. Outcomes are read from computed styles: the name takes
 * the theme's `--git-*` colour, the chip carries a visible tint, an ignored
 * name is dimmed without a chip, and a clean name keeps the list's text colour.
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, VIEW_VARIANTS, waitForEntries, type ViewMode } from "./helpers";

const PROJECT = "/home/user/Documents/project";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

// VIEW_VARIANTS adds classic List; classic Tiles (no Folder Peek) is its own renderer too.
const variants = [
  ...VIEW_VARIANTS,
  ...(VIEW_MODES.includes("tiles") ? [{ name: "tiles-classic", viewMode: "tiles" as const, classic: true }] : []),
];

async function open(page: Page, viewMode: ViewMode, { classic = false, theme = "light" } = {}): Promise<void> {
  await page.addInitScript(({ viewMode, classic, theme }) => {
    if (sessionStorage.getItem("git-chips-seeded")) return;
    sessionStorage.setItem("git-chips-seeded", "1");
    localStorage.setItem("explorer-settings", JSON.stringify({
      theme, viewMode, showGitStatus: true, showHidden: true, folderPeek: !classic,
    }));
  }, { viewMode, classic, theme });
  await page.goto(`/?path=${encodeURIComponent(PROJECT)}`);
  await waitForEntries(page);
  await expect(page.locator(`.${viewMode}-view`)).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.locator(`.pane-tree:not(.retained) .file-list .entry-item[data-path="${PROJECT}/${name}"]`);

/** A CSS colour as the file list resolves it (theme variables, color-scheme). */
async function resolved(page: Page, color: string): Promise<string> {
  return page.locator(".pane-tree:not(.retained) .file-list").first().evaluate((list, color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    list.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, color);
}

const nameColor = (page: Page, name: string) =>
  row(page, name).locator(".entry-name").evaluate((el) => getComputedStyle(el).color);

async function expectDecorations(page: Page): Promise<void> {
  const text = await resolved(page, "var(--text-primary)");
  const dimmed = await resolved(page, "var(--text-secondary)");

  for (const [name, variable, letter] of [
    ["CHANGELOG.md", "--git-modified", "M"],
    [".env.example", "--git-untracked", "U"],
  ] as const) {
    const expected = await resolved(page, `var(${variable})`);
    expect(expected, `${variable} resolves to a real colour`).not.toBe(text);
    await expect.poll(() => nameColor(page, name), { message: `${name} name tint` }).toBe(expected);
    const chip = row(page, name).locator(".git-indicator");
    await expect(chip).toHaveText(letter);
    await expect(chip).toHaveCSS("color", expected);
    expect(await chip.evaluate((el) => getComputedStyle(el).backgroundColor), `${name} chip fill`).not.toBe(TRANSPARENT);
  }

  // Ignored: dimmed name, no chip. Clean: the list's own text colour, no chip.
  await expect.poll(() => nameColor(page, "babel.config.js"), { message: "ignored name dimmed" }).toBe(dimmed);
  expect(dimmed).not.toBe(text);
  await expect(row(page, "babel.config.js").locator(".git-indicator")).toHaveCount(0);
  expect(await nameColor(page, "package.json"), "clean name").toBe(text);
  await expect(row(page, "package.json").locator(".git-indicator")).toHaveCount(0);
}

for (const { name, viewMode, classic } of variants) {
  test(`[${name}] Git status tints names and shows chips`, async ({ page }) => {
    await open(page, viewMode, { classic });
    await expectDecorations(page);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`[details] ${theme} theme: status colours stay readable`, async ({ page }) => {
    await open(page, "details", { theme });
    await expectDecorations(page);
    // The theme's own shade: darker on light themes, brighter on dark ones.
    expect(await resolved(page, "var(--git-modified)")).toBe(theme === "light" ? "rgb(152, 84, 5)" : "rgb(229, 181, 74)");
    expect(await resolved(page, "var(--git-untracked)")).toBe(theme === "light" ? "rgb(19, 119, 58)" : "rgb(74, 222, 128)");
    await page.locator(".pane-tree:not(.retained) .file-list").first()
      .screenshot({ path: `screenshots/feat/git-status-chips/details-${theme}.png`, animations: "disabled" });
  });
}

test("[details] Git decorations disappear when the setting is off", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings", JSON.stringify({ theme: "light", viewMode: "details", showGitStatus: false, showHidden: true }));
  });
  await page.goto(`/?path=${encodeURIComponent(PROJECT)}`);
  await waitForEntries(page);
  await expect(page.locator(".git-indicator")).toHaveCount(0);
  await expect(page.locator(".entry-name.git-tinted")).toHaveCount(0);
});

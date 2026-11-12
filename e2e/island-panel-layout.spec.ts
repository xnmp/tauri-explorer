/**
 * Island / panel layout batch (#434).
 *
 * Three related defects:
 *  1. The SCM panel, when it's a section of the explorer pane (not its own
 *     island), must render docked & flat like the miller bar — NOT as a
 *     floating hover card — even under island (vibrancy) mode.
 *  2. The SCM panel toggle is per-pane: toggling it in one pane must not
 *     affect sibling panes.
 *  3. With no sidebar in island mode, miller columns must render exactly once
 *     (they used to double-mount: once inline in the pane AND once as the
 *     left island).
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

/** Seed localStorage settings, then reload so the app picks them up. */
async function withSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await applySettingsAndReload(page, settings);
  await waitForEntries(page);
}

async function navigateActivePaneToRepo(page: Page): Promise<void> {
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
}

/** Run a command via the palette — deterministic regardless of pane focus. */
async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  await palette.locator(".search-input").fill(label);
  const cmd = palette.locator(`.command-item:has-text("${label}")`).first();
  await expect(cmd).toBeVisible();
  await cmd.click();
  await expect(palette).toBeHidden();
}

test.describe("Island / panel layout (#434)", () => {
  test("SCM panel renders docked (flat), not a floating hover card, under island mode", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await withSettings(page, { layoutTheme: "floating-islands", showGitStatus: true, showScmPanel: true });

    // Island mode is on...
    await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");

    await navigateActivePaneToRepo(page);
    const panel = page.locator(".scm-panel").first();
    await expect(panel).toBeVisible();

    // ...yet the in-pane SCM panel stays flat: no rounded card corners and no
    // drop shadow (the hover-card chrome). The sidebar island, by contrast,
    // is rounded — proving the attribute is present and only the panel opts out.
    const panelRadius = await panel.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius));
    expect(panelRadius).toBe(0);
    const panelShadow = await panel.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(panelShadow).toBe("none");
  });

  test("toggling the SCM panel is per-pane, not global", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await withSettings(page, { showGitStatus: true, showScmPanel: true });

    await navigateActivePaneToRepo(page);
    await expect(page.locator(".scm-panel")).toHaveCount(1);

    // Split: both panes inherit the global default, so two panels show.
    await page.keyboard.press("Control+\\");
    await expect(page.locator(".scm-panel")).toHaveCount(2);

    // The split focuses the right pane. Toggling SCM acts on the ACTIVE pane
    // only — so the right pane's panel closes while the left keeps its own.
    await runPaletteCommand(page, "Toggle Source Control Panel");

    await expect(page.locator(".scm-panel")).toHaveCount(1);
    const left = page.locator(".explorer-pane").first();
    const right = page.locator(".explorer-pane").nth(1);
    await expect(left.locator(".scm-panel")).toHaveCount(1);
    await expect(right.locator(".scm-panel")).toHaveCount(0);
  });

  test("miller columns render exactly once in island mode with no sidebar", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await withSettings(page, { layoutTheme: "floating-islands", showSidebar: false, millerLayers: 1 });

    // Descend one level so ancestor columns exist.
    await page.locator(".entry-item").first().dblclick();

    // Exactly one miller strip — previously the inline copy AND the left island
    // both mounted (count 2) because the suppression keyed off macOsVibrancy
    // while the island hoist keyed off the broader island mode.
    await expect(page.locator(".miller-columns")).toHaveCount(1);
  });

  test("the terminal floats on its own island in island mode (#1651)", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await withSettings(page, { layoutTheme: "floating-islands" });
    await expect(page.locator("html")).toHaveAttribute("data-layout-base", "floating-islands");

    await page.keyboard.press("Alt+m"); await page.keyboard.press("t");
    const terminal = page.locator(".terminal-panel");
    await expect(terminal).toBeVisible();

    const geometry = await page.evaluate(() => {
      const term = document.querySelector<HTMLElement>(".terminal-panel")!;
      const panes = document.querySelector<HTMLElement>("[data-region='panes']")!;
      const style = getComputedStyle(term);
      return {
        radius: parseFloat(style.borderTopLeftRadius),
        shadow: style.boxShadow,
        term: term.getBoundingClientRect().toJSON(),
        panes: panes.getBoundingClientRect().toJSON(),
        viewport: document.documentElement.clientWidth,
      };
    });
    // Rounded and lifted like the other islands...
    expect(geometry.radius).toBeGreaterThan(0);
    expect(geometry.shadow).not.toBe("none");
    // ...inset from the window edges, with a visible gap under the panes
    // rather than butting against them.
    expect(geometry.term.left).toBeGreaterThan(0);
    expect(geometry.term.right).toBeLessThan(geometry.viewport);
    expect(geometry.term.top - geometry.panes.bottom).toBeGreaterThanOrEqual(4);

    await page.screenshot({
      path: "screenshots/fix/1651-terminal-should-match-theme-colours/terminal-island.png",
      animations: "disabled",
    });
  });
});


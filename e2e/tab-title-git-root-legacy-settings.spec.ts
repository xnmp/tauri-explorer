/**
 * E2E: the git-repo icon must appear in the tab title bar on an EXISTING
 * install, not just a fresh one (#506).
 *
 * #471 flipped `tabTitleGitRoot`'s default to `true`, but settings persist as
 * a whole object and load as `{ ...DEFAULT_SETTINGS, ...saved }`, so every
 * install that had ever saved settings kept the original `false` and never
 * saw the icon. `e2e/tab-title-git-root.spec.ts` could not catch that: it
 * boots with empty storage, i.e. always as a fresh install. These specs seed
 * the persisted blob explicitly — that is the seam the bug lives at.
 *
 * (Mock: /home/user/Documents/project is a git repo root.)
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

const REPO_SUBFOLDER_URL = "/?path=/home/user/Documents/project/src";

/** Write the persisted settings blob before first paint, so the app boots
 *  against it exactly as an upgraded install would. */
const seedSettings = (page: Page, blob: Record<string, unknown>) =>
  page.addInitScript((persisted) => {
    localStorage.setItem(
      "explorer-settings",
      JSON.stringify({
        // Hold the title bar row open with a single tab (#504) so the strip
        // renders; keep the macOS integrated bar out of it.
        showWindowControls: true,
        integratedTitleBar: false,
        ...persisted,
      }),
    );
  }, blob);

/** Capture the title bar region at 3x so the 16px glyph is legible. */
const shootTitleBar = (page: Page, path: string) =>
  page.screenshot({ path, clip: { x: 0, y: 0, width: 640, height: 56 } });

test.use({ deviceScaleFactor: 3 });

test.describe("Git repo tab icon on an upgraded install (#506)", () => {
  test("AC 1: shows the git icon despite a pre-#471 persisted tabTitleGitRoot:false", async ({
    page,
  }) => {
    // A real pre-#471 blob: the key is present and false, no version stamp.
    await seedSettings(page, { tabTitleGitRoot: false });
    await page.goto(REPO_SUBFOLDER_URL);
    await waitForEntries(page);

    // The repo root resolves async after first paint; the decoration follows.
    await expect(page.locator(".tab-icon-git")).toBeVisible();
    await expect(page.locator(".tab-repo")).toHaveText("project");
    await expect(page.locator(".tab-cwd")).toHaveText("src");

    await shootTitleBar(page, "evidence/ac-1-legacy-settings-git-icon.png");
  });

  test("AC 2: keeps the plain folder icon when a stamped blob says the user turned it off", async ({
    page,
  }) => {
    // settingsVersion 1 = the migration already ran here, so this `false` is
    // the user's own choice and must be honoured.
    await seedSettings(page, { tabTitleGitRoot: false, settingsVersion: 1 });
    await page.goto(REPO_SUBFOLDER_URL);
    await waitForEntries(page);

    await expect(page.locator(".tab-icon:not(.tab-icon-git)")).toBeVisible();
    await expect(page.locator(".tab-icon-git")).toHaveCount(0);
    await expect(page.locator(".tab-title")).toHaveText("src");

    await shootTitleBar(page, "evidence/ac-2-user-opt-out-plain-icon.png");
  });

  test("a legacy blob's other settings survive the migration", async ({ page }) => {
    await seedSettings(page, {
      tabTitleGitRoot: false,
      previewFontSize: 20,
      autoEnterSingleSubdir: true,
    });
    await page.goto(REPO_SUBFOLDER_URL);
    await waitForEntries(page);

    await expect(page.locator(".tab-icon-git")).toBeVisible();

    const kept = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      return { previewFontSize: s.previewFontSize, autoEnterSingleSubdir: s.autoEnterSingleSubdir };
    });
    expect(kept).toEqual({ previewFontSize: 20, autoEnterSingleSubdir: true });
  });
});

/**
 * E2E: AI-generated Details columns (#1884). Right-click a column header,
 * Add AI column…, describe the property; the mock backend's deterministic
 * stand-in model (`mock-ai.ts`, extension in capitals for "...extension..."
 * properties) fills the rendered rows. Asserts what the user sees: the new
 * header, each row's value, the values surviving a relaunch without asking the
 * model again, removal, and the settings fallback without a model.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS, type MockControl } from "../src/lib/api/mock-control";

const FOLDER = "/home/ai-columns";
const FILES: Record<string, string> = {
  "report.pdf": "PDF", "notes.txt": "TXT", "photo.JPG": "JPG", "README": "NONE", "Archive": "FOLDER",
};
const CELL = '[data-cell="ai-columns.file-extension-in-caps:value"]';
const LABEL = "File extension in caps";
const SHOTS = "screenshots/feat/ai-generated-column";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ folder, names }) => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    control.directoryEntries = (path) => path === folder ? names.map((name, i) => ({
      name, path: `${folder}/${name}`, kind: name === "Archive" ? "directory" as const : "file" as const,
      size: 1000 * (i + 1), modified: "2026-03-01T10:00:00Z",
    })) : [];
    control.invokeArgs = { write_config_file: [], ai_text_generate: [] };
  }, { folder: FOLDER, names: Object.keys(FILES) });
});

const headers = (page: Page) => page.locator(".column-headers:visible");
const row = (page: Page, name: string) => page.locator(`.entry-item[data-path="${FOLDER}/${name}"]:visible`);
const control = (page: Page) => page.evaluate(() => {
  const c = (window as unknown as { __mockControl: MockControl }).__mockControl;
  return { counts: c.invokeCounts ?? {}, writes: (c.invokeArgs?.write_config_file ?? []) as { filename: string; data: string }[] };
});

async function openFolder(page: Page) {
  await page.goto(`/?path=${FOLDER}`);
  await waitForEntries(page);
  await expect(row(page, "report.pdf")).toBeVisible();
}

async function openHeaderMenu(page: Page) {
  await headers(page).click({ button: "right", position: { x: 40, y: 10 } });
  const menu = page.locator(".column-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function expectFilled(page: Page) {
  for (const [name, value] of Object.entries(FILES)) await expect(row(page, name).locator(CELL)).toHaveText(value);
}

test("an AI column fills from a description, survives a relaunch and can be removed", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 640 });
  await openFolder(page);

  const menu = await openHeaderMenu(page);
  const add = menu.locator('[data-column-menu-item="ai-columns.add"]');
  await expect(add).toHaveText("Add AI column…");
  await page.screenshot({ path: `${SHOTS}/header-menu.png`, animations: "disabled" });
  await add.click();
  await expect(menu).toBeHidden();

  const dialog = page.locator(".ai-column-dialog");
  await expect(dialog).toBeVisible();
  const input = dialog.locator(".ai-column-description");
  await expect(input).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Add" })).toBeDisabled();
  await input.fill("file extension in caps");
  await page.screenshot({ path: `${SHOTS}/describe-dialog.png`, animations: "disabled" });
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();

  await expect(headers(page).getByText(LABEL, { exact: true })).toBeVisible();
  await expectFilled(page);
  // One request for the whole listing: rows rendered together share a batch.
  expect((await control(page)).counts.ai_text_generate).toBe(1);
  await page.screenshot({ path: `${SHOTS}/column-filled.png`, animations: "disabled" });

  // The definition and the answers reach plugin storage (values on a debounce).
  let saved = "";
  await expect.poll(async () => {
    const writes = (await control(page)).writes.filter((write) => write.filename === "plugin.ai-columns.json");
    saved = writes.at(-1)?.data ?? "";
    return saved.includes('"PDF"') && saved.includes(LABEL);
  }, { timeout: 8000 }).toBe(true);

  // Relaunch with that storage: the column and values return without a model call.
  await page.evaluate(({ key, data }) => localStorage.setItem(key, JSON.stringify({ "plugin.ai-columns.json": data })), { key: MOCK_LOCAL_KEYS.configSeed, data: saved });
  await page.reload();
  await waitForEntries(page);
  await expect(headers(page).getByText(LABEL, { exact: true })).toBeVisible();
  await expectFilled(page);
  expect((await control(page)).counts.ai_text_generate ?? 0).toBe(0);

  const after = await openHeaderMenu(page);
  await after.locator('[data-column-menu-item="ai-columns.remove-file-extension-in-caps"]').click();
  await expect(headers(page).getByText(LABEL, { exact: true })).toHaveCount(0);
  await expect(row(page, "report.pdf").locator(CELL)).toHaveCount(0);
  const reopened = await openHeaderMenu(page);
  await expect(reopened.locator('[data-column-menu-item^="ai-columns.remove-"]')).toHaveCount(0);
});

test("without a language model, Add AI column… opens the language model settings", async ({ page }) => {
  await page.addInitScript(() => {
    ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).aiTextUnavailable = true;
  });
  await openFolder(page);
  const menu = await openHeaderMenu(page);
  await menu.locator('[data-column-menu-item="ai-columns.add"]').click();
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await expect(page.locator(".settings-dialog .language-models")).toBeAttached();
  await expect(page.locator(".ai-column-dialog")).toHaveCount(0);
  expect((await control(page)).counts.ai_text_generate ?? 0).toBe(0);
});

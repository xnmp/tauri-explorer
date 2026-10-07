/**
 * Lightweight file-picker mode (?picker=...) — the UI half of the
 * xdg-desktop-portal FileChooser backend. Asserts on real outcomes: the
 * recorded picker_respond payload (mock writes it to localStorage), not
 * just rendering.
 */

import { test, expect, type Page } from "./fixtures";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

async function readResponse(page: Page): Promise<{ token: string; paths: string[]; cancelled: boolean }> {
  // The mock invoke resolves asynchronously — poll until recorded.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.pickerResponse), {
      timeout: 3000,
    })
    .not.toBeNull();
  const raw = await page.evaluate((key) => localStorage.getItem(key), MOCK_LOCAL_KEYS.pickerResponse);
  return JSON.parse(raw!);
}

test.describe("File picker mode", () => {
  test("Ctrl+P refreshes history written by another window and preserves it on pick", async ({ page }) => {
    await page.goto("/?picker=open&token=history-reader&folder=%2Fhome%2Fuser");
    await expect(page.locator('.picker')).toBeVisible();
    const writer = await page.context().newPage();
    await writer.goto("/?picker=open&token=history-writer&folder=%2Fhome%2Fuser");
    await writer.locator('.column[data-path="/home/user"] .entry', { hasText: 'notes.md' }).dblclick();
    await readResponse(writer);
    await writer.close();
    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await expect(overlay.locator('.pqo-result', { hasText: 'notes.md' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay).not.toBeVisible();
    await page.locator('.column[data-path="/home/user"] .entry', { hasText: 'readme.txt' }).dblclick();
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('explorer-recent-files')!));
    expect(history.map((entry: {path: string}) => entry.path)).toEqual(expect.arrayContaining(['/home/user/notes.md', '/home/user/readme.txt']));
  });
  test("Ctrl+F filters the active column and Escape clears it without cancelling", async ({ page }) => {
    await page.goto("/?picker=open&token=filter&folder=%2Fhome%2Fuser");
    const home = page.locator('.column[data-path="/home/user"]');
    await expect(home.locator('.entry', { hasText: "notes.md" })).toBeVisible();
    await page.keyboard.press("Control+f");
    const filter = page.getByRole("textbox", { name: "Filter current folder" });
    await expect(filter).toBeFocused();
    await filter.fill("NOTES");
    await expect(home.locator('.entry')).toHaveCount(1);
    await filter.press("Escape");
    await expect(filter).toHaveCount(0);
    await expect(home.locator('.entry', { hasText: "Documents" })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), MOCK_LOCAL_KEYS.pickerResponse)).toBeNull();
    await page.keyboard.press("Control+f");
    await filter.fill("notes");
    await filter.press("Enter");
    await page.keyboard.press("Enter");
    expect(await readResponse(page)).toMatchObject({ cancelled: false, paths: ["/home/user/notes.md"] });
  });

  test("Ctrl+P shows recent files and frequent folders without typing", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("explorer-recent-files", JSON.stringify([{ name: "notes.md", path: "/home/user/Documents/notes.md", kind: "file", timestamp: Date.now() }]));
      localStorage.setItem("explorer-frecency", JSON.stringify([{ path: "/home/user/Documents", accesses: [Date.now(), Date.now()] }]));
    });
    await page.goto("/?picker=open&token=history&folder=%2Fhome%2Fuser");
    await expect(page.locator('.picker')).toBeVisible();
    await page.keyboard.press("n");
    await expect(page.locator('.column[data-path="/home/user"] .entry', { hasText: 'notes.md' })).toBeFocused();
    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await expect(overlay.locator('.pqo-result', { hasText: 'notes.md' })).toBeVisible();
    await overlay.locator('.pqo-result').filter({ has: page.locator('.pqo-name', { hasText: /^Documents$/ }) }).click();
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.address-input')).toHaveValue('/home/user/Documents');
    await expect(page.locator('.column[data-path="/home/user/Documents"]')).toBeFocused();
    await page.keyboard.press('n');
    await expect(page.locator('.column[data-path="/home/user/Documents"] .entry', { hasText: 'notes.md' })).toBeFocused();
    await page.keyboard.press("Control+p");
    await overlay.locator('.pqo-result', { hasText: 'notes.md' }).click();
    expect(await readResponse(page)).toMatchObject({ cancelled: false, paths: ["/home/user/Documents/notes.md"] });
  });

  test("typing selects a folder and Enter navigates before picking a file", async ({ page }) => {
    await page.goto("/?picker=open&token=typing&folder=%2Fhome%2Fuser");
    await expect(page.locator('.column[data-path="/home/user"] .entry', { hasText: "Documents" })).toBeVisible();
    await page.keyboard.press("d");
    await page.keyboard.press("Enter");
    await expect(page.locator(".address-input")).toHaveValue("/home/user/Documents");
    await expect(page.locator('.column[data-path="/home/user/Documents"] .entry', { hasText: "notes.md" })).toBeVisible();
    await page.keyboard.press("n");
    await page.keyboard.press("Enter");
    expect(await readResponse(page)).toMatchObject({ token: "typing", cancelled: false, paths: ["/home/user/Documents/notes.md"] });
  });

  test("typing a longer prefix scrolls its matching file into view", async ({ page }) => {
    await page.goto("/?picker=open&token=prefix&folder=%2Fperf%2Fhuge-500");
    const column = page.locator('.column[data-path="/perf/huge-500"]');
    await expect(column.locator(".entry").first()).toBeVisible();
    const name = await column.locator(".entry").last().getAttribute("title");
    await page.keyboard.type(name!);
    const match = column.locator(".entry", { has: page.locator('.entry-label', { hasText: name! }) }).last();
    await expect(match).toBeFocused();
    await expect.poll(() => match.evaluate(el => {
      const row = el.getBoundingClientRect();
      const parent = el.closest('.column')!.getBoundingClientRect();
      return row.top >= parent.top && row.bottom <= parent.bottom;
    })).toBe(true);
    await page.keyboard.press("Enter");
    const response = await readResponse(page);
    expect(response.paths).toEqual([`/perf/huge-500/${name}`]);
  });

  test("extension filter hides unrelated files while folders remain navigable", async ({ page }) => {
    await page.goto("/?picker=open&token=filtered&folder=%2Fhome%2Fuser&extension=MD");
    const home = page.locator('.column[data-path="/home/user"]');
    await expect(home.locator(".entry", { hasText: "notes.md" })).toBeVisible();
    await expect(home.locator(".entry", { hasText: "readme.txt" })).toHaveCount(0);
    await home.locator(".entry", { hasText: "Documents" }).click();
    await page.locator('.column[data-path="/home/user/Documents"] .entry', { hasText: "notes.md" }).dblclick();
    expect(await readResponse(page)).toMatchObject({ token: "filtered", cancelled: false, paths: ["/home/user/Documents/notes.md"] });
  });
  test("reports a failed picker import in the portal window", async ({ page }) => {
    await page.route("**/FilePicker.svelte*", (route) => route.abort());
    await page.goto("/?picker=open&token=failed&folder=%2Fhome%2Fuser");
    await expect(page.locator(".toast", { hasText: "Could not load File Picker" })).toBeVisible();
    await expect(page.locator(".picker")).toHaveCount(0);
    await expect(page.locator(".tab-area")).toHaveCount(0);
  });

  test("renders columns instead of the full app and picks a file", async ({ page }) => {
    await page.goto("/?picker=open&token=t1&multiple=0&directory=0&folder=%2Fhome%2Fuser");

    // Lightweight UI only — no tab bar, no sidebar.
    await expect(page.locator(".picker")).toBeVisible();
    await expect(page.locator(".tab-area")).toHaveCount(0);
    await expect(page.locator(".sidebar")).toHaveCount(0);

    // Miller chain for /home/user: /, /home, /home/user columns.
    const columns = page.locator(".column");
    await expect(columns).toHaveCount(3);
    await expect(page.locator(".address-input")).toHaveValue("/home/user");

    // Select button disabled until a file is chosen.
    const select = page.locator(".btn-select");
    await expect(select).toBeDisabled();

    // Click a file in the deepest column, then confirm.
    await page.locator('.column[data-path="/home/user"] .entry', { hasText: "notes.md" }).click();
    await expect(select).toBeEnabled();
    await select.click();

    const response = await readResponse(page);
    expect(response).toMatchObject({
      token: "t1",
      cancelled: false,
      paths: ["/home/user/notes.md"],
    });
  });

  test("clicking a directory opens a new column; double-click on a file confirms", async ({ page }) => {
    await page.goto("/?picker=open&token=t2&multiple=0&directory=0&folder=%2Fhome%2Fuser");
    await expect(page.locator(".column")).toHaveCount(3);

    await page.locator('.column[data-path="/home/user"] .entry', { hasText: "Documents" }).click();
    await expect(page.locator(".column")).toHaveCount(4);
    await expect(page.locator(".address-input")).toHaveValue("/home/user/Documents");

    await page
      .locator('.column[data-path="/home/user/Documents"] .entry', { hasText: "notes.md" })
      .dblclick();

    const response = await readResponse(page);
    expect(response).toMatchObject({
      token: "t2",
      cancelled: false,
      paths: ["/home/user/Documents/notes.md"],
    });
  });

  test("directory mode lists only folders and selects the current directory", async ({ page }) => {
    await page.goto("/?picker=open&token=t3&multiple=0&directory=1&folder=%2Fhome%2Fuser");
    await expect(page.locator(".column")).toHaveCount(3);

    // Files are hidden in directory mode.
    await expect(
      page.locator('.column[data-path="/home/user"] .entry', { hasText: "notes.md" }),
    ).toHaveCount(0);

    await page.locator('.column[data-path="/home/user"] .entry', { hasText: "Documents" }).click();
    await page.locator(".btn-select").click();

    const response = await readResponse(page);
    expect(response).toMatchObject({
      token: "t3",
      cancelled: false,
      paths: ["/home/user/Documents"],
    });
  });

  test("save mode joins the typed name with the current directory", async ({ page }) => {
    await page.goto(
      "/?picker=save&token=t4&multiple=0&directory=0&folder=%2Fhome%2Fuser&name=download.bin",
    );
    await expect(page.locator(".column")).toHaveCount(3);

    const nameInput = page.locator(".name-input");
    await expect(nameInput).toHaveValue("download.bin");
    await nameInput.fill("renamed.bin");
    await page.locator(".btn-select").click();

    const response = await readResponse(page);
    expect(response).toMatchObject({
      token: "t4",
      cancelled: false,
      paths: ["/home/user/renamed.bin"],
    });
  });

  test("Escape cancels the request", async ({ page }) => {
    await page.goto("/?picker=open&token=t5&multiple=0&directory=0&folder=%2Fhome%2Fuser");
    await expect(page.locator(".picker")).toBeVisible();

    await page.keyboard.press("Escape");

    const response = await readResponse(page);
    expect(response).toMatchObject({ token: "t5", cancelled: true, paths: [] });
  });

  test("address bar navigation rebuilds the column chain", async ({ page }) => {
    await page.goto("/?picker=open&token=t6&multiple=0&directory=0&folder=%2Fhome%2Fuser");
    await expect(page.locator(".column")).toHaveCount(3);

    const address = page.locator(".address-input");
    await address.fill("/home/user/Documents/project");
    await address.press("Enter");

    await expect(page.locator(".column")).toHaveCount(5);
    await expect(
      page.locator('.column[data-path="/home/user/Documents/project"] .entry', {
        hasText: "README.md",
      }),
    ).toBeVisible();
  });

  test("preserves Windows drive and UNC roots through navigation and selection", async ({ page }) => {
    const driveFolder = "C:\\Users\\runneradmin\\picker-fixture";
    await page.goto(
      `/?picker=open&token=windows-paths&multiple=0&directory=1&folder=${encodeURIComponent(driveFolder)}`,
    );

    const columns = page.locator(".column");
    await expect(columns).toHaveCount(4);
    expect(await columns.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.path),
    )).toEqual([
      "C:\\",
      "C:\\Users",
      "C:\\Users\\runneradmin",
      driveFolder,
    ]);
    await page.locator(".btn-select").click();
    expect(await readResponse(page)).toMatchObject({
      token: "windows-paths",
      cancelled: false,
      paths: [driveFolder],
    });

    await page.evaluate((key) => localStorage.removeItem(key), MOCK_LOCAL_KEYS.pickerResponse);
    const uncFolder = "\\\\server\\share\\folder";
    const address = page.locator(".address-input");
    await address.fill(uncFolder);
    await address.press("Enter");

    await expect(columns).toHaveCount(2);
    expect(await columns.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.path),
    )).toEqual(["\\\\server\\share", uncFolder]);
    await page.locator(".btn-select").click();
    expect(await readResponse(page)).toMatchObject({
      token: "windows-paths",
      cancelled: false,
      paths: [uncFolder],
    });
  });
});

test.describe("Picker quick open (#190)", () => {
  test("package matches survive more unrelated hits than the search limit", async ({ page }) => {
    await page.goto("/?picker=open&token=package-search&folder=%2Fhome%2Fuser&extension=teplugin");
    await expect(page.locator(".picker")).toBeVisible();
    await page.evaluate(async () => {
      const load = new Function("return import('/src/lib/api/mock-fixtures.ts')");
      const { mockFiles } = await load();
      const file = (name: string, folder: string) => ({ name, path: `${folder}/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
      mockFiles["/home/user"].push(...Array.from({ length: 150 }, (_, i) => file(`plugin-${i}.txt`, "/home/user")));
      mockFiles["/home/user/Documents"].push(file("TraceExplorer.TEPLUGIN", "/home/user/Documents"));
    });
    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await overlay.locator("input").fill("plugin");
    await expect(overlay.locator(".pqo-result", { hasText: "TraceExplorer.TEPLUGIN" })).toBeVisible();
    await expect(overlay.locator(".pqo-result", { hasText: ".txt" })).toHaveCount(0);
    await overlay.locator(".pqo-result", { hasText: "TraceExplorer.TEPLUGIN" }).click();
    expect(await readResponse(page)).toMatchObject({ token: "package-search", cancelled: false, paths: ["/home/user/Documents/TraceExplorer.TEPLUGIN"] });
  });
  test("quick open respects the same extension filter before confirming a result", async ({ page }) => {
    await page.goto("/?picker=open&token=filtered-search&folder=%2Fhome%2Fuser&extension=md");
    await expect(page.locator(".picker")).toBeVisible();
    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await overlay.locator("input").fill("readme");
    await expect(overlay.locator(".pqo-result", { hasText: "README.md" }).first()).toBeVisible();
    await expect(overlay.locator(".pqo-result", { hasText: "readme.txt" })).toHaveCount(0);
    await overlay.locator("input").fill("notes");
    await overlay.locator(".pqo-result", { hasText: "notes.md" }).first().click();
    expect(await readResponse(page)).toMatchObject({ token: "filtered-search", cancelled: false });
    expect((await readResponse(page)).paths[0]).toMatch(/notes\.md$/);
  });
  test("Ctrl+P fuzzy-finds a file and picking it responds immediately", async ({ page }) => {
    await page.goto("/?picker=open&token=qo1&multiple=0&directory=0&folder=%2Fhome%2Fuser");
    await expect(page.locator(".picker")).toBeVisible();

    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await expect(overlay).toBeVisible();

    await page.locator("input:focus").fill("notes");
    const hit = overlay.locator(".pqo-result", { hasText: "notes.md" }).first();
    await expect(hit).toBeVisible();
    await page.keyboard.press("Enter");

    const response = await readResponse(page);
    expect(response.cancelled).toBe(false);
    expect(response.paths[0]).toMatch(/notes\.md$/);
  });

  test("quick open in save mode prefills the name instead of responding", async ({ page }) => {
    await page.goto(
      "/?picker=save&token=qo2&multiple=0&directory=0&folder=%2Fhome%2Fuser&name=untitled.txt",
    );
    await expect(page.locator(".picker")).toBeVisible();
    await page.keyboard.press("Control+p");
    const overlay = page.locator('[data-testid="picker-quick-open"]');
    await expect(overlay).toBeVisible();
    await overlay.locator("input").fill("notes");
    await overlay.locator(".pqo-result", { hasText: "notes.md" }).first().click();

    // No response yet — the picked name lands in the save-name input.
    await expect(overlay).not.toBeVisible();
    await expect(page.locator(".name-input")).toHaveValue("notes.md");
  });
});

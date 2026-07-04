/**
 * Lightweight file-picker mode (?picker=...) — the UI half of the
 * xdg-desktop-portal FileChooser backend. Asserts on real outcomes: the
 * recorded picker_respond payload (mock writes it to localStorage), not
 * just rendering.
 */

import { test, expect, type Page } from "@playwright/test";

async function readResponse(page: Page): Promise<{ token: string; paths: string[]; cancelled: boolean }> {
  // The mock invoke resolves asynchronously — poll until recorded.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-picker-response")), {
      timeout: 3000,
    })
    .not.toBeNull();
  const raw = await page.evaluate(() => localStorage.getItem("mock-picker-response"));
  return JSON.parse(raw!);
}

test.describe("File picker mode", () => {
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
});

test.describe("Picker quick open (#190)", () => {
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

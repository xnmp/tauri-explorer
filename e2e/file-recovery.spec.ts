import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries, VIEW_MODES } from "./helpers";

// Browser contract fixture only. Native recovery outcomes and renderer/channel
// lifetime need real Rust/binary coverage; this replaces only the API port.
async function recoveryFixture(page: Page, failInitial = false, holdResolve = false) {
  await page.route("**/src/lib/api/file-recovery.ts*", async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: `
      let revision = 1;
      let failures = ${failInitial ? 1 : 0};
      const entry = { id: 'recovery-a', generation: '1', originalPath: '/home/user/Documents/report.txt',
        retainedPath: null, status: 'pending', message: 'Inspect this interrupted replacement to review recovery options.', actions: [] };
      let item = entry;
      let restored = false;
      let listeners = new Set();
      const snapshot = () => ({ revision: String(revision), items: item ? [item] : [], error: null });
      const publish = () => { const value = snapshot(); for (const listener of listeners) listener(value); return value; };
      export const fileRecoveryPort = {
        async subscribe(receive) {
          if (failures-- > 0) throw new Error('Recovery storage is temporarily unavailable');
          listeners.add(receive); receive(snapshot()); return async () => { listeners.delete(receive); };
        },
        async list() { return snapshot(); },
        async inspect(id) {
          if (!item || id !== item.id) throw new Error('Item is no longer available');
          if (restored) { revision++; item = { ...item, generation: String(revision) }; return publish(); }
          revision++; item = { ...item, generation: String(revision), status: 'ready',
            retainedPath: '/home/user/Documents/.recovery/original', message: 'The original can be restored. The copied data will be retained.', actions: ['restore'] };
          return publish();
        },
        async resolve(id, generation, choice) {
          if (!item || id !== item.id || generation !== item.generation || choice !== 'restore') throw new Error('Recovery action is stale');
          if (${holdResolve}) {
            document.documentElement.dataset.recoveryResolve = 'waiting';
            await new Promise((resolve) => window.addEventListener('fixture:finish-recovery', resolve, { once: true }));
          }
          restored = true;
          revision++; item = { ...item, generation: String(revision), status: 'attention',
            message: 'The original has been restored; retained artifacts still require cleanup', actions: [] };
          const result = publish();
          document.documentElement.dataset.recoveryResolve = 'done';
          return result;
        },
      };
    ` });
  });
}

async function openThroughPalette(page: Page) {
  await page.keyboard.press("Control+Shift+p");
  const input = page.locator("input:focus");
  await input.fill("File Recovery");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "File recovery", exact: true })).toBeVisible();
}

for (const width of [320, 768, 1024, 1440]) {
  test(`recovery inspection and restore preserve outcome and keyboard focus at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 900 });
    await recoveryFixture(page);
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.getByTestId("file-recovery-notice").click();
    const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
    await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(dialog.getByText("/home/user/Documents/.recovery/original", { exact: true })).toBeVisible();
    const restore = dialog.getByRole("button", { name: "Restore", exact: true });
    await restore.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("The original has been restored; retained artifacts still require cleanup", { exact: true })).toBeVisible();
    await expect(restore).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Inspect", exact: true })).toBeFocused();
    const card = dialog.locator(".recovery-dialog");
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    if (width === 320) await page.screenshot({ path: `screenshots/refactor/repo-health-cleanup/recovery-restored-320-${browserName}.png` });
    if (width === 1024) await page.screenshot({ path: `screenshots/refactor/repo-health-cleanup/recovery-restored-${browserName}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("file-recovery-notice")).toBeFocused();
  });
}

test("recovery remains visible and reachable with the status bar hidden", async ({ page }) => {
  await recoveryFixture(page);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const path = "/src/lib/state/settings.svelte.ts";
    const { settingsStore } = await import(/* @vite-ignore */ path);
    if (settingsStore.showStatusBar) settingsStore.toggleStatusBar();
  });
  await expect(page.locator(".status-bar")).toHaveCount(0);
  await expect(page.getByTestId("file-recovery-notice")).toBeVisible();
  await openThroughPalette(page);
  const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
});

test("retry reconnects after failed discovery and exposes recoverable results", async ({ page }) => {
  await recoveryFixture(page, true);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.getByTestId("file-recovery-notice").click();
  const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
  await expect(dialog.getByText("Recovery storage is temporarily unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No file recovery actions are pending.")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  await expect(dialog.getByText("Recovery storage is temporarily unavailable", { exact: true })).toHaveCount(0);
});

test("an unavailable initial directory still exposes recovery without reporting successful startup", async ({ page }) => {
  const startupReports: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("[perf] Startup(webview)")) startupReports.push(message.text());
  });
  await recoveryFixture(page);
  await page.goto("/?path=/unavailable-volume/recovery");
  await expect(page.getByText("Path not found: /unavailable-volume/recovery", { exact: false })).toBeVisible();
  await page.getByTestId("file-recovery-notice").click();
  const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  expect(startupReports).toEqual([]);
});

test("a delayed recovery module leaves file navigation functional", async ({ page }) => {
  let release!: () => void;
  let requested!: () => void;
  const requestedModule = new Promise<void>((resolve) => { requested = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/src/lib/state/file-recovery.svelte.ts*", async (route) => {
    requested();
    await held;
    await route.continue();
  });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  try {
    await requestedModule;
    await page.locator('.entry-item[data-path="/home/user/Documents"]').dblclick();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]')).toBeVisible();
  } finally { release(); }
});

test("a failed recovery dialog import releases modal ownership and keeps search usable", async ({ page }) => {
  await page.route("**/FileRecoveryDialog.svelte*", (route) => route.abort());
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("File Recovery");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast", { hasText: "Could not load File Recovery" })).toBeVisible();
  await page.keyboard.press("Control+p");
  const search = page.locator(".quick-open-dialog");
  await search.locator("input").fill("Documents");
  await expect(search).toContainText("Documents");
});


for (const mode of VIEW_MODES) {
  test(`recovery notice opens actionable inspection from ${mode} view`, async ({ page }) => {
    await recoveryFixture(page);
    await page.goto(`${HOME_URL}&viewMode=${mode}`);
    await waitForEntries(page);
    await page.getByTestId("file-recovery-notice").click();
    const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
    await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  });
}

test("a delayed action keeps focus safe and cannot steal it from a reopened dialog", async ({ page }) => {
  await recoveryFixture(page, false, true);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.getByTestId("file-recovery-notice").click();
  const dialog = page.getByRole("dialog", { name: "File recovery", exact: true });
  await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-recovery-resolve", "waiting");
  await expect(dialog.getByRole("button", { name: "Close file recovery" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByTestId("file-recovery-notice").click();
  await expect(dialog.getByRole("button", { name: "Close file recovery" })).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture:finish-recovery")));
  await expect(page.locator("html")).toHaveAttribute("data-recovery-resolve", "done");
  await expect(dialog.getByText("The original has been restored; retained artifacts still require cleanup", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close file recovery" })).toBeFocused();
});

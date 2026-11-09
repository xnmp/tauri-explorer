/**
 * Installed plugin packages in the Plugins menu (#1529): the rows use the
 * shared Settings switch and buttons, and enabling, disabling and removing a
 * package still reach the backend and update the list.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const SHOTS = "screenshots/fix/make-plugin-menu-look-nicer";

function manifest(id: string, name: string, description: string, version: string) {
  // A Svelte ABI the browser host rejects, so enabling fails fast with a
  // deterministic activation error instead of fetching a package bundle.
  return { id, name, description, version, sdkVersion: 3, svelteVersion: "0.0.0-e2e", frontend: "index.js", styles: "index.css", contributions: [`${id}.main`] };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((packages) => {
    const control = ((globalThis as { __mockControl?: MockControl }).__mockControl ??= {});
    control.installedPlugins = packages;
  }, [
    { digest: "a1", enabled: false, manifest: manifest("trace-explorer", "Trace Explorer", "Inspect trace files as an interactive timeline.", "1.4.2") },
    { digest: "b2", enabled: false, manifest: manifest("markdown-tools", "Markdown Tools", "Table of contents and link checking for Markdown previews.", "0.9.0") },
  ]);
});

async function openPlugins(page: import("@playwright/test").Page) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.keyboard.press("Control+,");
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Plugins", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".package-row")).toHaveCount(2);
  return dialog;
}

const installed = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (globalThis as { __mockControl?: MockControl }).__mockControl?.installedPlugins?.map(entry => ({ id: entry.manifest.id, enabled: entry.enabled })));

test("installed packages use the shared Settings controls", async ({ page }) => {
  const dialog = await openPlugins(page);
  const row = dialog.locator(".package-row", { hasText: "Trace Explorer" });
  await expect(row.locator(".setting-label")).toHaveText("Trace Explorer");
  await expect(row.locator(".setting-description")).toHaveText("Inspect trace files as an interactive timeline.");
  await expect(row.locator(".package-version")).toHaveText("Version 1.4.2");
  // The enable control is the shared switch, not a bare browser checkbox.
  const toggle = row.getByLabel("Enable Trace Explorer");
  await expect(row.locator("label.toggle .toggle-slider")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  const remove = row.getByRole("button", { name: "Remove Trace Explorer" });
  await expect(remove).toHaveClass(/\bsettings-button\b.*\bdanger\b/);
  await expect(dialog.getByRole("button", { name: "Install plugin…", exact: true })).toHaveClass(/\bsettings-button\b/);
  // Theme chrome, not browser defaults: the button reads the control fill and
  // the remove label the critical colour.
  const chrome = await remove.evaluate((el) => {
    const style = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--system-critical-text, var(--system-critical))";
    probe.style.backgroundColor = "var(--control-fill)";
    el.parentElement!.append(probe);
    const expected = getComputedStyle(probe);
    const result = { color: style.color, background: style.backgroundColor, critical: expected.color, fill: expected.backgroundColor, radius: style.borderTopLeftRadius };
    probe.remove();
    return result;
  });
  expect(chrome.color).toBe(chrome.critical);
  expect(chrome.background).toBe(chrome.fill);
  expect(chrome.radius).not.toBe("0px");
  await dialog.locator(".plugins-dialog").screenshot({ path: `${SHOTS}/after-plugins-menu.png`, animations: "disabled" });
});

test("enable, disable and remove still reach the backend", async ({ page }) => {
  const dialog = await openPlugins(page);
  const row = dialog.locator(".package-row", { hasText: "Trace Explorer" });
  const toggle = row.getByLabel("Enable Trace Explorer");

  await row.locator("label.toggle").click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => installed(page)).toEqual([{ id: "trace-explorer", enabled: true }, { id: "markdown-tools", enabled: false }]);
  // An activation failure stays on the package's own row.
  await expect(row.getByRole("alert")).toContainText("Trace Explorer requires a different plugin host");

  await row.locator("label.toggle").click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => installed(page)).toEqual([{ id: "trace-explorer", enabled: false }, { id: "markdown-tools", enabled: false }]);

  await row.getByRole("button", { name: "Remove Trace Explorer" }).click();
  await expect(dialog.locator(".package-row")).toHaveCount(1);
  await expect(dialog.locator(".package-row .setting-label")).toHaveText("Markdown Tools");
  await expect.poll(() => installed(page)).toEqual([{ id: "markdown-tools", enabled: false }]);

  await dialog.getByRole("button", { name: "Remove Markdown Tools" }).click();
  await expect(dialog.locator(".package-row")).toHaveCount(0);
  await expect(dialog.getByText("No plugin packages installed.")).toBeVisible();
});

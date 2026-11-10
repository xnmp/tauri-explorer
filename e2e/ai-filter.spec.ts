/**
 * AI filter (#1506): Alt+Enter in the Ctrl+F box asks the configured language
 * model which entries match a natural-language request. The mock backend
 * stands in for the model (`aiTextReply`); these specs assert the UI contract
 * — hint gating, the applied listing in every view, cancellation and restore —
 * not model quality.
 */
import { test, expect } from "./fixtures";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const FOLDER = "/home/ai-filter";
const NAMES = ["Invoice-0142.pdf", "Invoice-0143.pdf", "Invoice-0098.pdf", "Quarterly report.docx", "holiday.jpg", "Receipts"];
const RECENT = ["Invoice-0142.pdf", "Invoice-0143.pdf"];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ folder, names, recent }) => {
    const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
    const day = 24 * 60 * 60 * 1000;
    control.directoryEntries = (path) => path === folder ? names.map((name, i) => ({
      name, path: `${folder}/${name}`, kind: name.includes(".") ? "file" as const : "directory" as const,
      size: 4096 * (i + 1), modified: new Date(Date.now() - (name === "Invoice-0098.pdf" ? 40 : i) * day).toISOString(),
    })) : [];
    control.aiTextReply = () => JSON.stringify({ names: [...recent, "invented.pdf"] });
    control.invokeArgs = { ai_text_generate: [] };
  }, { folder: FOLDER, names: NAMES, recent: RECENT });
});

const rows = (page: import("@playwright/test").Page) => page.locator(".entry-item:visible .entry-name");

async function shownNames(page: import("@playwright/test").Page): Promise<string[]> {
  return (await rows(page).allTextContents()).map((name) => name.trim()).sort();
}

for (const viewMode of VIEW_MODES) {
  test.describe(`AI filter [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/?path=${FOLDER}`);
      await waitForEntries(page);
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      await expect(rows(page)).toHaveCount(NAMES.length);
    });

    test("Alt+Enter shows only the model's matches and Escape restores the folder", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      const input = page.locator(".filter-input");
      await expect(input).toBeFocused();
      // The reminder appears for a focused box when a language model is configured.
      await expect(page.locator(".filter-ai-status.hint")).toHaveText("Alt+Enter AI filter");
      await page.screenshot({ path: `screenshots/feat/ai-filter/hint-${viewMode}.png`, animations: "disabled" });

      await input.fill("invoices from last 3 days");
      await input.press("Alt+Enter");

      const bar = page.locator(".filter-bar");
      await expect(bar).toHaveAttribute("data-ai-filter", "applied");
      await expect.poll(() => shownNames(page)).toEqual([...RECENT].sort());
      // The invented name was discarded, so the chip counts real matches only.
      await expect(page.locator(".ai-chip .ai-count")).toHaveText("2");
      await expect(page.locator(".filter-ai-status")).toHaveText("2 items match · Esc to clear");
      await expect(page.locator(".entry-item:visible").first()).toHaveClass(/selected/);
      await page.screenshot({ path: `screenshots/feat/ai-filter/applied-${viewMode}.png`, animations: "disabled" });

      // The model received the request and a compact listing of this folder.
      const sent = await page.evaluate(() => (window as unknown as { __mockControl: MockControl }).__mockControl.invokeArgs!.ai_text_generate!);
      expect(sent).toHaveLength(1);
      expect(String(sent[0]!.input)).toContain("Request: invoices from last 3 days");
      for (const name of NAMES) expect(String(sent[0]!.input)).toContain(`\t${name}\t`);

      await input.press("Escape");
      await expect(bar).toBeHidden();
      await expect(rows(page)).toHaveCount(NAMES.length);
    });

    test("editing the query returns to the ordinary substring filter", async ({ page }) => {
      await pressShortcut(page, "f", { ctrlKey: true });
      const input = page.locator(".filter-input");
      await input.fill("invoices from last 3 days");
      await input.press("Alt+Enter");
      await expect(page.locator(".filter-bar")).toHaveAttribute("data-ai-filter", "applied");
      await input.fill("holiday");
      await expect(page.locator(".filter-bar")).toHaveAttribute("data-ai-filter", "idle");
      await expect.poll(() => shownNames(page)).toEqual(["holiday.jpg"]);
    });
  });
}

test.describe("AI filter lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?path=${FOLDER}`);
    await waitForEntries(page);
  });

  test("a pending request shows the whole folder and Escape cancels it", async ({ page }) => {
    await page.evaluate(() => {
      const control = ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {});
      control.latency = { ...control.latency, ai_text_generate: 1500 };
    });
    await pressShortcut(page, "f", { ctrlKey: true });
    const input = page.locator(".filter-input");
    await input.fill("invoices from last 3 days");
    await input.press("Alt+Enter");
    await expect(page.locator(".filter-bar")).toHaveAttribute("data-ai-filter", "loading");
    await expect(page.locator(".ai-spinner")).toBeVisible();
    await expect(page.locator(".filter-ai-status")).toHaveText("AI filtering… Esc to cancel");
    await expect(rows(page)).toHaveCount(NAMES.length);
    await page.screenshot({ path: "screenshots/feat/ai-filter/loading.png", animations: "disabled" });

    await input.press("Escape");
    await expect(page.locator(".filter-bar")).toBeHidden();
    // The late reply must not filter the restored folder.
    await page.waitForTimeout(1800);
    await expect(rows(page)).toHaveCount(NAMES.length);
  });

  // #1522: Alt+Enter must never look like it did nothing.
  test("an empty request and a model that matches nothing both say so in a toast", async ({ page }) => {
    await pressShortcut(page, "f", { ctrlKey: true });
    const input = page.locator(".filter-input");
    await expect(input).toBeFocused();
    await page.keyboard.press("Alt+Enter");
    await expect(page.locator(".toast.info")).toContainText("Type what you are looking for");

    await page.evaluate(() => {
      (window as unknown as { __mockControl: MockControl }).__mockControl.aiTextReply = () => JSON.stringify({ names: [] });
    });
    await page.keyboard.type("replays");
    await page.keyboard.press("Alt+Enter");
    await expect(page.locator(".filter-bar")).toHaveAttribute("data-ai-filter", "applied");
    await expect(page.locator(".toast.info")).toHaveText('AI filter: no items match "replays"');
    await expect(rows(page)).toHaveCount(0);
    await page.screenshot({ path: "screenshots/fix/ai-filter-not-working/no-match-toast.png", animations: "disabled" });
  });

  test("without a configured language model there is no hint and nothing is sent", async ({ page }) => {
    await page.evaluate(() => {
      ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).aiTextUnavailable = true;
    });
    await pressShortcut(page, "f", { ctrlKey: true });
    const input = page.locator(".filter-input");
    await expect(input).toBeFocused();
    await input.fill("invoice");
    await expect(page.locator(".filter-ai-status.hint")).toBeHidden();
    await input.press("Alt+Enter");
    await expect(page.locator(".filter-bar")).toHaveAttribute("data-ai-filter", "error");
    await expect(page.locator(".filter-ai-status")).toContainText("Settings → AI");
    // #1522: the window-level toast is the feedback channel that cannot be missed.
    await expect(page.locator(".toast.error")).toContainText("AI filter needs a language model");
    const sent =await page.evaluate(() => (window as unknown as { __mockControl: MockControl }).__mockControl.invokeArgs!.ai_text_generate!);
    expect(sent).toHaveLength(0);
    // The box keeps working as an ordinary filter.
    await expect.poll(() => shownNames(page)).toEqual(["Invoice-0098.pdf", "Invoice-0142.pdf", "Invoice-0143.pdf"]);
    await page.screenshot({ path: "screenshots/feat/ai-filter/unavailable.png", animations: "disabled" });
  });
});

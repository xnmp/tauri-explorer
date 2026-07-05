/**
 * Theme switching against the built binary (#193) — the repro path for #164
 * ("setting theme via command palette requires two attempts" on Windows).
 * Asserts the FIRST palette invocation flips <html data-theme>, and that a
 * second toggle flips it back.
 */
import { browser, $ } from "@wdio/globals";

async function currentTheme(): Promise<string> {
  return await browser.execute(
    () => document.documentElement.getAttribute("data-theme") ?? "",
  );
}

async function runPaletteCommand(query: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(query);
  await browser.keys(["Enter"]);
}

describe("theme switching via the command palette", () => {
  it("first palette toggle flips the theme (regression: #164 needed two attempts)", async () => {
    await $(".file-list").waitForExist({ timeout: 15_000 });
    const before = await currentTheme();

    await runPaletteCommand("Toggle Dark/Light Theme");

    // The FIRST attempt must already flip it — #164 was exactly this failing.
    await browser.waitUntil(async () => (await currentTheme()) !== before, {
      timeout: 5000,
      timeoutMsg: `theme never changed from "${before}" on the first palette attempt (#164)`,
    });
  });

  it("second toggle flips it back", async () => {
    const before = await currentTheme();
    await runPaletteCommand("Toggle Dark/Light Theme");
    await browser.waitUntil(async () => (await currentTheme()) !== before, {
      timeout: 5000,
      timeoutMsg: "theme did not flip back on the second toggle",
    });
  });
});

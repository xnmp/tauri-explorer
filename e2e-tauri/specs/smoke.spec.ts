import { browser, $, expect } from "@wdio/globals";

describe("tauri-explorer smoke", () => {
  it("loads the window chrome", async () => {
    await expect($(".titlebar")).toBeDisplayed();
  });

  it("opens the command palette via Ctrl+Shift+P", async () => {
    // keybinding-parser treats Ctrl as "ctrl || meta" (see
    // src/lib/domain/keybinding-parser.ts matchesShortcut), so Control works
    // on all platforms — no need to branch on process.platform here.
    await browser.keys(["Control", "Shift", "p"]);
    await expect($(".command-palette-dialog")).toBeDisplayed();
  });
});

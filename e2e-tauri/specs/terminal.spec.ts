import { browser, $, expect } from "@wdio/globals";
import { domText } from "./helpers";

/**
 * Embedded terminal against the real binary (issue #139): a genuine PTY
 * running the user's shell. Verifies output streaming (the shell prompt /
 * command echo arrives), input round-trips (typed command executes), and
 * that the shell starts in the explorer's directory.
 *
 * xterm.js renders into a canvas/DOM hybrid; the reliable text source is
 * the accessibility tree it maintains (.xterm-accessibility) — but that is
 * enabled on demand. Instead we read the buffer through the terminal's
 * live DOM rows (.xterm-rows), which WebKitWebDriver exposes via
 * textContent (rendered-text clipping doesn't apply, see helpers.ts).
 */

async function terminalText(): Promise<string> {
  return domText(".terminal-panel .xterm-rows");
}

describe("embedded terminal", () => {
  it("opens with Ctrl+` and shows a live shell", async () => {
    await $(".file-list").waitForExist({ timeout: 15_000 });
    await browser.keys(["Control", "`"]);
    await $(".terminal-panel .xterm").waitForDisplayed({ timeout: 10_000 });

    // A prompt (any output at all) must arrive from the PTY.
    await browser.waitUntil(async () => (await terminalText()).trim().length > 0, {
      timeout: 15_000,
      timeoutMsg: "no shell output ever arrived in the terminal",
    });
  });

  it("round-trips input: a typed command executes and its output appears", async () => {
    // Focus is already in the terminal after opening; type via the helper
    // textarea xterm maintains.
    const input = $(".terminal-panel textarea.xterm-helper-textarea");
    await input.waitForExist();

    const marker = `e2e-terminal-${Date.now()}`;
    await input.addValue(`echo ${marker}\n`);

    await browser.waitUntil(
      async () => {
        const text = await terminalText();
        // The marker must appear at least twice: command echo + output —
        // proving execution, not just local echo.
        return text.split(marker).length >= 3;
      },
      { timeout: 15_000, timeoutMsg: "echoed command output never appeared" },
    );
  });

  it("shell starts in the explorer's current directory", async () => {
    const input = $(".terminal-panel textarea.xterm-helper-textarea");
    await input.addValue("pwd\n");

    // The app is launched with cwd = the test workspace (see wdio config);
    // pwd output must contain the explorer's path shown in the status bar.
    const statusPath = (await $(".status-path").getAttribute("title")) ?? "";
    expect(statusPath.length).toBeGreaterThan(0);
    await browser.waitUntil(
      async () => (await terminalText()).includes(statusPath),
      {
        timeout: 15_000,
        timeoutMsg: `pwd output never showed ${statusPath}`,
      },
    );
  });

  it("Ctrl+` from inside the terminal hides the panel and keeps the session", async () => {
    await browser.keys(["Control", "`"]);
    await browser.waitUntil(
      async () => !(await $(".terminal-panel").isDisplayed()),
      { timeout: 5_000, timeoutMsg: "panel never hid" },
    );
    // Still mounted — the shell session survives the toggle.
    await expect($(".terminal-panel")).toExist();

    // Reopen: previous scrollback is still there (same session, no respawn).
    await browser.keys(["Control", "`"]);
    await $(".terminal-panel .xterm").waitForDisplayed({ timeout: 5_000 });
    const text = await terminalText();
    expect(text).toContain("pwd");
  });
});

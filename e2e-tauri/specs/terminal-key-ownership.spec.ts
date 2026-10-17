import { browser, $, expect } from "@wdio/globals";
import { domText } from "./helpers";

async function terminalText(): Promise<string> {
  return domText(".terminal-panel .xterm-rows");
}

async function focusTerminalInput(input: ReturnType<typeof $>): Promise<void> {
  await browser.execute((element: HTMLElement) => element.focus(), input);
  await browser.waitUntil(() => input.isFocused(), {
    timeout: 2_000,
    timeoutMsg: "xterm input never received focus",
  });
}

// A minimal raw-mode terminal application reports the numeric byte it
// receives, proving Ctrl+Q reached terminal (PTY/ConPTY) input rather than an
// Explorer shortcut handler. Unix uses Python's termios/tty raw mode; Windows
// has no such modules, but ConPTY delivers the same control byte (17) to a
// console reader, so PowerShell's Console.ReadKey(true) (bypassing normal
// line processing) is the Windows-correct equivalent (#800).
const keyProbe = process.platform === "win32"
  ? "powershell -NoProfile -Command \""
    + "Write-Output 'key-probe-ready'; "
    + "$k=[System.Console]::ReadKey($true); "
    + "Write-Output ('terminal-key-byte=' + [int]$k.KeyChar)\""
  : 'python3 -c "import os,sys,termios,tty;fd=sys.stdin.fileno();old=termios.tcgetattr(fd);tty.setraw(fd);print(\'key-\'+\'probe-ready\',flush=True);key=os.read(fd,1);termios.tcsetattr(fd,termios.TCSADRAIN,old);print(\'terminal-key-byte=\'+str(key[0]),flush=True)"';

(process.platform === "linux" || process.platform === "win32" ? describe : describe.skip)("terminal key ownership (#496)", () => {
  it("delivers Ctrl+Q to a terminal-hosted application instead of Explorer", async () => {
    // The native WebView keeps its tab layout between test runs. Start from
    // one tab so the two tab-navigation captures have an unambiguous state.
    const refreshToken = crypto.randomUUID();
    await browser.execute((token: string) => {
      document.documentElement.dataset.e2eRefreshToken = token;
      localStorage.clear();
      // These earlier-registered commands conflict with terminal exceptions.
      // The window must retain the exact identity that xterm relinquished.
      localStorage.setItem("explorer-keybindings", JSON.stringify({
        "navigation.goUp": "Ctrl+P",
        "view.focusFilesSidebar": "Alt+M T",
      }));
    }, refreshToken);
    await browser.refresh();
    // WebKit can acknowledge refresh while the old document is still visible.
    // Require the replacement document's keyboard/hooks and listing readiness.
    await browser.waitUntil(() => browser.execute((token: string) =>
      document.documentElement.dataset.e2eRefreshToken !== token
        && document.documentElement.dataset.e2eHooksReady === "true"
        && document.querySelector(".file-list") !== null,
    refreshToken), { timeout: 15_000, timeoutMsg: "refreshed explorer never became ready" });
    await browser.keys(["Control", "`"]);
    await $(".terminal-panel .xterm").waitForDisplayed({ timeout: 10_000 });
    const input = await $(".terminal-panel textarea.xterm-helper-textarea");
    await input.waitForExist();
    await browser.waitUntil(async () => (await terminalText()).trim().length > 0, {
      timeout: 45_000,
      timeoutMsg: "shell never became ready for the terminal key probe",
    });

    // ASCII 17 (Ctrl+Q) proves the byte reached terminal input rather than an
    // Explorer shortcut handler. Readiness is assembled inside the probe
    // program so echoed command text cannot satisfy the wait before it
    // switches into raw/intercepted key reading.
    await input.addValue(`${keyProbe}\n`);
    await browser.waitUntil(async () => (await terminalText()).includes("key-probe-ready"), {
      timeout: 15_000,
      timeoutMsg: "terminal key probe never entered raw mode",
    });

    await focusTerminalInput(input);
    // Match the chord path used by the app's other shortcut tests.
    await browser.keys(["Control", "q"]);
    try {
      await browser.waitUntil(async () => (await terminalText()).includes("terminal-key-byte=17"), {
        timeout: 15_000,
        timeoutMsg: "terminal-hosted key probe never received Ctrl+Q",
      });
    } catch (error) {
      console.error("[terminal-key-diagnostics]", JSON.stringify(await browser.execute(() => ({
        terminalText: document.querySelector(".terminal-panel .xterm-rows")?.textContent,
        activeElement: document.activeElement
          ? { tag: document.activeElement.tagName, classes: document.activeElement.className }
          : null,
        terminalDisplayed: !!document.querySelector(".terminal-panel"),
        modalText: document.querySelector("[role=dialog]")?.textContent ?? null,
      }))));
      await browser.saveScreenshot("e2e-tauri/logs/terminal-key-ownership-failure.png").catch(() => {});
      throw error;
    }
    await expect($(".terminal-panel")).toBeDisplayed();
    await browser.saveScreenshot("evidence/ac-1-terminal-owns-ctrl-q.png");
    const originalPath = await $(".status-path").getAttribute("title");

    // Quick Open is still an explicit terminal-focus exception. The raw-mode
    // probe result remains visible behind the modal, proving this comes from
    // the healthy real PTY session above rather than browser/mock mode.
    await focusTerminalInput(input);
    await browser.keys(["Control", "p"]);
    await $(".quick-open-dialog input.search-input").waitForDisplayed({ timeout: 10_000 });
    await expect($(".status-path")).toHaveAttribute("title", originalPath!);
    await browser.saveScreenshot("evidence/ac-2-quick-open-from-terminal.png");
    await browser.keys("Escape");
    await $(".quick-open-dialog").waitForDisplayed({ reverse: true });

    await focusTerminalInput(input);
    await browser.keys(["Control", "Shift", "p"]);
    const paletteSearch = $(".command-palette-dialog input.search-input");
    await paletteSearch.waitForDisplayed({ timeout: 10_000 });
    await browser.saveScreenshot("evidence/ac-3-command-palette-from-terminal.png");

    // Create a second real explorer tab from the command palette. The terminal
    // remains live while we switch away and back, so the next captures can
    // show both tab navigation and the same healthy PTY session.
    await paletteSearch.addValue("New Tab");
    const newTabCommand = $(
      "//li[contains(@class, 'command-item')][.//span[contains(@class, 'command-label') and normalize-space()='New Tab']]",
    );
    await newTabCommand.waitForDisplayed({ timeout: 10_000 });
    await newTabCommand.click();
    await browser.waitUntil(async () => (await (await $$(".tab")).length) === 2, {
      timeout: 10_000,
      timeoutMsg: "New Tab command did not create a second tab",
    });
    const newTabId = await $(".tab.active").getAttribute("data-tab-id");
    expect(newTabId).not.toBeNull();

    await focusTerminalInput(input);
    await browser.action("key").down("\uE009").down("\uE00E").up("\uE00E").up("\uE009").perform();
    await browser.waitUntil(
      async () => (await $(".tab.active").getAttribute("data-tab-id")) !== newTabId,
      { timeout: 10_000, timeoutMsg: "Ctrl+PageUp did not select the previous tab" },
    );
    await browser.saveScreenshot("evidence/ac-4-previous-tab-from-terminal.png");

    await focusTerminalInput(input);
    await browser.action("key").down("\uE009").down("\uE00F").up("\uE00F").up("\uE009").perform();
    await browser.waitUntil(
      async () => (await $(".tab.active").getAttribute("data-tab-id")) === newTabId,
      { timeout: 10_000, timeoutMsg: "Ctrl+PageDown did not select the next tab" },
    );
    await browser.saveScreenshot("evidence/ac-5-next-tab-from-terminal.png");

    // Both prefix and suffix collide, but only the terminal command may run.
    await expect($(".sidebar")).toBeDisplayed();
    await focusTerminalInput(input);
    await browser.keys(["Alt", "m"]);
    await browser.keys("t");
    await $(".terminal-panel").waitForDisplayed({ reverse: true, timeout: 5_000 });
    await expect($(".sidebar")).toBeDisplayed();
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-keyboard-command-ownership.png");
  });
});

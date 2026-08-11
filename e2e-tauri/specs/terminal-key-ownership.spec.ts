import { browser, $, expect } from "@wdio/globals";
import { domText } from "./helpers";

async function terminalText(): Promise<string> {
  return domText(".terminal-panel .xterm-rows");
}

(process.platform !== "win32" ? describe : describe.skip)("terminal key ownership (#496)", () => {
  it("delivers Ctrl+Q to a terminal-hosted application instead of Explorer", async () => {
    // The native WebView keeps its tab layout between test runs. Start from
    // one tab so the two tab-navigation captures have an unambiguous state.
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await $(".file-list").waitForExist({ timeout: 15_000 });
    await browser.keys(["Control", "`"]);
    await $(".terminal-panel .xterm").waitForDisplayed({ timeout: 10_000 });
    const input = $(".terminal-panel textarea.xterm-helper-textarea");
    await input.waitForExist();
    await browser.waitUntil(async () => (await terminalText()).trim().length > 0, {
      timeout: 45_000,
      timeoutMsg: "shell never became ready for the terminal key probe",
    });

    // A minimal raw-mode terminal application reports the numeric byte it
    // receives. ASCII 17 proves Ctrl+Q reached terminal input rather than an
    // Explorer shortcut handler.
    const keyProbe =
      'python3 -c "import os,sys,termios,tty;fd=sys.stdin.fileno();old=termios.tcgetattr(fd);tty.setraw(fd);print(\'key-probe-ready\',flush=True);key=os.read(fd,1);termios.tcsetattr(fd,termios.TCSADRAIN,old);print(\'terminal-key-byte=\'+str(key[0]),flush=True)"';
    await input.addValue(`${keyProbe}\n`);
    await browser.waitUntil(async () => (await terminalText()).includes("key-probe-ready"), {
      timeout: 15_000,
      timeoutMsg: "terminal key probe never entered raw mode",
    });

    await input.click();
    // Use WebDriver's chord helper here. webkit2gtk-driver intermittently drops
    // a printable key from a manually batched down/up action sequence.
    await browser.keys(["Control", "q"]);
    await browser.waitUntil(async () => (await terminalText()).includes("terminal-key-byte=17"), {
      timeout: 15_000,
      timeoutMsg: "terminal-hosted key probe never received Ctrl+Q",
    });
    await expect($(".terminal-panel")).toBeDisplayed();
    await browser.saveScreenshot("evidence/ac-1-terminal-owns-ctrl-q.png");

    // Quick Open is still an explicit terminal-focus exception. The raw-mode
    // probe result remains visible behind the modal, proving this comes from
    // the healthy real PTY session above rather than browser/mock mode.
    await input.click();
    await browser.keys(["Control", "p"]);
    await $(".quick-open-dialog input.search-input").waitForDisplayed({ timeout: 10_000 });
    await browser.saveScreenshot("evidence/ac-2-quick-open-from-terminal.png");
    await browser.keys("Escape");

    await input.click();
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
    await browser.waitUntil(async () => (await $$(".tab")).length === 2, {
      timeout: 10_000,
      timeoutMsg: "New Tab command did not create a second tab",
    });
    const newTabId = await $(".tab.active").getAttribute("data-tab-id");
    expect(newTabId).not.toBeNull();

    await input.click();
    await browser.action("key").down("\uE009").down("\uE00E").up("\uE00E").up("\uE009").perform();
    await browser.waitUntil(
      async () => (await $(".tab.active").getAttribute("data-tab-id")) !== newTabId,
      { timeout: 10_000, timeoutMsg: "Ctrl+PageUp did not select the previous tab" },
    );
    await browser.saveScreenshot("evidence/ac-4-previous-tab-from-terminal.png");

    await input.click();
    await browser.action("key").down("\uE009").down("\uE00F").up("\uE00F").up("\uE009").perform();
    await browser.waitUntil(
      async () => (await $(".tab.active").getAttribute("data-tab-id")) === newTabId,
      { timeout: 10_000, timeoutMsg: "Ctrl+PageDown did not select the next tab" },
    );
    await browser.saveScreenshot("evidence/ac-5-next-tab-from-terminal.png");
  });
});

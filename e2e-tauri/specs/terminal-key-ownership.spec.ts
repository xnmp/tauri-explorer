import { browser, $, expect } from "@wdio/globals";
import { domText } from "./helpers";

async function terminalText(): Promise<string> {
  return domText(".terminal-panel .xterm-rows");
}

(process.platform !== "win32" ? describe : describe.skip)("terminal key ownership (#496)", () => {
  it("delivers Ctrl+Q to a terminal-hosted application instead of Explorer", async () => {
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
    await browser.keys(["Control", "q"]);
    await browser.waitUntil(async () => (await terminalText()).includes("terminal-key-byte=17"), {
      timeout: 15_000,
      timeoutMsg: "terminal-hosted key probe never received Ctrl+Q",
    });
    await expect($(".terminal-panel")).toBeDisplayed();
    await browser.saveScreenshot("evidence/ac-1-terminal-owns-ctrl-q.png");
  });
});

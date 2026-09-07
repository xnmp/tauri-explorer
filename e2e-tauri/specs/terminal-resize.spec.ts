import { browser, $, expect } from "@wdio/globals";
import { domText } from "./helpers";

/** Real WebKitGTK, PTY output/scrollback, and pointer capture under root zoom. */
(process.platform === "linux" ? describe : describe.skip)("native terminal resizing", () => {
  it("keeps a zoomed drag continuous with scrollback and the shell usable after keyboard resize", async () => {
    await browser.setWindowSize(1280, 900);
    await $(".file-list").waitForExist();
    await $(".file-list").click();
    for (let i = 0; i < 5; i++) await browser.keys(["Control", "="]);
    await browser.waitUntil(async () => await browser.execute(() => parseFloat(document.documentElement.style.getPropertyValue("--app-zoom"))) === 1.5,
      { timeoutMsg: "root zoom did not reach 150%" });
    await browser.keys(["Control", "`"]);
    await $(".terminal-panel .xterm").waitForDisplayed();
    await browser.waitUntil(async () => (await domText(".terminal-panel .xterm-rows")).trim().length > 0,
      { timeout: 45000, timeoutMsg: "shell never produced a prompt" });
    const input = await $(".terminal-panel textarea.xterm-helper-textarea");
    async function command(value: string) {
      await browser.execute((el: HTMLElement) => el.focus(), input);
      for (const character of value) await browser.keys(character);
      await browser.keys("Enter");
    }
    await command("seq 1 80");
    await browser.waitUntil(async () => await browser.execute(() =>
      [...document.querySelectorAll(".terminal-panel .xterm-rows > div")].some(row => row.textContent?.trim() === "79")),
      { timeoutMsg: "real PTY scrollback did not arrive" });
    const visibleRows = () => browser.execute(() =>
      [...document.querySelectorAll(".terminal-panel .xterm-rows > div")]
        .map(row => row.textContent?.trim() ?? "").filter(Boolean));
    await browser.execute((el: HTMLElement) => el.focus(), input);
    await browser.keys(["Shift", "PageUp"]);
    await browser.waitUntil(async () => {
      const rows = await visibleRows();
      return !rows.includes("79") && rows.some(row => /^\d+$/.test(row));
    }, { timeoutMsg: "terminal did not expose earlier PTY output through user scrollback" });
    const handle = await $('[aria-label="Resize terminal"]');
    const before = Number(await handle.getAttribute("aria-valuenow"));
    const height = () => browser.execute(() => document.querySelector(".terminal-panel")!.getBoundingClientRect().height);
    const beforeHeight = await height();
    const rect = await browser.execute(() => {
      const r = document.querySelector('[aria-label="Resize terminal"]')!.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    type PointerAction = { type: "pointerMove"; duration: number; origin: "viewport"; x: number; y: number }
      | { type: "pointerDown" | "pointerUp"; button: number };
    const pointer = (actions: PointerAction[]) => browser.performActions([{ type: "pointer", id: "resize-mouse",
      parameters: { pointerType: "mouse" }, actions }]);
    await pointer([{ type: "pointerMove", duration: 0, origin: "viewport", ...rect }, { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 150, origin: "viewport", x: rect.x, y: rect.y - 30 }]);
    await browser.waitUntil(async () => Number(await handle.getAttribute("aria-valuenow")) === before + 20,
      { timeoutMsg: "first native resize step was not 30 visual pixels" });
    await pointer([{ type: "pointerMove", duration: 150, origin: "viewport", x: rect.x, y: rect.y - 60 },
      { type: "pointerUp", button: 0 }]);
    await browser.releaseActions();
    await browser.waitUntil(async () => Number(await handle.getAttribute("aria-valuenow")) === before + 40,
      { timeoutMsg: "native drag stopped after the terminal reflowed its scrollback" });
    await browser.waitUntil(async () => Math.abs(await height() - beforeHeight - 60) < 1,
      { timeoutMsg: "model resize did not produce 60 visual pixels of native panel growth" });
    await browser.execute((el: HTMLElement) => el.focus(), handle);
    await browser.keys("ArrowUp");
    await browser.waitUntil(async () => Number(await handle.getAttribute("aria-valuenow")) === before + 50,
      { timeoutMsg: "native separator keyboard input did not resize" });
    await browser.waitUntil(async () => Math.abs(await height() - beforeHeight - 75) < 1,
      { timeoutMsg: "keyboard resize did not update native panel geometry" });
    const marker = `resizeproof${Date.now()}`;
    await command(`echo ${marker}`);
    await browser.waitUntil(async () => (await domText(".terminal-panel .xterm-rows")).split(marker).length >= 3,
      { timeoutMsg: "shell input did not execute after resizing" });
    await expect($(".file-list")).toBeDisplayed();
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-terminal-resize.png");
  });
});

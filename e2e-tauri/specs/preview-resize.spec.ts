import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domText, navigateTo } from "./helpers";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "explorer-preview-resize-")));
const fileName = "native-preview-proof.md";
const marker = "Native preview remains readable after every resize transition.";

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label.startsWith("Dock Preview Pane ")
    ? `preview ${label.split(" ").at(-1)!.toLowerCase()}` : label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label),
    { timeoutMsg: `command palette never matched ${label}` });
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

type PointerAction =
  | { type: "pointerMove"; duration: number; origin: "viewport"; x: number; y: number }
  | { type: "pointerDown" | "pointerUp"; button: number };

const pointer = (actions: PointerAction[]) => browser.performActions([{
  type: "pointer",
  id: "preview-resize-mouse",
  parameters: { pointerType: "mouse" },
  actions,
}]);

const paneRect = () => browser.execute(() => {
  const rect = document.querySelector(".preview-pane")!.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
});

async function expectContent(): Promise<void> {
  await $(".preview-markdown").waitForDisplayed();
  await browser.waitUntil(async () => (await domText(".preview-markdown")).includes(marker), {
    timeoutMsg: "real markdown content stopped being readable in the preview",
  });
}

(process.platform === "linux" ? describe : describe.skip)("native preview resizing", () => {
  before(() => {
    fs.writeFileSync(path.join(scratch, fileName), [
      "# Native preview resize proof",
      "",
      "- real filesystem content",
      "- markdown rendered by the native backend",
      "",
      marker,
    ].join("\n"));
  });
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("keeps real markdown usable through zoomed pointer, dock, fullscreen, and keyboard resizing", async () => {
    await browser.setWindowSize(1280, 900);
    await navigateTo(scratch);
    await $( `.entry-item[data-path$="/${fileName}"]` ).click();
    await browser.keys(" ");
    await expectContent();

    for (let i = 0; i < 5; i++) await browser.keys(["Control", "="]);
    await browser.waitUntil(async () => await browser.execute(() =>
      parseFloat(document.documentElement.style.getPropertyValue("--app-zoom"))) === 1.5,
    { timeoutMsg: "root zoom did not reach 150% from a fresh profile" });

    const rightHandle = await $('[aria-label="Resize preview"]');
    await rightHandle.waitForDisplayed();
    await expect(rightHandle).toHaveAttribute("aria-orientation", "vertical");
    await expect(rightHandle).toHaveAttribute("aria-valuenow", "280");
    const rightBefore = await paneRect();
    const rightPoint = await browser.execute((handle: HTMLElement) => {
      const rect = handle.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }, rightHandle);
    await pointer([
      { type: "pointerMove", duration: 0, origin: "viewport", ...rightPoint },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 150, origin: "viewport", x: rightPoint.x - 30, y: rightPoint.y },
    ]);
    await browser.waitUntil(async () => Number(await rightHandle.getAttribute("aria-valuenow")) === 300,
      { timeoutMsg: "first preview resize step did not scale 30 visual pixels to 20 model pixels" });
    await browser.waitUntil(async () => {
      const rect = await paneRect();
      return Math.abs(rect.width - rightBefore.width - 30) < 1 && Math.abs(rect.height - rightBefore.height) < 1;
    },
      { timeoutMsg: "first preview resize step did not move 30 visual pixels" });
    await pointer([
      { type: "pointerMove", duration: 150, origin: "viewport", x: rightPoint.x - 60, y: rightPoint.y },
      { type: "pointerUp", button: 0 },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => Number(await rightHandle.getAttribute("aria-valuenow")) === 320,
      { timeoutMsg: "continuous preview drag stopped after its first reflow" });
    await browser.waitUntil(async () => {
      const rect = await paneRect();
      return Math.abs(rect.width - rightBefore.width - 60) < 1 && Math.abs(rect.height - rightBefore.height) < 1;
    },
      { timeoutMsg: "preview did not grow by 60 visual pixels" });
    await expectContent();

    await command("Dock Preview Pane Bottom");
    let bottomHandle = await $('[aria-label="Resize preview"]');
    await bottomHandle.waitForDisplayed();
    await expect(bottomHandle).toHaveAttribute("aria-orientation", "horizontal");
    await expect(bottomHandle).toHaveAttribute("aria-valuenow", "240");
    const bottomBefore = await paneRect();
    await browser.waitUntil(async () => Math.abs((await paneRect()).height - 360) < 1,
      { timeoutMsg: "bottom dock did not resolve the zero height sentinel to 240 model / 360 visual pixels" });
    await expectContent();

    const bottomPoint = await browser.execute((handle: HTMLElement) => {
      const rect = handle.getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    }, bottomHandle);
    await pointer([
      { type: "pointerMove", duration: 0, origin: "viewport", ...bottomPoint },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 150, origin: "viewport", x: bottomPoint.x, y: bottomPoint.y - 30 },
    ]);
    await browser.waitUntil(async () => Number(await bottomHandle.getAttribute("aria-valuenow")) === 260,
      { timeoutMsg: "bottom preview draft did not publish before dock interruption" });
    await command("Dock Preview Pane Right");
    const restoredRight = await $('[aria-label="Resize preview"]');
    await expect(restoredRight).toHaveAttribute("aria-orientation", "vertical");
    await expect(restoredRight).toHaveAttribute("aria-valuenow", "320");
    await pointer([
      { type: "pointerMove", duration: 100, origin: "viewport", x: bottomPoint.x, y: bottomPoint.y - 60 },
      { type: "pointerUp", button: 0 },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(async () => Math.abs((await paneRect()).width - 480) < 1,
      { timeoutMsg: "late bottom-drag input changed the restored right-dock width" });
    await command("Dock Preview Pane Bottom");
    bottomHandle = await $('[aria-label="Resize preview"]');
    await expect(bottomHandle).toHaveAttribute("aria-valuenow", "240");
    await browser.waitUntil(async () => Math.abs((await paneRect()).height - bottomBefore.height) < 1,
      { timeoutMsg: "interrupted bottom draft contaminated the retained height" });
    await expectContent();

    await $(".preview-header").doubleClick();
    await browser.waitUntil(async () => await $(".preview-pane").getAttribute("class").then(value => value.includes("fullscreen")),
      { timeoutMsg: "preview did not enter fullscreen" });
    await $('[aria-label="Resize preview"]').waitForExist({ reverse: true });
    const fullscreen = await paneRect();
    const root = await browser.execute(() => ({
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight,
    }));
    for (const edge of ["x", "y", "width", "height", "right", "bottom"] as const) {
      expect(Math.abs(fullscreen[edge] - root[edge])).toBeLessThan(1);
    }
    await expectContent();
    await browser.keys("Escape");
    await bottomHandle.waitForDisplayed();
    await browser.waitUntil(async () => Math.abs((await paneRect()).height - bottomBefore.height) < 1,
      { timeoutMsg: "bottom dock geometry was not restored after fullscreen" });

    await browser.execute((handle: HTMLElement) => handle.focus(), bottomHandle);
    const widthBeforeKey = (await paneRect()).width;
    await browser.keys("ArrowUp");
    await browser.waitUntil(async () => Number(await bottomHandle.getAttribute("aria-valuenow")) === 250,
      { timeoutMsg: "bottom separator keyboard input did not resize the preview" });
    await browser.waitUntil(async () => {
      const rect = await paneRect();
      return Math.abs(rect.height - bottomBefore.height - 15) < 1 && Math.abs(rect.width - widthBeforeKey) < 1;
    }, { timeoutMsg: "keyboard resize did not change only the dock axis by 15 visual pixels" });
    await expectContent();
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-preview-resize.png");
    await browser.keys("Home");
    await browser.waitUntil(async () => Number(await bottomHandle.getAttribute("aria-valuenow")) === 120,
      { timeoutMsg: "preview keyboard minimum was not 120 pixels" });
    await browser.keys("End");
    await browser.waitUntil(async () => Number(await bottomHandle.getAttribute("aria-valuenow")) === 600,
      { timeoutMsg: "preview keyboard maximum was not 600 pixels" });
    await expectContent();
  });
});

/** Real WebKitGTK layout and keyboard input with optional panels and native files. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-panel-layout-"));
const directory = path.join(scratch, "current");
async function command(label: string) {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog input");
  await input.waitForDisplayed(); await input.setValue(label);
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

describe("native inline panel layout", () => {
  before(() => { fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "panel-proof.txt"), "real file"); });
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("keeps real files reachable beside inline panels and reserves separator keys", async () => {
    await browser.setWindowSize(800, 600);
    await navigateTo(directory);
    await command("Split Pane Right");
    await navigateTo(directory);
    await command("Miller Columns: 1 Layer");
    if (!await $(".explorer-pane.active .scm-panel").isExisting()) await command("Toggle Source Control Panel");
    await $(".explorer-pane.active .miller-columns").waitForDisplayed();
    await browser.waitUntil(async () => await browser.execute(() =>
      (document.querySelector(".explorer-pane.active .file-list")?.clientWidth ?? 0) >= 238),
    { timeoutMsg: "inline panels consumed native file-list width" });
    const file = $('.explorer-pane.active .file-list .entry-item[data-path$="panel-proof.txt"]');
    await file.waitForDisplayed();
    try {
      await expect(file.$(".entry-name")).toHaveText("panel-proof.txt");
    } catch (error) {
      try {
        console.error("[panel-layout geometry]", JSON.stringify(await browser.execute(() => {
          const viewport = document.querySelector(".pane-container") as HTMLElement | null;
          const pane = document.querySelector(".explorer-pane.active") as HTMLElement | null;
          const list = pane?.querySelector(".file-list") as HTMLElement | null;
          const name = pane?.querySelector('.entry-item[data-path$="panel-proof.txt"] .entry-name') as HTMLElement | null;
          const rect = (element: { getBoundingClientRect(): DOMRect } | null) => element ? (() => {
            const value = element.getBoundingClientRect();
            return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
          })() : null;
          const range = name ? document.createRange() : null;
          if (range && name) range.selectNodeContents(name);
          return {
            viewport: { rect: rect(viewport), clientWidth: viewport?.clientWidth, scrollWidth: viewport?.scrollWidth, scrollLeft: viewport?.scrollLeft },
            pane: rect(pane), list: rect(list), name: rect(name), text: name?.textContent,
            textRect: range ? rect(range) : null,
            style: name ? { display: getComputedStyle(name).display, visibility: getComputedStyle(name).visibility, overflow: getComputedStyle(name).overflow } : null,
            window: { width: innerWidth, height: innerHeight },
          };
        })));
      } catch (diagnosticError) {
        console.error("[panel-layout geometry] diagnostic collection failed", diagnosticError);
      }
      throw error;
    }
    await file.click(); await expect(file).toHaveElementClass("selected");
    const separator = $('.explorer-pane.active [aria-label="Resize source control panel"]');
    await separator.scrollIntoView();
    await browser.execute(() => {
      (document.querySelector('.explorer-pane.active [aria-label="Resize source control panel"]') as HTMLElement).focus();
    });
    const initial = Number(await separator.getAttribute("aria-valuenow"));
    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => Number(await separator.getAttribute("aria-valuenow")) === initial + 10,
      { timeoutMsg: "native separator key did not resize SCM" });
    await expect(file).toHaveElementClass("selected");
    await command("Toggle Source Control Panel");
    await $(".explorer-pane.active .scm-panel").waitForExist({ reverse: true });
    await file.click(); await expect(file).toHaveElementClass("selected");
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-inline-panels.png");
  });
});

/** Real WebKitGTK file-list focus, selection, and keyboard ownership. */
import { browser, $, $$, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domText, entryNames, navigateTo } from "./helpers";

let scratch = "";
let root = "";
const folderNames = ["alpha-folder", "middle-folder", "omega-folder"];
const fileNames = ["alpha-file.txt", "middle-file.txt", "omega-file.txt"];
const viewModes = ["details", "list", "tiles"] as const;

function entrySelector(name: string): string {
  return `.explorer-pane .file-list .entry-item[data-path$="/${name}"]`;
}

async function assertSinglePane(): Promise<void> {
  expect(await $$(".explorer-pane")).toHaveLength(1);
}

async function runPaletteCommand(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed({ timeout: 5000 });
  await input.setValue(label);
  await browser.waitUntil(
    async () => (await domText(".command-palette-dialog .command-item.selected")).includes(label),
    { timeoutMsg: `command palette never matched ${label}` },
  );
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

async function useView(viewMode: (typeof viewModes)[number]): Promise<void> {
  await assertSinglePane();
  const label = `${viewMode[0].toUpperCase()}${viewMode.slice(1)} View`;
  await runPaletteCommand(label);
  await $(`.${viewMode}-view`).waitForDisplayed({ timeout: 5000 });
}

async function activeEntryPath(): Promise<string | null> {
  return await browser.execute(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.matches(".file-list .entry-item") ? active.dataset.path ?? null : null;
  });
}

async function visibleTabStopCount(): Promise<number> {
  return await browser.execute(() => {
    const all = [...document.querySelectorAll<HTMLElement>("*")];
    return all.filter((element) => {
      if (element.tabIndex < 0 || element.closest("[inert]")) return false;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden"
        && element.getClientRects().length > 0
        && !(element as HTMLButtonElement).disabled;
    }).length;
  });
}

async function activeFocusIdentity(): Promise<number> {
  return await browser.execute(() => {
    const active = document.activeElement;
    return active ? [...document.querySelectorAll("*")].indexOf(active) : -1;
  });
}

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

linuxDescribe("native file-list composite focus", () => {
  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-file-list-focus-"));
    root = path.join(scratch, "root");
    fs.mkdirSync(root, { recursive: true });
    for (const name of folderNames) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, `marker-${name}.txt`), name);
    }
    for (const name of fileNames) fs.writeFileSync(path.join(root, name), name);
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("returns Tab focus to the same cursor and opens its real folder in every view", async () => {
    const middlePath = path.join(root, folderNames[1]);
    for (const viewMode of viewModes) {
      await navigateTo(root);
      await useView(viewMode);
      const middle = $(entrySelector(folderNames[1]));
      await middle.waitForDisplayed();
      await middle.click();
      await expect(middle).toHaveElementClass("selected");
      await browser.waitUntil(async () => (await activeEntryPath()) === middlePath, {
        timeoutMsg: `${viewMode} click did not focus the middle folder`,
      });

      const cycleLimit = Math.min((await visibleTabStopCount()) + 2, 256);
      await browser.keys("Tab");
      expect(await activeEntryPath()).not.toBe(middlePath);
      const firstOutside = await activeFocusIdentity();
      for (let step = 1; step < cycleLimit && (await activeEntryPath()) !== middlePath; step += 1) {
        await browser.keys("Tab");
        if ((await activeFocusIdentity()) === firstOutside) break;
      }
      await browser.waitUntil(async () => (await activeEntryPath()) === middlePath, {
        timeoutMsg: `${viewMode} did not restore the middle-folder cursor within one Tab cycle`,
      });
      await expect(middle).toHaveElementClass("selected");

      await browser.keys("Enter");
      await browser.waitUntil(
        async () => (await $(".status-path").getAttribute("title")) === middlePath,
        { timeoutMsg: `${viewMode} Enter did not open the focused real folder` },
      );
      const marker = `marker-${folderNames[1]}.txt`;
      await browser.waitUntil(async () => (await entryNames()).includes(marker), {
        timeoutMsg: `${viewMode} did not list the real child marker`,
      });
      expect(fs.existsSync(path.join(middlePath, marker))).toBe(true);
    }
  });

  it("extends Shift+Arrow selection to three entries with focus on the endpoint", async () => {
    for (const viewMode of viewModes) {
      await navigateTo(root);
      await useView(viewMode);
      const first = $(entrySelector(folderNames[0]));
      await first.waitForDisplayed();
      await first.click();
      const arrow = viewMode === "details" ? "ArrowDown" : "ArrowRight";

      await browser.keys(["Shift", arrow]);
      await browser.keys(["Shift", arrow]);

      const endpoint = path.join(root, folderNames[2]);
      await browser.waitUntil(async () =>
        (await $$(".explorer-pane .file-list .entry-item.selected").length) === 3
        && (await activeEntryPath()) === endpoint,
      { timeoutMsg: `${viewMode} did not extend to three entries and focus the endpoint` });
      for (const name of folderNames) {
        await expect($(entrySelector(name))).toHaveElementClass("selected");
      }
    }
  });

  it("moves F2 focus into the selected row's rename editor in every view", async () => {
    for (const viewMode of viewModes) {
      await navigateTo(root);
      await useView(viewMode);
      const middleFile = $(entrySelector(fileNames[1]));
      await middleFile.waitForDisplayed();
      await middleFile.click();

      await browser.keys("F2");
      const input = $(`${entrySelector(fileNames[1])} .rename-input`);
      await input.waitForDisplayed({ timeout: 5000 });
      await browser.waitUntil(async () => await browser.execute(() =>
        document.activeElement?.classList.contains("rename-input") === true,
      ), { timeoutMsg: `${viewMode} rename editor did not receive focus` });
      expect(await input.getValue()).toBe(fileNames[1]);

      await browser.keys("Escape");
      await input.waitForExist({ reverse: true });
      const middlePath = path.join(root, fileNames[1]);
      await browser.waitUntil(async () => (await activeEntryPath()) === middlePath, {
        timeoutMsg: `${viewMode} Escape did not return focus to the renamed row`,
      });
      expect(fs.existsSync(path.join(root, fileNames[1]))).toBe(true);
    }
  });
});

/** Real native creation, seed consumption, ACK routing and source retirement. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";
import { captureDiagnostics } from "../window-transfer-diagnostics";
import {
  waitForListingEntry,
  waitForWindowOperation,
  selectWindowByLabel,
  type ListingWaitRequest,
  type RendererWaitResult,
  type WindowOperationResponse,
  type WindowOperationWaitRequest,
} from "../window-transfer-waits";

const scratch = createNativeFixtureDirectory("explorer-window-transfer-");
const sourceDirectory = path.join(scratch, "source");
const destinationDirectory = path.join(scratch, "destination");
const largeLayoutDirectories = Array.from({ length: 8 }, (_, index) =>
  path.join(scratch, `large-pane-${index}`));

async function operation(op: string, target?: string): Promise<unknown> {
  try {
    const token = crypto.randomUUID();
    const observed = await browser.executeAsync<
      RendererWaitResult<WindowOperationResponse>,
      [WindowOperationWaitRequest]
    >(waitForWindowOperation, {
      token,
      op,
      target,
      timeoutMs: 25_000,
    });
    if (!observed.ok) throw new Error(observed.reason);
    expect(observed.value.error).toBeUndefined();
    return observed.value.result;
  } catch (error) {
    await captureDiagnostics(`operation-${op}`);
    throw error;
  }
}

async function switchToLabel(label: string): Promise<void> {
  try {
    await selectWindowByLabel({
      listHandles: () => browser.getWindowHandles(),
      switchTo: (handle) => browser.switchToWindow(handle),
      currentLabel: () => browser.execute(() => document.documentElement.dataset.e2eWindowLabel),
      pause: (ms) => browser.pause(ms),
      now: () => Date.now(),
    }, label, 20_000);
  } catch (error) {
    await captureDiagnostics(`switch-${label}`);
    throw error;
  }
}

async function listingHas(name: string) {
  try {
    const observed = await browser.executeAsync<
      RendererWaitResult<true>,
      [ListingWaitRequest]
    >(waitForListingEntry, {
      name,
      timeoutMs: 20_000,
    });
    if (!observed.ok) throw new Error(observed.reason);
  } catch (error) {
    await captureDiagnostics(`listing-${name}`);
    throw error;
  }
}

async function tabCount() {
  return await browser.execute(() => document.querySelectorAll(".tab-list > .tab").length);
}


async function expectTransferMoved(
  moved: { moved: boolean },
  reason: string,
): Promise<void> {
  try {
    expect(moved.moved).toBe(true);
  } catch (error) {
    await captureDiagnostics(reason);
    throw error;
  }
}

describe("native window transfer ownership", function () {
  // Every later case consumes windows established by earlier cases. Mocha's
  // suite bail prevents a timed-out asynchronous case from racing a dependent
  // case through WebdriverIO's shared browser session.
  this.bail(true);
  let mainHandle: string;
  let mainLabel: string;
  let childLabels: string[] = [];
  let largeLayoutLabel: string;
  before(() => {
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    for (const [index, directory] of largeLayoutDirectories.entries()) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, `pane-${index}.txt`), `pane ${index}`);
    }
    fs.writeFileSync(path.join(sourceDirectory, "source.txt"), "source");
    fs.writeFileSync(path.join(destinationDirectory, "destination.txt"), "destination");
  });
  after(async () => {
    if (mainHandle) {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === mainHandle) continue;
        await browser.switchToWindow(handle);
        await browser.closeWindow();
      }
      await browser.switchToWindow(mainHandle);
    }
  });

  it("concurrent same-path children each become functional and keep independent navigation", async () => {
    await navigateTo(sourceDirectory);
    mainHandle = await browser.getWindowHandle();
    mainLabel = await browser.execute(() => document.documentElement.dataset.e2eWindowLabel!);
    childLabels = await operation("open-pair") as string[];
    expect(childLabels).toHaveLength(2);
    expect(new Set(childLabels).size).toBe(2);
    for (const label of childLabels) {
      expect(typeof label).toBe("string");
      await switchToLabel(label);
      await listingHas("source.txt");
    }
    await switchToLabel(childLabels[0]);
    await navigateTo(destinationDirectory);
    await listingHas("destination.txt");
    await switchToLabel(childLabels[1]);
    await listingHas("source.txt");
    await browser.switchToWindow(mainHandle);
    await listingHas("source.txt");
  });

  it("a last-tab transfer closes its source only after the other window adopts it", async () => {
    await switchToLabel(childLabels[1]);
    const unrelatedBefore = await tabCount();
    await listingHas("source.txt");
    await browser.switchToWindow(mainHandle);
    const before = await tabCount();
    await switchToLabel(childLabels[0]);
    const sourceHandle = await browser.getWindowHandle();
    // The source closes on success; its completion DOM may disappear first.
    await browser.execute((target) => {
      window.dispatchEvent(new CustomEvent("e2e-window-operation", {
        detail: { token: "last-tab-transfer", op: "transfer", target },
      }));
    }, mainLabel);
    try {
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(sourceHandle),
        { timeout: 25_000, timeoutMsg: "acknowledged last-tab source stayed open" });
    } catch (error) {
      await captureDiagnostics("last-tab-source-stayed-open");
      throw error;
    }
    await browser.switchToWindow(mainHandle);
    await listingHas("destination.txt");
    expect(await tabCount()).toBe(before + 1);
    fs.writeFileSync(path.join(destinationDirectory, "after-transfer.txt"), "native watcher");
    await listingHas("after-transfer.txt");
    await browser.saveScreenshot("e2e-tauri/logs/ac-2-last-tab-adopted-watcher.png");
    await switchToLabel(childLabels[1]);
    expect(await tabCount()).toBe(unrelatedBefore);
    await listingHas("source.txt");
  });

  it("tear-off adoption preserves a split tab while leaving the original window usable", async () => {
    await browser.switchToWindow(mainHandle);
    await navigateTo(sourceDirectory);
    await browser.keys(["Control", "t"]);
    await $(".explorer-pane .file-list").waitForExist();
    await browser.keys(["Control", "m"]);
    await browser.waitUntil(async () => await browser.execute(() => document.querySelectorAll(".explorer-pane").length) >= 2);
    await navigateTo(destinationDirectory);
    const before = await tabCount();
    const moved = await operation("tear-off") as { moved: boolean; target: string };
    await expectTransferMoved(moved, "split-transfer-not-moved");
    await browser.waitUntil(async () => await tabCount() === before - 1,
      { timeoutMsg: "transferred split tab did not leave its source strip" });
    await switchToLabel(moved.target);
    await browser.waitUntil(async () => {
      const names = await domTexts(".explorer-pane .entry-name");
      return names.includes("source.txt") && names.includes("destination.txt");
    }, { timeoutMsg: "the adopted split tab lost a pane or its directory" });
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-transfer.png");
    await browser.saveScreenshot("e2e-tauri/logs/ac-1-correlated-split-transfer.png");
    await browser.switchToWindow(mainHandle);
    await navigateTo(sourceDirectory);
    await listingHas("source.txt");
  });

  it("creates an eight-pane source layout with every directory usable and the final pane focused", async () => {
    console.info("[window-transfer-phase] large-layout setup started");
    await browser.switchToWindow(mainHandle);
    await browser.keys(["Control", "t"]);
    await navigateTo(largeLayoutDirectories[0]);
    for (let index = 1; index < largeLayoutDirectories.length; index += 1) {
      await browser.keys(["Control", "m"]);
      await browser.waitUntil(async () =>
        await browser.execute(() => document.querySelectorAll(".explorer-pane").length) === index + 1,
      { timeoutMsg: `split pane ${index} did not appear` });
      await navigateTo(largeLayoutDirectories[index]);
      await listingHas(`pane-${index}.txt`);
    }

    const panes = await browser.execute(() => [...document.querySelectorAll(".explorer-pane")].map((pane) => ({
      active: pane.classList.contains("active"),
      entries: [...pane.querySelectorAll(".entry-name")].map((entry) => entry.textContent),
    })));
    expect(panes).toHaveLength(largeLayoutDirectories.length);
    for (const index of largeLayoutDirectories.keys()) {
      expect(panes.some((pane) => pane.entries.includes(`pane-${index}.txt`))).toBe(true);
    }
    expect(panes.some((pane) => pane.active
      && pane.entries.includes(`pane-${largeLayoutDirectories.length - 1}.txt`))).toBe(true);
    console.info("[window-transfer-phase] large-layout setup completed");
  });

  it("restores every pane and watcher in a large transferred active layout", async () => {
    console.info("[window-transfer-phase] large-layout transfer started");
    const before = await tabCount();
    const moved = await operation("tear-off") as { moved: boolean; target: string };
    await expectTransferMoved(moved, "large-layout-transfer-not-moved");
    await browser.waitUntil(async () => await tabCount() === before - 1,
      { timeoutMsg: "transferred large tab did not leave its source strip" });
    largeLayoutLabel = moved.target;
    await switchToLabel(moved.target);

    try {
      await browser.waitUntil(async () => await browser.execute((expectedPath, expectedEntry) => {
        const pane = document.querySelector(".explorer-pane.active");
        return document.querySelector(".status-path")?.getAttribute("title") === expectedPath
          && [...(pane?.querySelectorAll(".entry-name") ?? [])].some((entry) => entry.textContent === expectedEntry);
      }, largeLayoutDirectories[largeLayoutDirectories.length - 1], `pane-${largeLayoutDirectories.length - 1}.txt`),
      { timeout: 20_000, timeoutMsg: "focused restored directory did not become usable" });

      await browser.waitUntil(async () => {
        const panes = await browser.execute(() => [...document.querySelectorAll(".explorer-pane")].map((pane) => ({
          active: pane.classList.contains("active"),
          entries: [...pane.querySelectorAll(".entry-name")].map((entry) => entry.textContent),
        })));
        return panes.length === largeLayoutDirectories.length
          && largeLayoutDirectories.every((_directory, index) =>
            panes.some((pane) => pane.entries.includes(`pane-${index}.txt`)))
          && panes.some((pane) => pane.active && pane.entries.includes(`pane-${largeLayoutDirectories.length - 1}.txt`));
      }, { timeout: 30_000, timeoutMsg: "large transferred layout did not restore every real directory" });
    } catch (error) {
      await captureDiagnostics("large-layout-restoration");
      throw error;
    }

    fs.writeFileSync(path.join(largeLayoutDirectories[0], "after-large-transfer.txt"), "watcher");
    await listingHas("after-large-transfer.txt");
    await browser.saveScreenshot("e2e-tauri/logs/ac-3-eight-pane-transfer.png");
    console.info("[window-transfer-phase] large-layout transfer completed");
  });

  const closeCases = [
    { name: "titlebar close retires only its requested window", kind: "titlebar", index: 0 },
    { name: "native close retires only its requested window", kind: "native", index: 1 },
  ] as const;

  for (const closeCase of closeCases) {
    it(closeCase.name, async () => {
      console.info(`[window-transfer-phase] ${closeCase.kind} close started`);
      const label = closeCase.kind === "titlebar" ? childLabels[1] : largeLayoutLabel;
      const expectedEntry = closeCase.kind === "titlebar" ? "source.txt" : "pane-7.txt";

      await browser.switchToWindow(mainHandle);
      await navigateTo(sourceDirectory);
      await switchToLabel(label);
      await listingHas(expectedEntry);
      const closingHandle = await browser.getWindowHandle();
      try {
        if (closeCase.kind === "titlebar") {
          await $("button[aria-label='Close']").click();
        } else {
          // The real close API emits a native close request; the app observer
          // must prevent Tauri's default and perform terminal destroy once.
          await browser.execute((token) => {
            window.dispatchEvent(new CustomEvent("e2e-window-operation", {
              detail: { token, op: "native-close" },
            }));
          }, crypto.randomUUID());
        }
      } catch (error) {
        // WebKit may destroy the target before returning its click response.
        // Only accept that protocol result; prove actual retirement below.
        if (!String(error).includes("no such window")) throw error;
      }
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(closingHandle), {
        timeout: 15_000, timeoutMsg: `${closeCase.kind} close did not retire the window`,
      });
      await browser.switchToWindow(mainHandle);
      const name = `survived-close-${closeCase.index}.txt`;
      fs.writeFileSync(path.join(sourceDirectory, name), "watcher remains live");
      await listingHas(name);

      await navigateTo(destinationDirectory);
      await listingHas("destination.txt");
      if (closeCase.kind === "native") {
        await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-close.png");
        await captureDiagnostics("qualification-complete");
      }
      console.info(`[window-transfer-phase] ${closeCase.kind} close completed`);
    });
  }

});

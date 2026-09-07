/** Real native creation, seed consumption, ACK routing and source retirement. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, domTexts } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-window-transfer-"));
const sourceDirectory = path.join(scratch, "source");
const destinationDirectory = path.join(scratch, "destination");
const largeLayoutDirectories = Array.from({ length: 8 }, (_, index) =>
  path.join(scratch, `large-pane-${index}`));

async function operation(op: string, target?: string): Promise<unknown> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `native ${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

async function switchToLabel(label: string): Promise<void> {
  try {
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) return true;
      }
      return false;
    }, { timeout: 20_000, timeoutMsg: `window ${label} did not become ready` });
  } catch (error) {
    await captureDiagnostics(`switch-${label}`);
    throw error;
  }
}

async function listingHas(name: string) {
  try {
    await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes(name),
      { timeout: 20_000, timeoutMsg: `native listing did not contain ${name}` });
  } catch (error) {
    await captureDiagnostics(`listing-${name}`);
    throw error;
  }
}

async function tabCount() {
  return await browser.execute(() => document.querySelectorAll(".tab-area > .tab").length);
}

async function captureDiagnostics(reason: string): Promise<void> {
  const original = await browser.getWindowHandle().catch(() => null);
  const diagnostics: unknown[] = [];
  for (const handle of await browser.getWindowHandles()) {
    try {
      await browser.switchToWindow(handle);
      diagnostics.push(await browser.execute((windowHandle, failureReason) => ({
        reason: failureReason,
        handle: windowHandle,
        label: document.documentElement.dataset.e2eWindowLabel ?? null,
        url: location.href,
        title: document.title,
        bodyText: document.body?.textContent?.slice(0, 4_000) ?? null,
        statusPaths: [...document.querySelectorAll(".status-path")].map((node) => ({
          text: node.textContent, title: node.getAttribute("title"),
        })),
        panes: [...document.querySelectorAll(".explorer-pane")].map((pane) => ({
          classes: pane.className,
          text: pane.textContent?.slice(0, 1_500),
          html: pane.innerHTML.slice(0, 3_000),
          entries: [...pane.querySelectorAll(".entry-name")].map((node) => node.textContent),
          error: pane.querySelector(".error-state")?.textContent ?? null,
          loading: !!pane.querySelector(".loading"),
        })),
        activeElement: document.activeElement
          ? { tag: document.activeElement.tagName, classes: document.activeElement.className }
          : null,
        tabCount: document.querySelectorAll(".tab-area > .tab").length,
        storage: Object.keys(localStorage).filter((key) => key.includes("seed") || key.includes("tabs"))
          .map((key) => ({ key, value: localStorage.getItem(key)?.slice(0, 2_000) })),
        operationResult: document.documentElement.dataset.e2eWindowResult ?? null,
      }), handle, reason));
    } catch (captureError) {
      diagnostics.push({ reason, handle, captureError: String(captureError) });
    }
  }
  console.error(`[window-transfer-diagnostics] ${JSON.stringify(diagnostics, null, 2)}`);
  await browser.saveScreenshot(`/tmp/window-transfer-${reason.replace(/[^a-z0-9-]/gi, "-")}.png`).catch(() => {});
  if (original && (await browser.getWindowHandles()).includes(original)) {
    await browser.switchToWindow(original).catch(() => {});
  }
}

describe("native window transfer ownership", () => {
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
    fs.rmSync(scratch, { recursive: true, force: true });
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
    expect(moved.moved).toBe(true);
    await browser.waitUntil(async () => await tabCount() === before - 1,
      { timeoutMsg: "transferred split tab did not leave its source strip" });
    await switchToLabel(moved.target);
    await browser.waitUntil(async () => {
      const names = await domTexts(".explorer-pane .entry-name");
      return names.includes("source.txt") && names.includes("destination.txt");
    }, { timeoutMsg: "the adopted split tab lost a pane or its directory" });
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-transfer.png");
    await browser.switchToWindow(mainHandle);
    await navigateTo(sourceDirectory);
    await listingHas("source.txt");
  });

  it("restores every pane and watcher in a large transferred active layout", async () => {
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

    const before = await tabCount();
    const moved = await operation("tear-off") as { moved: boolean; target: string };
    expect(moved.moved).toBe(true);
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
  });

  it("titlebar and native close retire only their requested window", async () => {
    await browser.switchToWindow(mainHandle);
    await navigateTo(sourceDirectory);
    const labels = [childLabels[1], largeLayoutLabel];
    for (const [index, label] of labels.entries()) {
      await switchToLabel(label);
      await listingHas(index === 0 ? "source.txt" : "pane-7.txt");
      const closingHandle = await browser.getWindowHandle();
      try {
        if (index === 0) {
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
        timeout: 15_000, timeoutMsg: `${index === 0 ? "titlebar" : "native"} close did not retire the window`,
      });
      await browser.switchToWindow(mainHandle);
      const name = `survived-close-${index}.txt`;
      fs.writeFileSync(path.join(sourceDirectory, name), "watcher remains live");
      await listingHas(name);
    }
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-close.png");
    await navigateTo(destinationDirectory);
    await listingHas("destination.txt");
  });

});

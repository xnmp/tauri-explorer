/** Rejected native tab handoffs must leave the source as the sole owner. */
import { browser } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domTexts, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-transfer-rejection-"));
const leftDirectory = path.join(scratch, "left");
const rightDirectory = path.join(scratch, "right");
const warmDirectory = path.join(scratch, "warm");

async function operation(op: string, target?: string): Promise<any> {
  const token = await startOperation(op, target);
  return await operationResult(token, op);
}

async function startOperation(op: string, target?: string): Promise<string> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  return token;
}

async function operationResult(token: string, op: string): Promise<any> {
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() =>
      JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

async function uninitializedWindowHandle(previous: string[]): Promise<string> {
  const original = await browser.getWindowHandle();
  let result = "";
  try {
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        if (previous.includes(handle)) continue;
        await browser.switchToWindow(handle);
        const url = await browser.getUrl();
        // tauri-runtime-wry deliberately omits with_url for about:blank, so
        // WebKit reports an empty URL until a document is explicitly loaded.
        if (url === "" || url === "about:blank") {
          result = handle;
          return true;
        }
      }
      return false;
    }, { timeout: 20_000, timeoutMsg: "new uninitialized native window handle did not appear" });
  } finally {
    if ((await browser.getWindowHandles()).includes(original)) await browser.switchToWindow(original);
  }
  return result;
}

async function switchToLabel(label: string): Promise<string> {
  let result = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
        result = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: `window ${label} did not become ready` });
  return result;
}

async function parkedWindow(): Promise<{ label: string; handle: string }> {
  const original = await browser.getWindowHandle();
  let parked: { label: string; handle: string } | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === original) continue;
      await browser.switchToWindow(handle);
      const state = await browser.execute(() => ({
        label: document.documentElement.dataset.e2eWindowLabel,
        ready: document.documentElement.dataset.e2eWarmReady,
      }));
      if (state.label && state.ready === "1") {
        parked = { label: state.label, handle };
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: "parked warm window did not become ready" });
  await browser.switchToWindow(original);
  return parked!;
}

async function switchToPicker(token: string): Promise<string> {
  let result = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      const matches = await browser.execute((expected) =>
        new URLSearchParams(location.search).get("token") === expected
          && document.querySelector(".picker") !== null, token);
      if (matches) {
        result = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: `picker ${token} did not become ready` });
  return result;
}

async function sourceShape(): Promise<{
  activeTabId: string | null; activePath: string | null; paneCount: number; entries: string[];
}> {
  return browser.execute(() => ({
    activeTabId: document.querySelector<HTMLElement>(".tab.active")?.dataset.tabId ?? null,
    activePath: document.querySelector<HTMLElement>(".status-path")?.title ?? null,
    paneCount: document.querySelectorAll(".explorer-pane").length,
    entries: [...document.querySelectorAll<HTMLElement>(".explorer-pane .entry-name")]
      .map(node => node.textContent ?? "").sort(),
  }));
}

describe("native window transfer rejection", () => {
  let sourceHandle: string;
  let baseline: Awaited<ReturnType<typeof sourceShape>>;

  before(async () => {
    for (const directory of [leftDirectory, rightDirectory, warmDirectory]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(leftDirectory, "left.txt"), "left");
    fs.writeFileSync(path.join(rightDirectory, "right.txt"), "right");
    fs.writeFileSync(path.join(warmDirectory, "warm.txt"), "warm");
    await navigateTo(leftDirectory);
    sourceHandle = await browser.getWindowHandle();
    // Native sessions share persisted tabs. Start the transfer fixture in a
    // fresh single-pane tab even if a previous session left a split layout.
    const previousTabs = await browser.execute(() => document.querySelectorAll(".tab-area > .tab").length);
    await browser.keys(["Control", "t"]);
    await browser.waitUntil(async () => await browser.execute((expectedTabs) =>
      document.querySelectorAll(".tab-area > .tab").length === expectedTabs
        && document.querySelectorAll(".explorer-pane").length === 1,
    previousTabs + 1), { timeoutMsg: "fresh transfer source did not have exactly one pane" });
    await browser.keys(["Control", "m"]);
    await browser.waitUntil(async () =>
      await browser.execute(() => document.querySelectorAll(".explorer-pane").length === 2));
    await navigateTo(rightDirectory);
    baseline = await sourceShape();
    expect(baseline.activeTabId).not.toBeNull();
    expect(baseline.activePath).toBe(rightDirectory);
    expect(baseline.paneCount).toBe(2);
    expect(baseline.entries).toEqual(expect.arrayContaining(["left.txt", "right.txt"]));
  });

  after(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === sourceHandle) continue;
      await browser.switchToWindow(handle);
      await browser.closeWindow();
    }
    if ((await browser.getWindowHandles()).includes(sourceHandle)) {
      await browser.switchToWindow(sourceHandle);
      await browser.execute(() => {
        for (let index = localStorage.length - 1; index >= 0; index -= 1) {
          const key = localStorage.key(index);
          if (key?.startsWith("e2e-transfer-receipt:")) localStorage.removeItem(key);
        }
      });
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function verifySourceOwnsTab(marker: string): Promise<void> {
    expect(await browser.getWindowHandles()).toContain(sourceHandle);
    await browser.switchToWindow(sourceHandle);
    const shape = await sourceShape();
    expect(shape.activeTabId).toBe(baseline.activeTabId);
    expect(shape.activePath).toBe(baseline.activePath);
    expect(shape.paneCount).toBe(baseline.paneCount);
    expect(shape.entries).toEqual(expect.arrayContaining(["left.txt", "right.txt"]));
    fs.writeFileSync(path.join(rightDirectory, marker), marker);
    await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes(marker), {
      timeout: 20_000, timeoutMsg: `source watcher did not render ${marker}`,
    });
  }

  it("retains the source for missing, destroyed, and hidden destinations", async () => {
    const missing = `missing-${crypto.randomUUID()}`;
    expect(await operation("transfer", missing)).toEqual({ moved: false, target: missing });
    await verifySourceOwnsTab("after-missing.txt");

    const opened = await operation("warm-open", warmDirectory) as { label: string };
    const destroyedHandle = await switchToLabel(opened.label);
    await browser.execute(() => {
      window.dispatchEvent(new CustomEvent("e2e-window-operation", {
        detail: { token: "destroy-transfer-target", op: "native-destroy" },
      }));
    });
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(destroyedHandle), {
      timeout: 20_000, timeoutMsg: "transfer target was not destroyed",
    });
    await browser.switchToWindow(sourceHandle);
    expect(await operation("target-state", opened.label)).toEqual({ exists: false, visible: false });
    expect(await operation("transfer", opened.label)).toEqual({ moved: false, target: opened.label });
    await verifySourceOwnsTab("after-destroyed.txt");

    await operation("warm-prime");
    const parked = await parkedWindow();
    expect(await operation("target-state", parked.label)).toEqual({ exists: true, visible: false });
    expect(await operation("transfer", parked.label)).toEqual({ moved: false, target: parked.label });
    await verifySourceOwnsTab("after-hidden.txt");

    const activated = await operation("warm-open", warmDirectory) as { kind: string; label: string };
    expect(activated).toEqual({ kind: "warm", label: parked.label });
    await switchToLabel(parked.label);
    expect(await browser.execute(() => document.querySelectorAll(".explorer-pane").length)).toBe(1);
    expect(await browser.execute(() => document.querySelectorAll(".tab-area > .tab").length)).toBe(1);
    expect(await domTexts(".explorer-pane .entry-name")).toContain("warm.txt");
    await browser.switchToWindow(sourceHandle);
    await verifySourceOwnsTab("after-warm-activation.txt");
  });

  it("rejects a real picker target without changing either window", async () => {
    await browser.switchToWindow(sourceHandle);
    const picker = await operation("open-picker", warmDirectory) as { label: string; token: string };
    const pickerHandle = await switchToPicker(picker.token);
    expect(await domTexts(".picker-title")).toContain("Select File");
    expect(await browser.execute((folder) =>
      [...document.querySelectorAll<HTMLElement>(".column")].some(column => column.dataset.path === folder),
    warmDirectory)).toBe(true);
    const pickerEntries = () => browser.execute((folder) => {
      const column = [...document.querySelectorAll<HTMLElement>(".column")]
        .find(candidate => candidate.dataset.path === folder);
      return [...(column?.querySelectorAll<HTMLElement>(".entry-label") ?? [])]
        .map(entry => entry.textContent ?? "");
    }, warmDirectory);
    await browser.waitUntil(async () => (await pickerEntries()).includes("warm.txt"), {
      timeout: 20_000, timeoutMsg: "real picker did not list its requested directory",
    });
    expect(await browser.execute(() => document.querySelectorAll(".tab").length)).toBe(0);
    await browser.switchToWindow(sourceHandle);
    expect(await operation("transfer", picker.label)).toEqual({ moved: false, target: picker.label });
    await verifySourceOwnsTab("after-picker.txt");
    await browser.switchToWindow(pickerHandle);
    expect(await browser.execute(() => document.querySelectorAll(".tab").length)).toBe(0);
    expect(await pickerEntries()).toContain("warm.txt");
    await browser.switchToWindow(sourceHandle);
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-window-transfer-rejection.png");
  });

  it("rejects a native destination before its application receiver is ready", async () => {
    await browser.switchToWindow(sourceHandle);
    const handlesBefore = await browser.getWindowHandles();
    const opened = await operation("open-unready", warmDirectory) as { label: string; appUrl: string };
    const unreadyHandle = await uninitializedWindowHandle(handlesBefore);
    expect(await operation("target-state", opened.label)).toEqual({ exists: true, visible: true });

    expect(await operation("transfer", opened.label)).toEqual({ moved: false, target: opened.label });
    await verifySourceOwnsTab("after-unready.txt");

    expect(await browser.getWindowHandles()).toContain(unreadyHandle);
    await browser.switchToWindow(unreadyHandle);
    expect(["", "about:blank"]).toContain(await browser.getUrl());
    await browser.url(opened.appUrl);
    await browser.waitUntil(async () =>
      await browser.execute((label) =>
        document.documentElement.dataset.e2eHooksReady === "true"
          && document.documentElement.dataset.e2eWindowLabel === label,
      opened.label), {
      timeout: 20_000, timeoutMsg: "formerly unready destination did not initialize",
    });
    await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes("warm.txt"), {
      timeout: 20_000, timeoutMsg: "formerly unready destination did not list its requested directory",
    });
    expect(await browser.execute(() => document.querySelectorAll(".tab-area > .tab").length)).toBe(1);
    expect(await browser.execute(() => document.querySelectorAll(".explorer-pane").length)).toBe(1);
    expect(await browser.execute(() => document.querySelector(".status-path")?.getAttribute("title")))
      .toBe(warmDirectory);
    await browser.switchToWindow(sourceHandle);
  });

  it("retains the source when a destination closes after receiving the native handoff", async () => {
    await browser.switchToWindow(sourceHandle);
    const opened = await operation("fresh-open", warmDirectory) as { kind: string; label: string };
    const targetHandle = await switchToLabel(opened.label);
    await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes("warm.txt"), {
      timeout: 20_000, timeoutMsg: "closing destination did not list its requested directory",
    });
    const armToken = crypto.randomUUID();
    const armed = await operation("arm-transfer-close", armToken) as { receiptKey: string };

    await browser.switchToWindow(sourceHandle);
    const sourceLabel = await browser.execute(() => document.documentElement.dataset.e2eWindowLabel!);
    const transferToken = await startOperation("transfer", opened.label);
    // Tauri runs every listener for one native emit in a single synchronous
    // loop. Production yields at its first import; the armed handler records
    // this real payload and synchronously revokes admission before adoption.
    let receipt: {
      token?: string; sourceWindow?: string; targetWindow?: string;
      receivedAt?: number; closeRequestedAt?: number;
    } = {};
    await browser.waitUntil(async () => {
      receipt = await browser.execute((key) =>
        JSON.parse(localStorage.getItem(key) ?? "{}"), armed.receiptKey);
      return receipt.token === armToken && receipt.closeRequestedAt !== undefined;
    }, { timeout: 10_000, timeoutMsg: "destination did not record the native handoff receipt" });
    expect(receipt.sourceWindow).toBe(sourceLabel);
    expect(receipt.targetWindow).toBe(opened.label);
    expect(receipt.receivedAt).toBeLessThanOrEqual(receipt.closeRequestedAt!);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(targetHandle), {
      timeout: 20_000, timeoutMsg: "destination did not close after receiving the handoff",
    });
    expect(await operationResult(transferToken, "transfer")).toEqual({ moved: false, target: opened.label });
    await browser.execute((key) => localStorage.removeItem(key), armed.receiptKey);
    await verifySourceOwnsTab("after-receipt-close.txt");
  });

  it("does not retire an existing destination when native creation rejects its label", async () => {
    await browser.switchToWindow(sourceHandle);
    const opened = await operation("fresh-open", warmDirectory) as { kind: string; label: string };
    expect(opened.kind).toBe("fresh");
    const targetHandle = await switchToLabel(opened.label);
    await browser.waitUntil(async () => (await domTexts(".explorer-pane .entry-name")).includes("warm.txt"), {
      timeout: 20_000, timeoutMsg: "collision target did not list its requested directory",
    });
    const targetBefore = await sourceShape();
    expect(targetBefore.activePath).toBe(warmDirectory);
    expect(targetBefore.paneCount).toBe(1);
    expect(targetBefore.entries).toContain("warm.txt");

    await browser.switchToWindow(sourceHandle);
    const rejected = await operation("collision-transfer", opened.label) as {
      moved: boolean; target: string; failures: Array<{ phase: string }>;
    };
    expect(rejected.moved).toBe(false);
    expect(rejected.target).toBe(opened.label);
    expect(rejected.failures.some(({ phase }) => phase === "native")).toBe(true);
    expect(await browser.getWindowHandles()).toContain(targetHandle);

    await browser.switchToWindow(targetHandle);
    const targetAfter = await sourceShape();
    expect(targetAfter.activeTabId).toBe(targetBefore.activeTabId);
    expect(targetAfter.activePath).toBe(targetBefore.activePath);
    expect(targetAfter.paneCount).toBe(targetBefore.paneCount);
    expect(targetAfter.entries).toContain("warm.txt");
    fs.writeFileSync(path.join(warmDirectory, "target-survived-collision.txt"), "target watcher");
    await browser.waitUntil(async () =>
      (await domTexts(".explorer-pane .entry-name")).includes("target-survived-collision.txt"), {
      timeout: 20_000, timeoutMsg: "collision target watcher did not remain live",
    });
    fs.mkdirSync("screenshots/refactor/repo-health-cleanup", { recursive: true });
    await browser.saveScreenshot(
      "screenshots/refactor/repo-health-cleanup/native-window-collision-target.png",
    );

    await browser.switchToWindow(sourceHandle);
    await verifySourceOwnsTab("source-survived-collision.txt");
    await browser.saveScreenshot(
      "screenshots/refactor/repo-health-cleanup/native-window-collision-source.png",
    );
  });
});

/** Native window or renderer destruction must retire its directory-watch leases. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exactApplicationPid } from "../native-process";
import {
  inotifyWatchesForPath,
  nativeProcessIdentity,
  type InotifyWatch,
  type NativeProcessIdentity,
} from "../native-resources";
import { domTexts, navigateTo, switchToFreshWindow, waitForFreshWindowElement } from "./helpers";

const scratch = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-directory-owner-"),
);
const mainDirectory = path.join(scratch, "main");
const reloadDirectory = path.join(scratch, "reload-raw-watch");
const childDirectories = Array.from(
  { length: 3 },
  (_, index) => path.join(scratch, `child-${index + 1}`),
);

type WindowOperationResult = { kind: string; label: string } | null;
type DirectoryWatchLease = { id: string; path: string };

let mainHandle = "";
let application: NativeProcessIdentity;

async function operation(op: string, target?: string): Promise<unknown> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() =>
      JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `${op} did not finish` });
  expect(response.error).toBeUndefined();
  return response.result;
}

async function waitForDirectoryWatch(directory: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((target) => {
    const data = document.documentElement.dataset;
    const ready: string[] = JSON.parse(data.e2eReadyDirectoryWatches ?? "[]");
    return data.e2eDirectoryWatcherListenerReady === "true" && ready.includes(target);
  }, directory), { timeout: 20_000, timeoutMsg: `pane watch was not acknowledged for ${directory}` });
}

function describeWatches(watches: InotifyWatch[]): string {
  return watches.map(({ fd, watchDescriptor, device, inode }) =>
    `fd=${fd},wd=${watchDescriptor.toString(16)},dev=${device.toString(16)},ino=${inode.toString(16)}`)
    .join("; ");
}

async function waitForInotifyState(
  directory: string,
  present: boolean,
  timeoutMs = 10_000,
): Promise<InotifyWatch[]> {
  const deadline = Date.now() + timeoutMs;
  let matches: InotifyWatch[] = [];
  do {
    matches = inotifyWatchesForPath(application, directory);
    if ((matches.length > 0) === present) return matches;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `${present ? "missing" : "retained"} inotify watch for ${directory}`
    + (matches.length > 0 ? `: ${describeWatches(matches)}` : ""),
  );
}

async function waitForCausalMutation(directory: string, marker: string): Promise<void> {
  const startedAt = Date.now();
  fs.writeFileSync(path.join(directory, marker), marker);
  await browser.waitUntil(async () => await browser.execute((target, notBefore) => {
    const encoded = document.documentElement.dataset.e2eDirectoryWatcherReceipts;
    const receipts: Record<string, { observedAt: number | null }> = encoded
      ? JSON.parse(encoded)
      : {};
    const observedAt = receipts[target]?.observedAt;
    return observedAt != null && observedAt >= notBefore;
  }, directory, startedAt), {
    timeout: 25_000,
    timeoutMsg: `no causal native watcher receipt for ${marker}`,
  });
  await browser.waitUntil(async () => (await domTexts(".entry-name")).includes(marker), {
    timeout: 25_000,
    timeoutMsg: `native watcher refresh did not render ${marker}`,
  });
}

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

linuxDescribe("pane directory native window ownership", () => {
  before(async () => {
    fs.mkdirSync(mainDirectory);
    fs.writeFileSync(path.join(mainDirectory, "main.txt"), "surviving window");
    fs.mkdirSync(reloadDirectory);
    fs.writeFileSync(path.join(reloadDirectory, "retained.txt"), "reload watch fixture");
    for (const [index, directory] of childDirectories.entries()) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, `child-${index + 1}.txt`), "child window");
    }
    await navigateTo(mainDirectory);
    mainHandle = await browser.getWindowHandle();
    application = nativeProcessIdentity(exactApplicationPid());
    await waitForDirectoryWatch(mainDirectory);
    await waitForInotifyState(mainDirectory, true);
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
    // Retain watched directories until all resource assertions finish. Removing
    // them earlier lets the kernel discard leaked watches and masks the defect.
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("reclaims each unique child watch while the main window keeps observing", async () => {
    for (const [index, directory] of childDirectories.entries()) {
      await browser.switchToWindow(mainHandle);
      const existingHandles = await browser.getWindowHandles();
      const opened = await operation("fresh-open", directory) as WindowOperationResult;
      expect(opened).not.toBeNull();
      expect(opened?.kind).toBe("fresh");
      const childHandle = await switchToFreshWindow(opened!.label, existingHandles);
      await waitForFreshWindowElement(".file-list", 20_000);
      await browser.waitUntil(async () =>
        (await $(".status-path").getAttribute("title")) === directory,
      { timeout: 20_000, timeoutMsg: `child did not navigate to ${directory}` });
      await waitForDirectoryWatch(directory);
      const acquired = await waitForInotifyState(directory, true);

      const childMarker = `observed-before-destroy-${index + 1}.txt`;
      await waitForCausalMutation(directory, childMarker);

      // Dispatch exactly once. Destruction removes this DOM before an operation
      // result can be published, deliberately bypassing frontend teardown.
      const token = crypto.randomUUID();
      await browser.execute((detail) => {
        window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
      }, { token, op: "native-destroy" });
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle), {
        timeout: 20_000,
        timeoutMsg: `child ${index + 1} did not close after native destruction`,
      });

      await browser.switchToWindow(mainHandle);
      await waitForInotifyState(directory, false);
      const mainMarker = `main-survived-${index + 1}.txt`;
      await waitForCausalMutation(mainDirectory, mainMarker);
      console.log(JSON.stringify({
        case: "directory-watch-native-destroy",
        cycle: index + 1,
        application,
        directory,
        acquired: acquired.map(({ fd, watchDescriptor, device, inode }) => ({
          fd,
          watchDescriptor: watchDescriptor.toString(16),
          device: device.toString(16),
          inode: inode.toString(16),
        })),
        retained: 0,
      }));
    }
  });

  it("retires an unmanaged directory lease when the main renderer reloads", async () => {
    await browser.switchToWindow(mainHandle);
    await navigateTo(mainDirectory);
    const oldLease = await operation(
      "directory-watch-acquire",
      reloadDirectory,
    ) as DirectoryWatchLease;
    expect(oldLease.path).toBe(reloadDirectory);
    expect(oldLease.id).not.toBe("");
    const oldWatches = await waitForInotifyState(reloadDirectory, true);

    // This raw probe has no frontend owner or cleanup. Reload must retire its
    // old realm while retaining both the native window and fixture directory.
    await browser.refresh();
    await navigateTo(mainDirectory);
    expect(await browser.getWindowHandle()).toBe(mainHandle);
    await waitForDirectoryWatch(mainDirectory);
    await waitForCausalMutation(mainDirectory, "main-survived-reload.txt");
    expect(fs.existsSync(reloadDirectory)).toBe(true);
    await waitForInotifyState(reloadDirectory, false);

    const newLease = await operation(
      "directory-watch-acquire",
      reloadDirectory,
    ) as DirectoryWatchLease;
    expect(newLease.path).toBe(reloadDirectory);
    expect(newLease.id).not.toBe(oldLease.id);
    const newWatches = await waitForInotifyState(reloadDirectory, true);

    console.log(JSON.stringify({
      case: "directory-watch-renderer-reload",
      application,
      directory: reloadDirectory,
      oldLease,
      oldWatches: oldWatches.map(({ fd, watchDescriptor }) => ({
        fd,
        watchDescriptor: watchDescriptor.toString(16),
      })),
      newLease,
      newWatches: newWatches.map(({ fd, watchDescriptor }) => ({
        fd,
        watchDescriptor: watchDescriptor.toString(16),
      })),
    }));
  });
});

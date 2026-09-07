/** A mounted pane must recover when its watched path is replaced by a new inode. */
import { browser, $ } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domText, domTexts, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-directory-recovery-"));
const watchedDirectory = path.join(scratch, "watched");
const displacedDirectory = path.join(scratch, "displaced");
const independentDirectory = path.join(scratch, "independent");
const contentDirectory = path.join(scratch, "content-modification");
const contentFileName = "existing.md";
const initialContentMarker = "Initial existing-file content.";
const updatedContentMarker = "Updated existing-file content reached the preview.";

type WindowOperationResult = { kind: string; label: string } | null;

let mainHandle = "";
let watchedHandle = "";

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

async function switchToLabel(label: string): Promise<string> {
  let selected = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
        selected = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: `native window ${label} did not become ready` });
  return selected;
}

async function waitForDirectoryWatch(directory: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((target) => {
    const data = document.documentElement.dataset;
    const ready: string[] = JSON.parse(data.e2eReadyDirectoryWatches ?? "[]");
    return data.e2eDirectoryWatcherListenerReady === "true" && ready.includes(target);
  }, directory), {
    timeout: 20_000,
    timeoutMsg: `pane watch was not acknowledged for ${directory}`,
  });
}

async function waitForEntries(included: string[], excluded: string[] = []): Promise<void> {
  await browser.waitUntil(async () => {
    const entries = await domTexts(".entry-name");
    return included.every((name) => entries.includes(name))
      && excluded.every((name) => !entries.includes(name));
  }, {
    timeout: 25_000,
    timeoutMsg: `listing did not converge to include ${included.join(", ")}`,
  });
}

async function waitForWatcherReceipt(
  directory: string,
  notBefore: number,
  context: string,
): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((target, notBefore) => {
    const encoded = document.documentElement.dataset.e2eDirectoryWatcherReceipts;
    const receipts: Record<string, { observedAt: number | null }> = encoded
      ? JSON.parse(encoded)
      : {};
    const observedAt = receipts[target]?.observedAt;
    return observedAt != null && observedAt >= notBefore;
  }, directory, notBefore), {
    timeout: 25_000,
    timeoutMsg: `no causal native watcher receipt for ${context}`,
  });
}

async function waitForCausalMutation(directory: string, marker: string): Promise<void> {
  const startedAt = Date.now();
  fs.writeFileSync(path.join(directory, marker), marker);
  await waitForWatcherReceipt(directory, startedAt, marker);
  await waitForEntries([marker]);
}

async function saveEvidence(name: string): Promise<void> {
  const directory = path.resolve("screenshots/refactor/repo-health-cleanup");
  fs.mkdirSync(directory, { recursive: true });
  await browser.saveScreenshot(path.join(directory, name));
}

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

linuxDescribe("directory watch root recovery", () => {
  before(() => {
    fs.mkdirSync(watchedDirectory);
    fs.mkdirSync(independentDirectory);
    fs.mkdirSync(contentDirectory);
    fs.writeFileSync(path.join(watchedDirectory, "original.txt"), "original inode");
    fs.writeFileSync(path.join(independentDirectory, "independent.txt"), "independent watcher");
    fs.writeFileSync(
      path.join(contentDirectory, contentFileName),
      `# Existing file\n\n${initialContentMarker}\n`,
    );
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
    // Removing the displaced tree earlier would hide a watch that stayed
    // attached to the old inode after the original path was recreated.
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("reattaches a mounted pane to a recreated directory without ghosting the displaced tree", async () => {
    await navigateTo(independentDirectory);
    mainHandle = await browser.getWindowHandle();
    await waitForDirectoryWatch(independentDirectory);
    await waitForCausalMutation(independentDirectory, "independent-before-recovery.txt");

    const opened = await operation("fresh-open", watchedDirectory) as WindowOperationResult;
    expect(opened).not.toBeNull();
    expect(opened?.kind).toBe("fresh");
    watchedHandle = await switchToLabel(opened!.label);
    await $(".file-list").waitForExist({ timeout: 20_000 });
    await browser.waitUntil(async () =>
      (await $(".status-path").getAttribute("title")) === watchedDirectory,
    { timeout: 20_000, timeoutMsg: `child did not navigate to ${watchedDirectory}` });
    await waitForDirectoryWatch(watchedDirectory);
    await waitForCausalMutation(watchedDirectory, "observed-before-replacement.txt");

    const originalInode = fs.statSync(watchedDirectory).ino;
    fs.renameSync(watchedDirectory, displacedDirectory);
    fs.mkdirSync(watchedDirectory);
    const replacementInode = fs.statSync(watchedDirectory).ino;
    expect(replacementInode).not.toBe(originalInode);
    fs.writeFileSync(path.join(watchedDirectory, "replacement-seed.txt"), "replacement inode");

    await waitForEntries(
      ["replacement-seed.txt"],
      ["original.txt", "observed-before-replacement.txt"],
    );
    expect(await $(".status-path").getAttribute("title")).toBe(watchedDirectory);
    expect(await browser.getWindowHandle()).toBe(watchedHandle);
    await waitForCausalMutation(watchedDirectory, "observed-after-replacement.txt");

    fs.writeFileSync(path.join(displacedDirectory, "ghost-from-old-inode.txt"), "displaced tree");
    await waitForCausalMutation(watchedDirectory, "replacement-after-ghost.txt");
    await waitForEntries(
      ["replacement-seed.txt", "observed-after-replacement.txt", "replacement-after-ghost.txt"],
      ["original.txt", "observed-before-replacement.txt", "ghost-from-old-inode.txt"],
    );

    await browser.switchToWindow(mainHandle);
    await waitForCausalMutation(independentDirectory, "independent-after-recovery.txt");
    await browser.switchToWindow(watchedHandle);
    await waitForEntries(
      ["replacement-seed.txt", "observed-after-replacement.txt", "replacement-after-ghost.txt"],
      ["ghost-from-old-inode.txt"],
    );
    console.log(JSON.stringify({
      case: "directory-root-replacement",
      originalInode,
      replacementInode,
      entries: await domTexts(".entry-name"),
      independentMutation: "independent-after-recovery.txt",
    }));
    await saveEvidence("native-directory-replacement.png");
  });

  it("refreshes visible contents when an existing file's data changes", async () => {
    if (mainHandle && (await browser.getWindowHandles()).includes(mainHandle)) {
      await browser.switchToWindow(mainHandle);
    }
    await navigateTo(contentDirectory);
    await waitForDirectoryWatch(contentDirectory);
    await waitForEntries([contentFileName]);

    await $(`.entry-item[data-path$="/${contentFileName}"]`).click();
    if (!(await $(".preview-pane").isExisting())) await browser.keys(" ");
    await $(".preview-markdown").waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(async () =>
      (await domText(".preview-markdown")).includes(initialContentMarker),
    { timeout: 20_000, timeoutMsg: "preview did not show the existing file's initial contents" });

    const prefix = `# Updated existing file\n\n${updatedContentMarker}\n`;
    const updatedContents = prefix + "x".repeat(8 * 1024 - Buffer.byteLength(prefix));
    const writeStartedAt = Date.now();
    fs.writeFileSync(path.join(contentDirectory, contentFileName), updatedContents);
    expect(fs.statSync(path.join(contentDirectory, contentFileName)).size).toBe(8 * 1024);

    await waitForWatcherReceipt(contentDirectory, writeStartedAt, "existing-file data modification");
    await browser.waitUntil(async () => {
      const preview = await domText(".preview-markdown");
      return preview.includes(updatedContentMarker) && !preview.includes(initialContentMarker);
    }, {
      timeout: 25_000,
      timeoutMsg: "preview retained stale contents after the existing file changed",
    });
    console.log(JSON.stringify({
      case: "directory-existing-file-modification",
      writeStartedAt,
      bytes: fs.statSync(path.join(contentDirectory, contentFileName)).size,
      marker: updatedContentMarker,
    }));
    await saveEvidence("native-directory-content-update.png");
  });
});

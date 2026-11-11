/** Miller ancestor listings against real filesystem watches and IPC (#1642). */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { navigateTo, entryPathSelector } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";

const scratch = createNativeFixtureDirectory("miller-freshness-");
const root = path.join(scratch, "source");
const current = path.join(root, "current");
const elsewhere = path.join(scratch, "elsewhere", "current");
let paneId: string;
const panel = () => `.miller-columns[data-pane-id=${JSON.stringify(paneId)}]`;
const column = () => $(entryPathSelector(root, `${panel()} .miller-col`));
const sibling = (name: string) => $(entryPathSelector(path.join(root, name), `${panel()} .col-entry`));

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog input");
  await input.waitForDisplayed();
  await input.setValue(label);
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

async function watchOwnership(directory: string, held: boolean): Promise<void> {
  await browser.waitUntil(async () => browser.execute((target: string, expected: boolean) => {
    const data = document.documentElement.dataset;
    const paths: string[] = JSON.parse(data.e2eReadyDirectoryWatches ?? "[]");
    return data.e2eDirectoryWatcherListenerReady === "true" && paths.includes(target) === expected;
  }, directory, held), { timeout: 15_000, timeoutMsg: `watch ownership for ${directory} never became ${held}` });
}

describe("native Miller column freshness", () => {
  before(() => {
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(root, "before-rename"));
    fs.writeFileSync(path.join(current, "proof.txt"), "real filesystem");
  });

  it("observes external changes and revalidates after an unwatched gap", async () => {
    await navigateTo(current);
    const owner = await $(".pane-tree:not(.retained) .explorer-pane:not(.inactive)").getAttribute("data-pane-id");
    if (!owner) throw new Error("active pane has no ownership ID");
    paneId = owner;
    await command("Miller Columns: 1 Layer");
    const ownership = await browser.execute(() => ({
      activePanes: [...document.querySelectorAll(".explorer-pane:not(.inactive)")].map(pane => pane.getAttribute("data-pane-id")),
      panels: [...document.querySelectorAll(".miller-columns")].map(panel => ({
        owner: panel.getAttribute("data-pane-id"),
        insidePane: !!panel.closest(".explorer-pane"),
        columns: [...panel.querySelectorAll(".miller-col")].map(column => column.getAttribute("data-path")),
      })),
    }));
    console.log("[Miller ownership]", JSON.stringify(ownership));
    await column().waitForDisplayed();
    await sibling("before-rename").waitForDisplayed();
    await watchOwnership(root, true);

    const startedAt = Date.now();
    fs.renameSync(path.join(root, "before-rename"), path.join(root, "after-rename"));
    await browser.waitUntil(async () => browser.execute((target: string, since: number) => {
      const receipts = JSON.parse(document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}");
      const receipt = receipts[target];
      return receipt?.origin === "watcher" && receipt.observedAt >= since;
    }, root, startedAt), { timeout: 15_000, timeoutMsg: "external rename never reached the application watcher" });

    await sibling("after-rename").waitForDisplayed();
    await expect(sibling("before-rename")).not.toExist();
    await navigateTo(elsewhere);
    await column().waitForExist({ reverse: true });
    // The marker is removed only after native unwatch acknowledges release.
    await watchOwnership(root, false);
    fs.mkdirSync(path.join(root, "gap-created"));

    await navigateTo(current);
    await sibling("gap-created").waitForDisplayed();
    await sibling("after-rename").waitForDisplayed();
    await watchOwnership(root, true);
    await expect($(entryPathSelector(path.join(current, "proof.txt"), ".pane-tree:not(.retained) .explorer-pane:not(.inactive) .file-list .entry-item"))).toExist();
    fs.mkdirSync("screenshots/refactor/audit-refactor-batch-2", { recursive: true });
    await $(panel()).saveScreenshot("screenshots/refactor/audit-refactor-batch-2/miller-revalidated.png");
  });
});

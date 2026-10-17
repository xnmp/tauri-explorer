/** Real GTK source, receiver negotiation and filesystem outcomes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browser, $ } from "@wdio/globals";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, entryPathSelector } from "./helpers";

const shown = ".pane-tree:not(.retained) ";
type Entry = ReturnType<typeof $>;

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog input");
  await input.waitForDisplayed();
  await input.setValue(label);
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

async function drag(source: Entry, destination: Entry, copy = false): Promise<void> {
  await source.waitForDisplayed();
  await destination.waitForDisplayed();
  const from = await source.getLocation();
  const to = await destination.getLocation();
  await browser.execute(() => {
    const root = document.documentElement;
    root.dataset.nativeDragSession = "";
    root.dataset.domDropReceived = "false";
    if (root.dataset.nativeDragProbeInstalled) return;
    root.dataset.nativeDragProbeInstalled = "true";
    document.addEventListener("dragstart", () => {
      const source = JSON.parse(localStorage.getItem("explorer-drag-data") || "null");
      root.dataset.nativeDragSession = source?.sessionId || "";
    });
    document.addEventListener("drop", () => { root.dataset.domDropReceived = "true"; }, { capture: true });
  });
  execFileSync("python3", [fileURLToPath(new URL("../helpers/native-drag.py", import.meta.url)),
    String(Math.round(from.x + 65)), String(Math.round(from.y + 12)),
    String(Math.round(to.x + 65)), String(Math.round(to.y + 12)),
    ...(copy ? ["--copy"] : []),
  ], { timeout: 10_000, stdio: "pipe" });
}

async function assertNativeTransport(): Promise<void> {
  assert.equal(await browser.execute(() => {
    const decision = JSON.parse(localStorage.getItem("explorer-native-drag-decision") || "null");
    return !!decision?.accepted && decision.sessionId === document.documentElement.dataset.nativeDragSession;
  }), true, "gesture must use its accepted native source");
  assert.equal(await browser.execute(() => document.documentElement.dataset.domDropReceived), "false",
    "a DOM fallback cannot qualify the native regression");
}

(process.platform === "linux" ? describe : describe.skip)("file drag against the real GTK backend", () => {
  before(async () => {
    await $(".file-list").waitForExist();
    await command("Details View");
  });
  after(async () => { await command("Miller Columns: Off"); });

  it("moves every selected file into the folder, preserving spaces and non-ASCII names", async () => {
    const scratch = createNativeFixtureDirectory("tauri-explorer-file-drag-");
    const source = path.join(scratch, "a space#.txt");
    const second = path.join(scratch, "ñ-other.txt");
    const destination = path.join(scratch, "Inbox");
    fs.mkdirSync(destination);
    fs.writeFileSync(source, "dragged file contents");
    fs.writeFileSync(second, "second selected file");
    await navigateTo(scratch);
    const sourceRow = $(entryPathSelector(source, shown + ".entry-item"));
    const targetRow = $(entryPathSelector(destination, shown + ".entry-item"));
    await sourceRow.waitForDisplayed();
    await sourceRow.click();
    await browser.performActions([{ type: "key", id: "selection-control", actions: [{ type: "keyDown", value: "\uE009" }] }]);
    try { await $(entryPathSelector(second, shown + ".entry-item")).click(); }
    finally { await browser.releaseActions(); }
    await drag(sourceRow, targetRow);
    const moved = path.join(destination, "a space#.txt");
    const secondMoved = path.join(destination, "ñ-other.txt");
    await browser.waitUntil(() => !fs.existsSync(source) && !fs.existsSync(second)
      && fs.existsSync(moved) && fs.existsSync(secondMoved), {
      timeout: 10_000, timeoutMsg: "drop highlighted its folder but did not move the file",
    });
    assert.equal(fs.readFileSync(moved, "utf8"), "dragged file contents");
    assert.equal(fs.readFileSync(secondMoved, "utf8"), "second selected file");
    await assertNativeTransport();
    await sourceRow.waitForExist({ reverse: true });
    await targetRow.doubleClick();
    await $(entryPathSelector(moved, shown + ".entry-item")).waitForDisplayed();
    await $(entryPathSelector(secondMoved, shown + ".entry-item")).waitForDisplayed();
  });

  for (const copy of [false, true]) {
    it(copy ? "Ctrl-drag from Miller copies and retains the source" : "drag from Miller moves and refreshes its source column", async () => {
      const scratch = createNativeFixtureDirectory("tauri-explorer-miller-drag-");
      const source = path.join(scratch, "source-dir");
      const current = path.join(scratch, "Work");
      const destination = path.join(current, "Inbox");
      fs.mkdirSync(source);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(source, "proof.txt"), "Miller native contents");
      await navigateTo(current);
      await command("Miller Columns: 1 Layer");
      const sourceRow = $(entryPathSelector(source, shown + ".col-entry"));
      const targetRow = $(entryPathSelector(destination, shown + ".entry-item"));
      await drag(sourceRow, targetRow, copy);
      const delivered = path.join(destination, "source-dir");
      await browser.waitUntil(() => fs.existsSync(path.join(delivered, "proof.txt"))
        && fs.existsSync(source) === copy, {
        timeout: 10_000, timeoutMsg: "Miller native drag did not apply the requested move/copy policy",
      });
      assert.equal(fs.readFileSync(path.join(delivered, "proof.txt"), "utf8"), "Miller native contents");
      if (copy) assert.equal(fs.readFileSync(path.join(source, "proof.txt"), "utf8"), "Miller native contents");
      else await sourceRow.waitForExist({ reverse: true });
      await assertNativeTransport();
      await targetRow.doubleClick();
      await $(entryPathSelector(delivered, shown + ".entry-item")).waitForDisplayed();
    });
  }
});

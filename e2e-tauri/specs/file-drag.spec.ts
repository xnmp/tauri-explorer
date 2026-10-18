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

/** A folder's spring-loaded peek in any view: a Details subtree (the state row
 * of an empty folder, or the rows of a populated one: entries directly below
 * the folder, which the pane's own listing never shows), a List card's scroll
 * area, a Tiles panel (#1242, #1269). */
const springPeekSelector = (folder: string) => [
  entryPathSelector(folder, shown).replace('[data-path="', '[data-peek-state="'),
  entryPathSelector(folder, `${shown}.entry-item`).replace('[data-path="', '[data-path^="').replace(/"\]$/, `${path.sep}"]`),
  entryPathSelector(folder, `${shown}[data-card-scroll]`),
  entryPathSelector(folder, `${shown}.tile-panel`),
].join(", ");

async function drag(source: Entry, destination: Entry, options: { copy?: boolean; cancel?: boolean; copyAfterStart?: boolean } = {}): Promise<void> {
  await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.e2eNativeDragReady === "true"), {
    timeout: 5_000, timeoutMsg: "read-only native Drop observer never became ready",
  });
  await source.waitForDisplayed();
  await destination.waitForDisplayed();
  const from = await source.getLocation();
  const to = await destination.getLocation();
  const folder = await destination.getAttribute("data-path");
  // WebKitWebDriver may run this in an isolated world: the probes share only
  // the DOM with the app, so they report through attributes, never globals.
  await browser.execute((peeks: string) => {
    const root = document.documentElement;
    root.dataset.nativeDragSession = "";
    root.dataset.domDropReceived = "false";
    root.dataset.nativeDragEnded = "";
    root.dataset.e2eNativeDragDrop = "";
    // Records whether the hover sprang the destination open (`assertSprangOpen`).
    root.dataset.springPeekWatch = peeks;
    root.dataset.springPeekOpened = "";
    root.dataset.springPeekOpenedAfterEnd = "";
    root.dataset.springPeekEndSignalAt = "";
    root.dataset.springPeekClosedLagMs = "";
    if (root.dataset.nativeDragProbeInstalled) return;
    root.dataset.nativeDragProbeInstalled = "true";
    document.addEventListener("dragstart", () => {
      const source = JSON.parse(localStorage.getItem("explorer-drag-data") || "null");
      root.dataset.nativeDragSession = source?.sessionId || "";
    });
    document.addEventListener("drop", () => { root.dataset.domDropReceived = "true"; }, { capture: true });
    // The last sign the drag is over: its dragend or the receiver's Drop.
    const endSignal = () => { root.dataset.springPeekEndSignalAt = String(performance.now()); };
    document.addEventListener("dragend", () => { root.dataset.nativeDragEnded = root.dataset.nativeDragSession; endSignal(); });
    new MutationObserver(endSignal).observe(root, { attributes: true, attributeFilter: ["data-e2e-native-drag-drop"] });
    new MutationObserver(() => {
      const watch = root.dataset.springPeekWatch;
      // How long after the last end signal the peek closed. The lost-Leave
      // fallback closes it 500ms after dragend, which would hide a broken
      // native Drop or Leave close: only the receiver may close it that fast.
      if (watch && root.dataset.springPeekOpened === "true" && !root.dataset.springPeekClosedLagMs && !document.querySelector(watch)) {
        root.dataset.springPeekClosedLagMs = String(performance.now() - Number(root.dataset.springPeekEndSignalAt || performance.now()));
      }
      if (watch && root.dataset.springPeekOpened !== "true" && document.querySelector(watch)) {
        root.dataset.springPeekOpened = "true";
        // Whether the native drag was already over (its dragend, or the
        // receiver's Drop) when the peek appeared: a peek that only shows up
        // after the drop proves nothing about the hover.
        root.dataset.springPeekOpenedAfterEnd = root.dataset.nativeDragEnded || root.dataset.e2eNativeDragDrop ? "true" : "false";
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, folder ? springPeekSelector(folder) : "");
  execFileSync("python3", [fileURLToPath(new URL("../helpers/native-drag.py", import.meta.url)),
    String(Math.round(from.x + 65)), String(Math.round(from.y + 12)),
    String(Math.round(to.x + 65)), String(Math.round(to.y + 12)),
    ...(options.copy ? ["--copy"] : []),
    ...(options.cancel ? ["--cancel"] : []),
    ...(options.copyAfterStart ? ["--copy-after-start"] : []),
  ], { timeout: 10_000, stdio: "pipe" });
}

/** native-drag.py hovers about a second over an adjacent destination before
 * releasing, so with Folder Peek on (the default) the gesture springs it open
 * (#1242). The probe `drag` installs saw that peek appear during the hover. */
async function assertSprangOpen(): Promise<void> {
  assert.equal(await browser.execute(() => document.documentElement.dataset.springPeekOpened), "true",
    "the hover never sprang the destination folder open");
  assert.equal(await browser.execute(() => document.documentElement.dataset.springPeekOpenedAfterEnd), "false",
    "the destination's peek only appeared after the native drag had ended, not during the hover");
}

/** The drop or cancel must still resolve to the folder and close the temporary
 * peek: until it does, the folder's contents show in place (a Details subtree,
 * a List card, a Tiles panel), and a navigated listing would prove nothing. */
async function assertSpringClosed(folder: string, contents: readonly string[] = []): Promise<void> {
  await $(springPeekSelector(folder)).waitForExist({ reverse: true, timeout: 5_000, timeoutMsg: "the drag's spring-loaded peek outlived the gesture" });
  // Closed by the receiver's Drop or Leave, well inside the 500ms lost-Leave
  // fallback (SPRING_LOST_LEAVE_MS), which must stay a backstop (#1269).
  const lag = Number(await browser.execute(() => document.documentElement.dataset.springPeekClosedLagMs));
  assert.ok(lag < 400, `the peek closed ${lag}ms after the drag ended: that is the lost-Leave fallback, not the native Drop or Leave`);
  for (const entry of contents) {
    assert.equal(await $(entryPathSelector(entry, shown + ".entry-item")).isExisting(), false,
      `${path.basename(entry)} is shown before navigating into its folder`);
  }
}

async function assertNativeTransport(requireDrop = true): Promise<void> {
  assert.equal(await browser.execute(() => {
    const decision = JSON.parse(localStorage.getItem("explorer-native-drag-decision") || "null");
    return !!decision?.accepted && decision.sessionId === document.documentElement.dataset.nativeDragSession;
  }), true, "gesture must use its accepted native source");
  assert.equal(await browser.execute(() => document.documentElement.dataset.domDropReceived), "false",
    "the native regression unexpectedly observed a DOM drop");
  if (requireDrop) {
    await browser.waitUntil(() => browser.execute(() => {
      const drop = JSON.parse(document.documentElement.dataset.e2eNativeDragDrop || "null");
      return drop?.type === "drop" && drop.source?.sessionId === document.documentElement.dataset.nativeDragSession;
    }), { timeout: 5_000, timeoutMsg: "no actual native receiver Drop for this gesture" });
  }
}

(process.platform === "linux" ? describe : describe.skip)("file drag against the real GTK backend", () => {
  before(async () => {
    await $(".file-list").waitForExist();
    await command("Details View");
  });
  after(async () => { await command("Miller Columns: Off"); });

  for (const view of ["Details", "List", "Tiles"]) {
    it(`[dnd:listing-move-${view.toLowerCase()}] moves every selected file into the folder, preserving spaces and non-ASCII names`, async () => {
      await command(`${view} View`);
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
      try {
        await browser.waitUntil(() => !fs.existsSync(source) && !fs.existsSync(second)
          && fs.existsSync(moved) && fs.existsSync(secondMoved), {
          timeout: 10_000, timeoutMsg: "drop highlighted its folder but did not move the file",
        });
      } catch (error) {
        // Distinguish broken delivery after actual native admission from an input
        // fixture that never started a drag. Used by the transport negative control.
        await assertNativeTransport(false);
        assert.equal(fs.readFileSync(source, "utf8"), "dragged file contents");
        assert.equal(fs.readFileSync(second, "utf8"), "second selected file");
        assert.deepEqual(fs.readdirSync(destination), []);
        throw error;
      }
      assert.equal(fs.readFileSync(moved, "utf8"), "dragged file contents");
      assert.equal(fs.readFileSync(secondMoved, "utf8"), "second selected file");
      await assertNativeTransport();
      await sourceRow.waitForExist({ reverse: true });
      await assertSprangOpen();
      await assertSpringClosed(destination, [moved, secondMoved]);
      await targetRow.doubleClick();
      await $(entryPathSelector(moved, shown + ".entry-item")).waitForDisplayed();
      await $(entryPathSelector(secondMoved, shown + ".entry-item")).waitForDisplayed();
    });
  }

  for (const mode of ["move", "copy", "copy-after-start"] as const) {
    const copy = mode !== "move";
    it(`[dnd:miller-${mode}] Miller ${mode} preserves the requested source/destination outcome`, async () => {
      await command("Details View");
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
      await drag(sourceRow, targetRow, { copy: mode === "copy", copyAfterStart: mode === "copy-after-start" });
      const delivered = path.join(destination, "source-dir");
      await browser.waitUntil(() => fs.existsSync(path.join(delivered, "proof.txt"))
        && fs.existsSync(source) === copy, {
        timeout: 10_000, timeoutMsg: "Miller native drag did not apply the requested move/copy policy",
      });
      assert.equal(fs.readFileSync(path.join(delivered, "proof.txt"), "utf8"), "Miller native contents");
      if (copy) assert.equal(fs.readFileSync(path.join(source, "proof.txt"), "utf8"), "Miller native contents");
      else await sourceRow.waitForExist({ reverse: true });
      await assertNativeTransport();
      await assertSpringClosed(destination, [delivered]);
      await targetRow.doubleClick();
      await $(entryPathSelector(delivered, shown + ".entry-item")).waitForDisplayed();
    });
  }

  it("[dnd:cancel-retry] Escape leaves files untouched and the next gesture moves them", async () => {
    await command("Miller Columns: Off");
    await command("Details View");
    const scratch = createNativeFixtureDirectory("tauri-explorer-drag-cancel-");
    const source = path.join(scratch, "retry.txt");
    const destination = path.join(scratch, "Inbox");
    const moved = path.join(destination, "retry.txt");
    fs.mkdirSync(destination);
    fs.writeFileSync(source, "must survive cancellation");
    await navigateTo(scratch);
    const sourceRow = $(entryPathSelector(source, shown + ".entry-item"));
    const targetRow = $(entryPathSelector(destination, shown + ".entry-item"));
    await drag(sourceRow, targetRow, { cancel: true });
    await browser.waitUntil(() => browser.execute(() => {
      const data = document.documentElement.dataset;
      return !!data.nativeDragSession && data.nativeDragEnded === data.nativeDragSession;
    }), { timeout: 5_000, timeoutMsg: "cancelled real drag did not end" });
    await assertNativeTransport(false);
    assert.equal(await browser.execute(() => document.documentElement.dataset.e2eNativeDragDrop), "",
      "cancelled gesture unexpectedly delivered a native Drop");
    assert.equal(fs.readFileSync(source, "utf8"), "must survive cancellation");
    assert.deepEqual(fs.readdirSync(destination), []);
    // Escape ends the native drag, and with it the peek it sprang open.
    await assertSprangOpen();
    await assertSpringClosed(destination);
    await sourceRow.waitForDisplayed();
    const cancelledSession = await browser.execute(() => document.documentElement.dataset.nativeDragSession);
    await drag(sourceRow, targetRow);
    await browser.waitUntil(() => !fs.existsSync(source) && fs.existsSync(moved), { timeout: 10_000 });
    assert.equal(fs.readFileSync(moved, "utf8"), "must survive cancellation");
    await assertNativeTransport();
    assert.notEqual(await browser.execute(() => document.documentElement.dataset.nativeDragSession), cancelledSession);
    assert.equal(await browser.execute((session: string) => {
      const history = JSON.parse(document.documentElement.dataset.e2eNativeDragDrops || "[]");
      return history.some((drop: { source?: { sessionId?: string } }) => drop.source?.sessionId === session);
    }, cancelledSession!), false, "cancelled session delivered a late native Drop during retry");
    await sourceRow.waitForExist({ reverse: true });
    await assertSprangOpen();
    await assertSpringClosed(destination, [moved]);
    await targetRow.doubleClick();
    await $(entryPathSelector(moved, shown + ".entry-item")).waitForDisplayed();
    if (process.env.TAURI_DND_EVIDENCE_DIRECTORY) {
      fs.mkdirSync(process.env.TAURI_DND_EVIDENCE_DIRECTORY, { recursive: true });
      await browser.saveScreenshot(path.resolve(process.env.TAURI_DND_EVIDENCE_DIRECTORY, "native-cancel-retry.png"));
    }
  });
});

/**
 * Filesystem-watcher-driven refresh against the built binary: files created
 * and deleted OUTSIDE the app (plain fs calls) must appear/disappear in the
 * listing without any UI action.
 *
 * This path is unreachable from browser-mode Playwright — the notify-based
 * watcher only exists in the Rust backend, and it is also what drives
 * automatic cross-pane refresh in dual-pane mode.
 */
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, entryNames } from "./helpers";

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-watch-"));

describe("filesystem watcher refresh", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "existing.txt"), "hello\n");
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("a file created outside the app appears without any UI action", async () => {
    await navigateTo(scratchDir);
    await browser.waitUntil(async () => (await entryNames()).includes("existing.txt"), {
      timeoutMsg: "initial listing never loaded",
    });

    fs.writeFileSync(path.join(scratchDir, "external.txt"), "created externally\n");

    // No refresh, no keypress — the backend watcher must push the change.
    // Windows ReadDirectoryChangesW notifications can lag several seconds, so
    // allow generous headroom: the assertion is *eventual* consistency, not
    // sub-second latency.
    await browser.waitUntil(async () => (await entryNames()).includes("external.txt"), {
      timeout: 25_000,
      timeoutMsg: "watcher never surfaced the externally created file",
    });
  });

  it("a file deleted outside the app disappears without any UI action", async () => {
    fs.rmSync(path.join(scratchDir, "external.txt"));

    // Delete notifications are the slowest/least reliable on Windows'
    // ReadDirectoryChangesW backend — give the watcher ample time.
    await browser.waitUntil(async () => !(await entryNames()).includes("external.txt"), {
      timeout: 25_000,
      timeoutMsg: "watcher never removed the externally deleted file",
    });
  });
});

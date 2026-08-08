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

  it("coalesces a real watcher burst to one trailing refresh while a listing is slow", async () => {
    await navigateTo(scratchDir);

    // Delay only the WebView's receipt of the first real listing response.
    // The Rust notify watcher still emits the events and the actual backend
    // command still runs; this creates a deterministic in-flight pane refresh
    // in which to send the burst.
    await browser.execute((watchedPath: string) => {
      type Internals = {
        invoke: (command: string, args?: { path?: string }, options?: unknown) => Promise<unknown>;
        __watcherOriginalInvoke?: Internals["invoke"];
        __watcherRefreshCalls?: number;
        __watcherDelayFirstListing?: boolean;
      };
      const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
      internals.__watcherOriginalInvoke = internals.invoke;
      internals.__watcherRefreshCalls = 0;
      internals.__watcherDelayFirstListing = true;
      internals.invoke = (command, args, options) => {
        const result = internals.__watcherOriginalInvoke!(command, args, options);
        if (command !== "start_streaming_directory" || args?.path !== watchedPath) return result;
        internals.__watcherRefreshCalls! += 1;
        if (!internals.__watcherDelayFirstListing) return result;
        internals.__watcherDelayFirstListing = false;
        return new Promise((resolve, reject) => {
          setTimeout(() => result.then(resolve, reject), 1500);
        });
      };
    }, scratchDir);

    fs.writeFileSync(path.join(scratchDir, "burst-one.txt"), "one\n");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          (window as unknown as { __TAURI_INTERNALS__: { __watcherRefreshCalls?: number } })
            .__TAURI_INTERNALS__.__watcherRefreshCalls ?? 0,
        )) >= 1,
      { timeoutMsg: "first watcher refresh never started" },
    );

    // Space writes beyond Rust's trailing debounce so they become separate
    // native watcher events, but keep them within the delayed frontend listing.
    fs.writeFileSync(path.join(scratchDir, "burst-two.txt"), "two\n");
    await browser.pause(500);
    fs.writeFileSync(path.join(scratchDir, "burst-three.txt"), "three\n");

    await browser.waitUntil(
      async () => (await entryNames()).includes("burst-three.txt"),
      { timeout: 25_000, timeoutMsg: "trailing watcher refresh never surfaced the burst" },
    );
    await browser.pause(3000);
    const refreshCalls = await browser.execute(
      () =>
        (window as unknown as { __TAURI_INTERNALS__: { __watcherRefreshCalls?: number } })
          .__TAURI_INTERNALS__.__watcherRefreshCalls ?? 0,
    );
    expect(refreshCalls).toBe(2);

    await browser.execute(() => {
      type Internals = {
        invoke: unknown;
        __watcherOriginalInvoke?: unknown;
      };
      const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
      if (internals.__watcherOriginalInvoke) internals.invoke = internals.__watcherOriginalInvoke;
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

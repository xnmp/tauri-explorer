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

  it("backs off real watcher refreshes after a slow listing then restores normal cadence", async () => {
    await navigateTo(scratchDir);

    // This is intentionally installed below the browser-facing Tauri invoke
    // bridge, not at the refresh manager: Node writes still travel through the
    // real Rust notify watcher, the production event listener, and pane refresh.
    // The first watcher refresh establishes a healthy baseline; the second is
    // slow; the third is healthy again.
    await browser.execute((watchedPath: string) => {
      type Internals = {
        invoke: (command: string, args?: { path?: string }, options?: unknown) => Promise<unknown>;
        __adaptiveOriginalInvoke?: Internals["invoke"];
        __adaptiveRefreshStarts?: number[];
        __adaptiveDelays?: number[];
      };
      const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
      internals.__adaptiveOriginalInvoke = internals.invoke;
      internals.__adaptiveRefreshStarts = [];
      internals.__adaptiveDelays = [100, 3000, 100, 0];
      internals.invoke = (command, args, options) => {
        const result = internals.__adaptiveOriginalInvoke!(command, args, options);
        if (command !== "start_streaming_directory" || args?.path !== watchedPath) return result;
        const starts = internals.__adaptiveRefreshStarts!;
        const delay = internals.__adaptiveDelays![starts.length] ?? 0;
        starts.push(performance.now());
        return new Promise((resolve, reject) => {
          setTimeout(() => result.then(resolve, reject), delay);
        });
      };
    }, scratchDir);

    fs.writeFileSync(path.join(scratchDir, "adaptive-baseline.txt"), "baseline\n");
    await browser.waitUntil(
      async () => (await entryNames()).includes("adaptive-baseline.txt"),
      { timeout: 25_000, timeoutMsg: "healthy baseline watcher refresh never completed" },
    );

    fs.writeFileSync(path.join(scratchDir, "adaptive-slow.txt"), "slow\n");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() =>
          (window as unknown as { __TAURI_INTERNALS__: { __adaptiveRefreshStarts?: number[] } })
            .__TAURI_INTERNALS__.__adaptiveRefreshStarts?.length ?? 0,
        )) >= 2,
      { timeoutMsg: "slow watcher refresh never started" },
    );

    // This separate native event arrives while the delayed second listing is
    // in flight. A fixed two-second cadence would start a third listing soon
    // after the slow result lands; adaptive backoff must keep it pending.
    await browser.pause(500);
    fs.writeFileSync(path.join(scratchDir, "adaptive-deferred.txt"), "deferred\n");
    await browser.pause(3500);
    const callsBeforeBackoffExpires = await browser.execute(
      () =>
        (window as unknown as { __TAURI_INTERNALS__: { __adaptiveRefreshStarts?: number[] } })
          .__TAURI_INTERNALS__.__adaptiveRefreshStarts?.length ?? 0,
    );
    expect(callsBeforeBackoffExpires).toBe(2);

    await browser.waitUntil(
      async () => (await entryNames()).includes("adaptive-deferred.txt"),
      { timeout: 25_000, timeoutMsg: "adaptive trailing watcher refresh never completed" },
    );
    const startsAfterBackoff = await browser.execute(
      () =>
        (window as unknown as { __TAURI_INTERNALS__: { __adaptiveRefreshStarts?: number[] } })
          .__TAURI_INTERNALS__.__adaptiveRefreshStarts ?? [],
    );
    expect(startsAfterBackoff).toHaveLength(3);
    // The capped adaptive delay is eight seconds from the slow listing start;
    // generous headroom still distinguishes it from the normal two seconds.
    expect(startsAfterBackoff[2] - startsAfterBackoff[1]).toBeGreaterThan(6500);

    fs.writeFileSync(path.join(scratchDir, "adaptive-recovered.txt"), "recovered\n");
    await browser.waitUntil(
      async () => (await entryNames()).includes("adaptive-recovered.txt"),
      { timeout: 25_000, timeoutMsg: "healthy watcher refresh never recovered normal cadence" },
    );
    const recoveredStarts = await browser.execute(
      () =>
        (window as unknown as { __TAURI_INTERNALS__: { __adaptiveRefreshStarts?: number[] } })
          .__TAURI_INTERNALS__.__adaptiveRefreshStarts ?? [],
    );
    expect(recoveredStarts).toHaveLength(4);
    expect(recoveredStarts[3] - recoveredStarts[2]).toBeLessThan(4000);

    await browser.execute(() => {
      type Internals = { invoke: unknown; __adaptiveOriginalInvoke?: unknown };
      const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
      if (internals.__adaptiveOriginalInvoke) internals.invoke = internals.__adaptiveOriginalInvoke;
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

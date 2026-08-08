/**
 * Real watcher-to-pane regression for adaptive refresh cadence. The probe only
 * delays the WebView-side completion of real listing IPC, while filesystem
 * writes still travel through Rust notify and the production watcher listener.
 */
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";

type ProbeWindow = Window & {
  __TAURI_INTERNALS__: { invoke: (...args: unknown[]) => Promise<unknown> };
  __adaptiveWatcherProbe?: {
    calls: () => number;
    starts: () => number[];
    restore: () => void;
  };
};

const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-watch-adaptive-"));

async function calls(): Promise<number> {
  return await browser.execute(() => (window as ProbeWindow).__adaptiveWatcherProbe?.calls() ?? -1);
}

async function starts(): Promise<number[]> {
  return await browser.execute(() => (window as ProbeWindow).__adaptiveWatcherProbe?.starts() ?? []);
}

describe("adaptive filesystem watcher refresh", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "existing.txt"), "ready\n");
  });

  after(async () => {
    await browser.execute(() => (window as ProbeWindow).__adaptiveWatcherProbe?.restore());
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("backs off a real slow watcher listing and returns to normal cadence after recovery", async () => {
    await navigateTo(scratchDir);

    await browser.execute((targetPath: string) => {
      const testWindow = window as ProbeWindow;
      const internals = testWindow.__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      const delays = [100, 3000, 100, 0];
      const listingStarts: number[] = [];

      internals.invoke = async (...args: unknown[]) => {
        const [command, payload] = args;
        const isTargetListing =
          command === "start_streaming_directory" &&
          (payload as { path?: string } | undefined)?.path === targetPath;
        if (!isTargetListing) return originalInvoke(...args);

        const delay = delays[listingStarts.length] ?? 0;
        listingStarts.push(performance.now());
        const result = await originalInvoke(...args);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return result;
      };

      testWindow.__adaptiveWatcherProbe = {
        calls: () => listingStarts.length,
        starts: () => [...listingStarts],
        restore: () => {
          internals.invoke = originalInvoke;
          delete testWindow.__adaptiveWatcherProbe;
        },
      };
    }, scratchDir);

    // The first real watcher refresh is healthy, establishing a baseline.
    fs.writeFileSync(path.join(scratchDir, "baseline.txt"), "baseline\n");
    await browser.waitUntil(async () => (await entryNames()).includes("baseline.txt"), {
      timeout: 25_000,
      timeoutMsg: "healthy baseline watcher listing never completed",
    });
    expect(await calls()).toBe(1);

    // The second real watcher listing is delayed 3s. A third native event
    // arrives while it is in flight and must wait beyond the normal 2s gate.
    fs.writeFileSync(path.join(scratchDir, "slow.txt"), "slow\n");
    await browser.waitUntil(async () => (await calls()) === 2, {
      timeout: 10_000,
      timeoutMsg: "slow watcher listing never started",
    });
    await browser.pause(500);
    fs.writeFileSync(path.join(scratchDir, "deferred.txt"), "deferred\n");
    await browser.pause(3500);
    expect(await calls()).toBe(2);

    await browser.waitUntil(async () => (await entryNames()).includes("deferred.txt"), {
      timeout: 25_000,
      timeoutMsg: "adaptive trailing watcher listing never completed",
    });
    const delayedStarts = await starts();
    expect(delayedStarts).toHaveLength(3);
    expect(delayedStarts[2] - delayedStarts[1]).toBeGreaterThan(6500);

    // The third listing is healthy. The next real watcher event must regain
    // normal cadence rather than retaining the preceding slow-listing delay.
    fs.writeFileSync(path.join(scratchDir, "recovered.txt"), "recovered\n");
    await browser.waitUntil(async () => (await entryNames()).includes("recovered.txt"), {
      timeout: 25_000,
      timeoutMsg: "healthy watcher listing never restored normal cadence",
    });
    const recoveredStarts = await starts();
    expect(recoveredStarts).toHaveLength(4);
    expect(recoveredStarts[3] - recoveredStarts[2]).toBeLessThan(4000);
  });
});

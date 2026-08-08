/**
 * Real-backend regression for watcher events received while a directory
 * listing is in flight. The probe delays the first real listing IPC response;
 * filesystem writes still travel through notify and Tauri's directory-changed
 * event before reaching useFileWatchers.
 */
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo } from "./helpers";

type ProbeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (...args: unknown[]) => Promise<unknown>;
  };
  __watcherRefreshProbe?: {
    count: () => number;
    restore: () => void;
  };
};

const scratchDir = fs.mkdtempSync(
  path.join(os.homedir(), ".tauri-explorer-e2e-watch-coalesce-"),
);

async function listingCalls(): Promise<number> {
  return await browser.execute(() => {
    return (window as ProbeWindow).__watcherRefreshProbe?.count() ?? -1;
  });
}

describe("filesystem watcher refresh coalescing", () => {
  before(() => {
    fs.writeFileSync(path.join(scratchDir, "existing.txt"), "ready\n");
  });

  after(async () => {
    await browser.execute(() => {
      (window as ProbeWindow).__watcherRefreshProbe?.restore();
    });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("runs one trailing listing after repeated events during a slow listing", async () => {
    await navigateTo(scratchDir);

    await browser.execute((targetPath: string) => {
      const testWindow = window as ProbeWindow;
      const internals = testWindow.__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke;
      let count = 0;

      internals.invoke = async (...args: unknown[]) => {
        const [command, payload] = args;
        const isTargetListing =
          command === "start_streaming_directory" &&
          (payload as { path?: string } | undefined)?.path === targetPath;
        if (!isTargetListing) return originalInvoke(...args);

        count += 1;
        const result = await originalInvoke(...args);
        if (count === 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        return result;
      };

      testWindow.__watcherRefreshProbe = {
        count: () => count,
        restore: () => {
          internals.invoke = originalInvoke;
          delete testWindow.__watcherRefreshProbe;
        },
      };
    }, scratchDir);

    fs.writeFileSync(path.join(scratchDir, "event-1.txt"), "one\n");
    await browser.waitUntil(async () => (await listingCalls()) === 1, {
      timeout: 10_000,
      timeoutMsg: "the first watcher-triggered listing never started",
    });

    // Each write is farther apart than the backend's 300ms watcher debounce,
    // so these are distinct real Tauri events, all inside the held listing.
    for (let event = 2; event <= 4; event += 1) {
      fs.writeFileSync(path.join(scratchDir, `event-${event}.txt`), `${event}\n`);
      await browser.pause(800);
    }
    expect(await listingCalls()).toBe(1);

    await browser.waitUntil(async () => (await listingCalls()) >= 2, {
      timeout: 10_000,
      timeoutMsg: "the trailing watcher listing never started",
    });
    await browser.pause(2500);
    expect(await listingCalls()).toBe(2);
  });
});

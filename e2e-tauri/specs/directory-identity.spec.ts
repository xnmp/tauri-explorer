/**
 * Native directory identity (#799, ledger gate 7).
 *
 * The backend resolves each requested directory to one native spelling, and
 * the pane, its listing, its watch lease and every change event carry that
 * spelling. On Windows, separator, case and trailing-separator variants name
 * one NTFS directory, so each variant must give one pane identity, one listing
 * and one shared native watch registration. Linux folds only separators: two
 * names that differ in case are two directories, with two listings and two
 * watches.
 */
import { browser } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { exactApplicationPid } from "../native-process";
import {
  inotifyWatchesForPath,
  nativeProcessIdentity,
  type NativeProcessIdentity,
} from "../native-resources";
import { navigateTo } from "./helpers";

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

type DirectoryWatchLease = { id: string; path: string };
type WatcherReceipts = Record<string, { observedAt: number | null }>;

/** Spellings the platform resolves to `directory` itself. */
function spellingsOf(directory: string): string[] {
  if (isWindows) {
    return [
      directory,
      `${directory.toLowerCase().replace(/\\/g, "/")}/`,
      `${directory.toUpperCase()}\\`,
    ];
  }
  return [
    directory,
    `${directory}/`,
    `${path.dirname(directory)}//${path.basename(directory)}//`,
  ];
}

/** Separator- and trailing-insensitive; case-insensitive only on Windows. */
function sameDirectory(left: string, right: string): boolean {
  const key = (spelling: string) => {
    const folded = spelling.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
    return isWindows ? folded.toLowerCase() : folded;
  };
  return key(left) === key(right);
}

async function operation(op: string, target: string): Promise<unknown> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op, target });
  let response: { token?: string; result?: unknown; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() =>
      JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 25_000, timeoutMsg: `${op} did not finish for ${target}` });
  expect(response.error).toBeUndefined();
  return response.result;
}

/** Entry paths of the active pane. A restored split marks its active pane. */
async function listedPaths(): Promise<string[]> {
  const paths = await browser.execute(() => {
    const pane = document.querySelector(".explorer-pane.active")
      ?? document.querySelector(".explorer-pane");
    return Array.from(
      pane?.querySelectorAll<HTMLElement>(".entry-item[data-path]") ?? [],
      (entry) => entry.dataset.path ?? "",
    );
  });
  return paths.sort();
}

async function waitForDirectoryWatch(directory: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((target) => {
    const data = document.documentElement.dataset;
    const ready: string[] = JSON.parse(data.e2eReadyDirectoryWatches ?? "[]");
    return data.e2eDirectoryWatcherListenerReady === "true" && ready.includes(target);
  }, directory), { timeout: 20_000, timeoutMsg: `pane watch was not acknowledged for ${directory}` });
}

async function receipts(): Promise<WatcherReceipts> {
  return await browser.execute(() =>
    JSON.parse(document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}"));
}

/** Every spelling that change events have attributed to `directory`. */
async function attributedSpellings(directory: string): Promise<string[]> {
  return Object.keys(await receipts()).filter((spelling) => sameDirectory(spelling, directory));
}

/**
 * Write `marker` and require both a watcher receipt for `directory` observed
 * no earlier than the write and the marker in the active pane's listing.
 */
async function waitForObservedWrite(directory: string, marker: string): Promise<void> {
  const startedAt = Date.now();
  const written = path.join(directory, marker);
  fs.writeFileSync(written, marker);
  await browser.waitUntil(async () => {
    const observedAt = (await receipts())[directory]?.observedAt;
    return observedAt != null && observedAt >= startedAt;
  }, { timeout: 25_000, timeoutMsg: `no watcher receipt for ${directory} after writing ${marker}` });
  await browser.waitUntil(async () => (await listedPaths()).includes(written), {
    timeout: 25_000,
    timeoutMsg: `the pane did not refresh to list ${written}`,
  });
}

function watchesOn(application: NativeProcessIdentity, directory: string): number {
  return inotifyWatchesForPath(application, directory).length;
}

describe("native directory identity", () => {
  it("gives every spelling of one directory one pane identity, listing and watch", async function () {
    this.timeout(180_000);
    const directory = path.join(createNativeFixtureDirectory("directory-identity-"), "Dir");
    fs.mkdirSync(directory);
    const listed = ["alpha.txt", "beta.txt"].map((name) => path.join(directory, name));
    for (const file of listed) fs.writeFileSync(file, path.basename(file));

    for (const [index, spelling] of spellingsOf(directory).entries()) {
      await navigateTo(spelling, directory);
      await waitForDirectoryWatch(directory);
      expect(await listedPaths()).toEqual([...listed].sort());
      // The lease this navigation took is the one the pane refreshes through.
      const marker = `observed-through-spelling-${index + 1}.txt`;
      await waitForObservedWrite(directory, marker);
      listed.push(path.join(directory, marker));
    }
    expect(await attributedSpellings(directory)).toEqual([directory]);
  });

  it("shares one native registration among the leases of every spelling", async function () {
    this.timeout(180_000);
    const directory = path.join(createNativeFixtureDirectory("directory-identity-shared-"), "Dir");
    fs.mkdirSync(directory);
    await navigateTo(directory);
    await waitForDirectoryWatch(directory);
    const application = isLinux ? nativeProcessIdentity(exactApplicationPid()) : undefined;

    const leases: DirectoryWatchLease[] = [];
    for (const spelling of spellingsOf(directory)) {
      const lease = await operation("directory-watch-acquire", spelling) as DirectoryWatchLease;
      expect(lease.path).toBe(directory);
      leases.push(lease);
    }
    if (application) expect(watchesOn(application, directory)).toBe(1);

    // A second native registration would attribute the same write to a second
    // spelling. Each receipt is flushed at least one debounce window after its
    // write, so once the later write's receipt arrives, every earlier write's
    // receipts have been delivered.
    await waitForObservedWrite(directory, "shared-first.txt");
    await waitForObservedWrite(directory, "shared-second.txt");
    expect(await attributedSpellings(directory)).toEqual([directory]);

    // Retiring the other spellings must not retire the pane's registration.
    for (const lease of leases) await operation("directory-watch-release", lease.id);
    if (application) expect(watchesOn(application, directory)).toBe(1);
    await waitForObservedWrite(directory, "after-release.txt");
    expect(await attributedSpellings(directory)).toEqual([directory]);
    if (isWindows) {
      // Keep the visible result from the real WebView2 watcher run for issue acceptance.
      await browser.saveScreenshot(path.resolve(
        "e2e-tauri", "logs", "directory-identity-after-release.png",
      ));
    }
  });

  it("keeps Linux directories that differ only in case distinct", async function () {
    if (!isLinux) this.skip();
    this.timeout(180_000);
    const root = createNativeFixtureDirectory("directory-identity-case-");
    const upper = path.join(root, "Case");
    const lower = path.join(root, "case");
    fs.mkdirSync(upper);
    fs.mkdirSync(lower);
    fs.writeFileSync(path.join(upper, "upper.txt"), "upper");
    fs.writeFileSync(path.join(lower, "lower.txt"), "lower");

    await navigateTo(lower);
    await waitForDirectoryWatch(lower);
    expect(await listedPaths()).toEqual([path.join(lower, "lower.txt")]);
    await navigateTo(upper);
    await waitForDirectoryWatch(upper);
    expect(await listedPaths()).toEqual([path.join(upper, "upper.txt")]);

    const lowerLease = await operation("directory-watch-acquire", lower) as DirectoryWatchLease;
    expect(lowerLease.path).toBe(lower);
    const application = nativeProcessIdentity(exactApplicationPid());
    expect(watchesOn(application, upper)).toBe(1);
    expect(watchesOn(application, lower)).toBe(1);

    // A write to one directory is attributed to it alone and does not appear
    // in the pane showing the other.
    const startedAt = Date.now();
    const lowerMarker = path.join(lower, "only-lower.txt");
    fs.writeFileSync(lowerMarker, "lower");
    await browser.waitUntil(async () => {
      const observedAt = (await receipts())[lower]?.observedAt;
      return observedAt != null && observedAt >= startedAt;
    }, { timeout: 25_000, timeoutMsg: `no watcher receipt for ${lower}` });
    await waitForObservedWrite(upper, "only-upper.txt");
    expect(await listedPaths()).toEqual(
      [path.join(upper, "only-upper.txt"), path.join(upper, "upper.txt")].sort(),
    );
    expect(await attributedSpellings(upper)).toEqual([upper]);
    expect(await attributedSpellings(lower)).toEqual([lower]);

    await operation("directory-watch-release", lowerLease.id);
    expect(watchesOn(application, lower)).toBe(0);
    expect(watchesOn(application, upper)).toBe(1);
    await navigateTo(lower);
    expect(await listedPaths()).toEqual([lowerMarker, path.join(lower, "lower.txt")].sort());
  });
});

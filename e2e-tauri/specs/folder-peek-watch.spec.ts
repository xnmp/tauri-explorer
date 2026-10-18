/** Real nonrecursive leases, cross-level native admission, and cap fallback. */
import { browser, $ } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, entryPathSelector, waitForGitWatch } from "./helpers";
import { exactApplicationPid } from "../native-process";
import { inotifyWatchesForPath, nativeProcessIdentity } from "../native-resources";

const root = createNativeFixtureDirectory("folder-peek-");
const folders = Array.from({ length: 17 }, (_, index) => path.join(root, `folder-${String(index).padStart(2, "0")}`));
const nested = path.join(folders[0], "nested");
const unopened = path.join(root, "unopened-control");
interface Snapshot { expanded: string[]; entries: string[]; watches: { path: string; ready: boolean; lease: { id: string; path: string } | null }[] }
async function peek<T = unknown>(op: string, target?: string, paths?: string[]): Promise<T> {
  await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.e2eHooksReady === "true"), { timeout: 20_000, timeoutMsg: "folder-peek hooks were not ready" });
  const token = crypto.randomUUID();
  await browser.execute(detail => window.dispatchEvent(new CustomEvent("e2e-folder-peek", { detail })), { token, op, path: target, paths });
  let reply: { token?: string; result?: T; error?: string } = {};
  await browser.waitUntil(async () => {
    reply = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eFolderPeekResult ?? "{}"));
    return reply.token === token;
  }, { timeout: 20_000, timeoutMsg: `peek ${op} did not acknowledge ${target ?? ""}` });
  if (reply.error) throw new Error(reply.error);
  return reply.result as T;
}
const snapshot = () => peek<Snapshot>("snapshot");
async function waitForEntry(file: string, present = true) {
  await browser.waitUntil(async () => (await snapshot()).entries.includes(file) === present, { timeout: 20_000, timeoutMsg: `expected ${file} ${present ? "visible" : "removed"}` });
}
async function receipt(directory: string, startedAt: number) {
  await browser.waitUntil(() => browser.execute((target, after) => {
    const receipts = JSON.parse(document.documentElement.dataset.e2eDirectoryWatcherReceipts ?? "{}");
    return (receipts[target]?.observedAt ?? 0) >= after;
  }, directory, startedAt), { timeout: 15_000, timeoutMsg: `no causal native receipt for ${directory}` });
}

function verifyPrivateNativeEnvironment() {
  if (process.platform !== "linux") return;
  const pid = exactApplicationPid();
  const environment = (id: number) => Object.fromEntries(fs.readFileSync(`/proc/${id}/environ`, "utf8").split("\0").filter(value => value.includes("=")).map(value => { const i = value.indexOf("="); return [value.slice(0, i), value.slice(i + 1)]; }));
  const app = environment(pid);
  for (const key of ["DISPLAY", "GDK_BACKEND", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[key]) expect(app[key]).toBe(process.env[key]);
  }
  expect(app.WAYLAND_DISPLAY).toBeUndefined();
  const verified: { pid: number; process: string; display: string }[] = [];
  for (const id of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value))) {
    try {
      const name = fs.readFileSync(`/proc/${id}/comm`, "utf8").trim();
      if (!/^(?:WebKit|tauri-driver)/.test(name)) continue;
      const env = environment(Number(id));
      if (env.DBUS_SESSION_BUS_ADDRESS !== app.DBUS_SESSION_BUS_ADDRESS) continue;
      expect(env.DISPLAY).toBe(app.DISPLAY);
      expect(env.WAYLAND_DISPLAY).toBeUndefined();
      verified.push({ pid: Number(id), process: name, display: env.DISPLAY });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  expect(verified.some(record => record.process.startsWith("WebKit"))).toBe(true);
  expect(verified.some(record => record.process === "tauri-driver")).toBe(true);
  console.log("Folder peek native private-display admission:", JSON.stringify({ pid, display: app.DISPLAY, helpers: verified }));
}

describe("folder peek native observation", () => {
  before(async () => {
    verifyPrivateNativeEnvironment();
    fs.mkdirSync(unopened);
    for (const folder of folders) fs.mkdirSync(folder);
    fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, "initial.txt"), "initial");
    execFileSync("git", ["init", "-q", nested]);
    expect(await peek("enable-git-status")).toBe(true);
  });
  after(async () => { await peek("collapse"); await navigateTo(root); });

  it("keeps newest 16 leases, updates nested rows after ancestor release, and refreshes overflow", async () => {
    await navigateTo(root); await peek("details");
    for (const folder of folders) await peek("toggle", folder);
    await waitForEntry(nested);
    await peek("toggle", nested);
    await waitForEntry(path.join(nested, "initial.txt"));
    await browser.waitUntil(async () => {
      const slots = (await snapshot()).watches;
      return slots.length === 18 && slots.every(slot => slot.ready) && slots.filter(slot => slot.lease).length === 16 && !!slots.find(slot => slot.path === nested)?.lease;
    }, { timeout: 20_000, timeoutMsg: "16 live native peek leases did not settle" });
    const slots = (await snapshot()).watches;
    expect(slots.find(slot => slot.path === folders[0])?.lease).toBeNull();
    expect(slots.find(slot => slot.path === folders[16])?.lease).not.toBeNull();
    let direct = new Set<number>();
    if (process.platform === "linux") {
      const application = nativeProcessIdentity(exactApplicationPid());
      // Recursive search-cache coverage and the nested Git root's parent
      // observer legitimately retain incidental watches. Identify the shared
      // direct-directory observer using a watched folder and an unwatched
      // control, then verify retirement on that exact observer.
      const incidental = new Set(inotifyWatchesForPath(application, unopened).map(watch => watch.fd));
      direct = new Set(inotifyWatchesForPath(application, folders[16]).filter(watch => !incidental.has(watch.fd)).map(watch => watch.fd));
      expect(direct.size).toBeGreaterThan(0);
      // folder-00 remains the replacement guard for its observed nested
      // child. folder-01 is an independently evicted leaf with no such owner.
      expect(inotifyWatchesForPath(application, folders[1]).filter(watch => direct.has(watch.fd))).toHaveLength(0);
      expect(inotifyWatchesForPath(application, nested).filter(watch => direct.has(watch.fd)).length).toBeGreaterThan(0);
    }
    // Staging changes only .git; unchanged directory entries still need a
    // repository observer to revalidate the child's badge.
    await waitForGitWatch(nested);
    execFileSync("git", ["-C", nested, "add", "initial.txt"]);
    await browser.waitUntil(() => $(entryPathSelector(path.join(nested, "initial.txt")) + " .git-added").isExisting(), { timeout: 15_000, timeoutMsg: "nested Git badge did not follow an index-only change" });
    const created = path.join(nested, "created.txt");
    const startedAt = Date.now(); fs.writeFileSync(created, "created");
    await receipt(nested, startedAt); await waitForEntry(created);
    const deletedAt = Date.now(); fs.unlinkSync(created);
    await receipt(nested, deletedAt); await waitForEntry(created, false);
    const overflow = path.join(folders[0], "overflow.txt"); fs.writeFileSync(overflow, "overflow");
    await peek("refresh"); await waitForEntry(overflow);
    // Use an evicted leaf without the nested child's parent guard. No own
    // lease does not preclude an ancestor notification refreshing this peek.
    expect((await snapshot()).watches.find(slot => slot.path === folders[1])?.lease).toBeNull();
    const ancestorRefreshed = path.join(folders[1], "ancestor-refresh.txt");
    const changedAt = Date.now(); fs.writeFileSync(ancestorRefreshed, "ancestor refresh");
    // Windows reports the child's directory metadata change to the root.
    // Touch it explicitly so Linux exercises that same real watcher path.
    const touchedAt = new Date(fs.statSync(folders[1]).mtimeMs + 1_000);
    fs.utimesSync(folders[1], touchedAt, touchedAt);
    await receipt(root, changedAt);
    await waitForEntry(ancestorRefreshed);
    await $(entryPathSelector(ancestorRefreshed)).waitForDisplayed({ timeout: 10_000 });
    const parentDeletedAt = Date.now(); fs.rmSync(folders[16], { recursive: true });
    await receipt(root, parentDeletedAt); await waitForEntry(folders[16], false);
    expect((await snapshot()).expanded).not.toContain(folders[16]);
    await peek("collapse");
    if (process.platform === "linux") {
      const application = nativeProcessIdentity(exactApplicationPid());
      await browser.waitUntil(() => inotifyWatchesForPath(application, nested).filter(watch => direct.has(watch.fd)).length === 0
        && inotifyWatchesForPath(application, folders[0]).filter(watch => direct.has(watch.fd)).length === 0,
      { timeout: 10_000, timeoutMsg: "retired direct nested watches were retained" });
    }
  });

  it("rejects held responses after collapse/reopen and reduces native ancestor batches", async () => {
    await peek("collapse");
    await browser.execute(targetPath => window.dispatchEvent(new CustomEvent("e2e-directory-listing-probe", { detail: { targetPath, delays: [700, 0] } })), folders[2]);
    await peek("toggle", folders[2]);
    await browser.waitUntil(() => browser.execute(() => JSON.parse(document.documentElement.dataset.e2eDirectoryListingProbe ?? "{}").calls >= 1), { timeout: 10_000 });
    const oldLease = (await snapshot()).watches.find(slot => slot.path === folders[2])?.lease?.id;
    await peek("toggle", folders[2]); await peek("toggle", folders[2]);
    await browser.waitUntil(async () => {
      const slot = (await snapshot()).watches.find(slot => slot.path === folders[2]);
      return !!slot?.ready && !!slot.lease && slot.lease.id !== oldLease;
    }, { timeout: 10_000, timeoutMsg: "reopened watch did not acquire a fresh native lease" });
    const late = path.join(folders[2], "after-reopen.txt"); const startedAt = Date.now(); fs.writeFileSync(late, "new");
    await receipt(folders[2], startedAt); await waitForEntry(late);
    const slots = (await snapshot()).watches;
    expect(slots.filter(slot => slot.path === folders[2] && slot.lease)).toHaveLength(1);
    await peek("toggle", folders[0]); await waitForEntry(nested);
    expect(await peek("copy", undefined, [folders[0], nested])).toEqual([folders[0]]);
    expect(await peek("delete", undefined, [folders[0], nested])).toBeNull();
    expect(fs.existsSync(folders[0])).toBe(false);
    await waitForEntry(folders[0], false);
    expect((await snapshot()).expanded.some(value => value === folders[0] || value.startsWith(folders[0] + path.sep))).toBe(false);
  });
});

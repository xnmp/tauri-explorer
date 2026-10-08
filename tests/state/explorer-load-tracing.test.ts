/**
 * Explorer navigations own their slow-load traces (#1022): every exit settles
 * the trace, a superseded or destroyed load cannot linger in the watchdog,
 * and an auto-enter descent is attributed to the folder actually listed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";

type LoadFn = (path: string) => Promise<DirectoryListingResult>;
const { loadImpl, fetchImpl, recordSlowLoad } = vi.hoisted(() => ({
  loadImpl: { current: (() => new Promise(() => {})) as LoadFn },
  fetchImpl: { current: (async () => ({ ok: false, error: "unset" })) as (path: string) => Promise<unknown> },
  recordSlowLoad: vi.fn(async (_record: unknown) => {}),
}));

vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({
    load: (path: string) => loadImpl.current(path),
    cleanup: async () => {},
  }),
}));
vi.mock("$lib/api/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/files")>()),
  fetchDirectory: (path: string) => fetchImpl.current(path),
}));
vi.mock("$lib/api/load-diagnostics", () => ({ recordSlowLoad, recentSlowLoads: async () => [] }));

import { createExplorerState } from "$lib/state/explorer.svelte";
import { loadWatchdog } from "$lib/state/load-watchdog";
import { settingsStore } from "$lib/state/settings.svelte";

const dir = (name: string, parent: string): FileEntry => ({
  name, path: `${parent}/${name}`, kind: "directory", size: 0, modified: "2026-01-01T00:00:00Z",
});
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tracedPaths = () => loadWatchdog.inFlight().map((trace) => trace.path);

beforeEach(() => {
  localStorage.clear();
  settingsStore.reset();
  recordSlowLoad.mockClear();
  loadImpl.current = () => new Promise(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  settingsStore.reset();
});

describe("explorer slow-load traces", () => {
  it("settles a navigation stuck behind a hung listing once a newer one supersedes it", async () => {
    const explorer = createExplorerState();
    void explorer.navigateTo("/hung", { autoEnterSingleSubdir: false });
    void explorer.navigateTo("/second", { autoEnterSingleSubdir: false });
    await flush();
    expect(tracedPaths()).toEqual(["/second"]);
    void explorer.navigateTo("/third", { autoEnterSingleSubdir: false });
    await flush();
    expect(tracedPaths()).toEqual(["/third"]);
    // Teardown waits for the hung listing; the trace settles before that.
    void explorer.destroy();
    expect(tracedPaths()).toEqual([]);
  });

  it("settles the trace when the auto-enter descent throws", async () => {
    settingsStore.update({ autoEnterSingleSubdir: true });
    fetchImpl.current = async () => { throw new Error("malformed provider listing"); };
    const explorer = createExplorerState();
    await expect(explorer.navigateTo("/root")).rejects.toThrow("malformed provider listing");
    expect(tracedPaths()).toEqual([]);
    void explorer.destroy();
  });

  it("attributes a stuck load to the folder auto-enter descended into", async () => {
    vi.useFakeTimers();
    settingsStore.update({ autoEnterSingleSubdir: true });
    fetchImpl.current = async (path) => path === "/local"
      ? { ok: true, data: { path, entries: [dir("remote", "/local")] } }
      : { ok: true, data: { path, entries: [dir("a", path), dir("b", path)] } };
    const explorer = createExplorerState();
    void explorer.navigateTo("/local");
    await vi.advanceTimersByTimeAsync(5000);
    expect(recordSlowLoad).toHaveBeenCalledTimes(1);
    expect(recordSlowLoad.mock.calls[0][0]).toMatchObject({
      path: "/local/remote",
      requestedPath: "/local",
      outcome: "pending",
      // The listing seam is mocked here, so no later phase is entered.
      pendingPhase: "auto-enter",
    });
    void explorer.destroy();
  });
});

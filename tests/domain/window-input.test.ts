import { describe, expect, it } from "vitest";
import {
  DIRECTORY_SEED_MAX_ENTRIES, normalizeDirectorySeed, normalizeLaunchData,
  normalizeWarmActivation, directorySeedFitsBudget, windowSeedFitsBudget, WINDOW_SEED_MAX_CHARS,
} from "$lib/domain/window-input";
import { normalizeSnapshot } from "$lib/state/window-tabs-persistence";

const now = 100_000;
const entry = { name: "file.txt", path: "/root/file.txt", kind: "file", size: 3, modified: "2026-09-06T00:00:00Z" };
const seed = { ts: now, currentPath: "/root", entries: [entry], sortBy: "name", sortAscending: true, viewMode: "details" };

describe("external directory seeds", () => {
  it("copies valid entries and retains presentation plus symlink/Git decorations", () => {
    const decorated = { ...entry, is_symlink: true, symlink_target: "/elsewhere", is_git_repo: false, is_empty: false };
    const result = normalizeDirectorySeed({ ...seed, entries: [decorated] }, "/root", now)!;
    expect(result.entries).toEqual([decorated]);
    expect(result.viewMode).toBe("details");
    decorated.name = "changed";
    expect(result.entries[0].name).toBe("file.txt");
  });

  it.each([null, {}, { ...seed, ts: now + 1 }, { ...seed, ts: now - 5_000 },
    { ...seed, ts: Infinity }, { ...seed, currentPath: "/other" },
    { ...seed, entries: [null] }, { ...seed, entries: [entry, entry] },
    { ...seed, entries: [{ ...entry, path: "/other/file.txt" }] },
    { ...seed, entries: [{ ...entry, size: NaN }] },
    { ...seed, entries: [{ ...entry, is_symlink: "yes" }] },
    { ...seed, sortBy: { toString: () => "name" } },
    { ...seed, entries: new Array(DIRECTORY_SEED_MAX_ENTRIES + 1) },
  ])("rejects an invalid optional listing", (raw) => {
    expect(normalizeDirectorySeed(raw, "/root", now)).toBeNull();
  });

  it("accepts empty directories and native Windows paths without rewriting them", () => {
    expect(normalizeDirectorySeed({ ...seed, entries: [] }, "/root", now)?.entries).toEqual([]);
    const path = "C:\\Users\\Test";
    const native = { ...entry, path: `${path}\\file.txt` };
    expect(normalizeDirectorySeed({ ...seed, currentPath: path, entries: [native] }, path, now)?.entries).toEqual([native]);
  });

  it("preserves literal backslashes in Unix filenames", () => {
    const unix = { ...entry, name: "a\\b", path: "/root/a\\b" };
    expect(normalizeDirectorySeed({ ...seed, entries: [unix] }, "/root", now)?.entries).toEqual([unix]);
  });

  it("bounds seed production before JSON serialization", () => {
    const valid = normalizeDirectorySeed(seed, "/root", now)!;
    expect(directorySeedFitsBudget(valid)).toBe(true);
    expect(directorySeedFitsBudget({ ...valid, entries: new Array(DIRECTORY_SEED_MAX_ENTRIES + 1) })).toBe(false);
    expect(directorySeedFitsBudget({ ...valid, currentPath: "x".repeat(1_048_576) })).toBe(false);
  });
});

describe("window activation and launch", () => {
  it("accepts valid physical geometry and copies only supported fields", () => {
    expect(normalizeWarmActivation({ path: "/root", x: -100, y: 0, width: 1920, height: 1080, viewMode: "tiles", extra: {} }))
      .toEqual({ path: "/root", x: -100, y: 0, width: 1920, height: 1080, viewMode: "tiles" });
  });
  it.each([null, {}, { path: "" }, { path: "a\0b" }, { path: "/root", x: NaN, y: 0 },
    { path: "/root", width: -1, height: 1 }, { path: "/root", x: 0 },
    { path: "/root", width: 1 }, { path: "/root", viewMode: "bad" },
  ])("rejects malformed activation", (raw) => expect(normalizeWarmActivation(raw)).toBeNull());
  it("ignores malformed launch fields independently", () => {
    expect(normalizeLaunchData(null)).toEqual({});
    expect(normalizeLaunchData({ home: "/home/user", cwd: 42 })).toEqual({ home: "/home/user" });
  });
  it("normalizes legacy snapshots without promoting a malformed right-hand path", () => {
    expect(normalizeSnapshot({ leftPath: "/left", rightPath: {}, activePaneId: "right" })).toEqual({ path: "/left" });
    expect(normalizeSnapshot({ path: "" })).toBeNull();
    expect(normalizeSnapshot({ path: "/root", tab: { kind: "git-graph", path: {}, id: "tab" } })).toEqual({ path: "/root" });
  });
});


describe("window message serialization budget", () => {
  it("accepts the receiver limit including envelope and escaping, rejects one extra character", () => {
    const prefix = { path: "\\\"\n", entries: [null, true, 12], optional: undefined, payload: "" };
    const room = WINDOW_SEED_MAX_CHARS - JSON.stringify(prefix).length;
    expect(windowSeedFitsBudget({ ...prefix, payload: "x".repeat(room) })).toBe(true);
    expect(windowSeedFitsBudget({ ...prefix, payload: "x".repeat(room + 1) })).toBe(false);
  });

  it("bounds aggregate layouts without reading the remainder after exhausting the budget", () => {
    const payload = Array.from({ length: 40 }, () => "x".repeat(32768));
    Object.defineProperty(payload, 39, { get() { throw new Error("must stop before remainder"); } });
    expect(windowSeedFitsBudget(payload)).toBe(false);
  });

  it("accepts repeated JSON values but rejects cycles and unsupported values", () => {
    const pane = { path: "/root" };
    expect(windowSeedFitsBudget([pane, pane])).toBe(true);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [cyclic, new Date(), NaN, Infinity, 1n, () => {}, undefined]) {
      expect(windowSeedFitsBudget(value)).toBe(false);
    }
  });

  it("rejects deeply nested input before exhausting the call stack", () => {
    let value: unknown = null;
    for (let i = 0; i < 1000; i++) value = [value];
    expect(windowSeedFitsBudget(value)).toBe(false);
  });
});

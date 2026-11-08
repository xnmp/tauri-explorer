/** App-owned open history (#1525): the pure bounded map behind "Date opened". */
import { describe, expect, it } from "vitest";
import {
  OPEN_HISTORY_MAX_TEXT, applyOpenHistoryOp, isOpenHistoryOp, lastOpened, mergeOpenHistories,
  parseOpenHistory, replayOpenHistory, serializeOpenHistory,
} from "$lib/domain/open-history";
import { sortEntries, type FileEntry } from "$lib/domain/file";

const open = (path: string, at: number) => ({ type: "open" as const, path, at });

describe("open history", () => {
  it("records the latest launch per file and never moves a timestamp back", () => {
    let history = applyOpenHistoryOp(new Map(), open("/a/x.txt", 200));
    history = applyOpenHistoryOp(history, open("/a/x.txt", 100));
    expect(lastOpened(history, "/a/x.txt")).toBe(200);
    history = applyOpenHistoryOp(history, open("/a/x.txt", 300));
    expect(lastOpened(history, "/a/x.txt")).toBe(300);
    expect(lastOpened(history, "/a/y.txt")).toBeUndefined();
  });

  it("does not mutate the input history", () => {
    const before = new Map([["/a", 1]]);
    applyOpenHistoryOp(before, open("/b", 2));
    expect([...before]).toEqual([["/a", 1]]);
  });

  it("shares one identity across Windows separators and case", () => {
    const history = applyOpenHistoryOp(new Map(), open("C:\\Users\\Me\\Doc.txt", 5));
    expect(lastOpened(history, "c:/users/me/doc.txt")).toBe(5);
  });

  it("evicts the least recently opened entry beyond capacity", () => {
    let history = new Map<string, number>();
    for (let i = 1; i <= 4; i++) history = applyOpenHistoryOp(history, open(`/f${i}`, i * 10), 3);
    expect([...history.keys()].sort()).toEqual(["/f2", "/f3", "/f4"]);
    // Re-opening an old file refreshes it, so the next eviction takes another.
    history = applyOpenHistoryOp(history, open("/f2", 50), 3);
    history = applyOpenHistoryOp(history, open("/f5", 60), 3);
    expect([...history.keys()].sort()).toEqual(["/f2", "/f4", "/f5"]);
  });

  it("merges histories with the later timestamp winning, within capacity", () => {
    const merged = mergeOpenHistories(new Map([["/a", 1], ["/b", 9]]), new Map([["/a", 5], ["/c", 3]]), 2);
    expect(Object.fromEntries(merged)).toEqual({ "/a": 5, "/b": 9 });
  });

  it("re-keys a renamed file and a moved folder's descendants", () => {
    const history = new Map([["/d/file.txt", 1], ["/d/sub/inner.txt", 2], ["/d-other/keep.txt", 3], ["/d/sub", 4]]);
    const renamed = applyOpenHistoryOp(history, { type: "move", from: "/d/file.txt", to: "/d/renamed.txt" });
    expect(lastOpened(renamed, "/d/renamed.txt")).toBe(1);
    expect(lastOpened(renamed, "/d/file.txt")).toBeUndefined();
    const moved = applyOpenHistoryOp(history, { type: "move", from: "/d", to: "/e/d" });
    expect(Object.fromEntries(moved)).toEqual({ "/e/d/file.txt": 1, "/e/d/sub/inner.txt": 2, "/e/d/sub": 4, "/d-other/keep.txt": 3 });
  });

  it("forgets deleted paths and everything beneath deleted folders", () => {
    const history = new Map([["/d/a", 1], ["/d/sub/b", 2], ["/dx/c", 3]]);
    const next = applyOpenHistoryOp(history, { type: "forget", paths: ["/d/sub", "/d/a"] });
    expect(Object.fromEntries(next)).toEqual({ "/dx/c": 3 });
  });

  it("replays changes in order", () => {
    const next = replayOpenHistory(new Map(), [open("/a", 1), { type: "move", from: "/a", to: "/b" }, open("/c", 2), { type: "forget", paths: ["/c"] }]);
    expect(Object.fromEntries(next)).toEqual({ "/b": 1 });
  });

  it("round-trips through serialization", () => {
    const history = new Map([["/a b/ü.txt", 1_700_000_000_000], ["c:/x/y", 2]]);
    expect(parseOpenHistory(serializeOpenHistory(history))).toEqual(history);
  });

  it.each([
    ["missing", ""], ["not JSON", "{oops"], ["null", "null"], ["an array", "[]"],
    ["entries as an array", '{"entries":[["/a",1]]}'], ["a number", "42"],
  ])("reads %s data as an empty history", (_label, text) => {
    expect(parseOpenHistory(text).size).toBe(0);
  });

  it("keeps valid entries and drops malformed ones", () => {
    const text = JSON.stringify({ version: 1, entries: { "/ok": 5, "/neg": -1, "/str": "5", "/nan": null, "/inf": 1e300, "": 4, "/nul\0": 3 } });
    expect(Object.fromEntries(parseOpenHistory(text))).toEqual({ "/ok": 5 });
  });

  it("rejects oversized documents and trims huge ones to the newest entries", () => {
    expect(parseOpenHistory(" ".repeat(OPEN_HISTORY_MAX_TEXT + 1)).size).toBe(0);
    const entries = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`/f${i}`, i + 1]));
    const trimmed = parseOpenHistory(JSON.stringify({ entries }), 10);
    expect(trimmed.size).toBe(10);
    expect(Math.min(...trimmed.values())).toBe(41);
  });

  it("validates changes received from other windows", () => {
    expect(isOpenHistoryOp(open("/a", 1))).toBe(true);
    expect(isOpenHistoryOp({ type: "move", from: "/a", to: "/b" })).toBe(true);
    expect(isOpenHistoryOp({ type: "forget", paths: ["/a"] })).toBe(true);
    expect(isOpenHistoryOp({ type: "open", path: "/a", at: "1" })).toBe(false);
    expect(isOpenHistoryOp({ type: "forget", paths: [1] })).toBe(false);
    expect(isOpenHistoryOp({ type: "drop" })).toBe(false);
    expect(isOpenHistoryOp(null)).toBe(false);
  });
});

describe("sorting by Date opened", () => {
  const file = (name: string): FileEntry => ({ name, path: `/d/${name}`, kind: "file", size: 0, modified: "" });
  const dir = (name: string): FileEntry => ({ ...file(name), kind: "directory" });
  const times: Record<string, number> = { "/d/old.txt": 10, "/d/new.txt": 20 };
  const openedAt = (entry: FileEntry) => times[entry.path];
  const names = (entries: FileEntry[]) => entries.map((entry) => entry.name);
  const entries = [file("a-never.txt"), file("new.txt"), dir("folder"), file("old.txt"), file("b-never.txt")];

  it("orders opened files by time, never-opened files last, folders first", () => {
    expect(names(sortEntries(entries, "opened", true, { openedAt }))).toEqual(["folder", "old.txt", "new.txt", "a-never.txt", "b-never.txt"]);
  });

  it("reverses opened files for descending order, keeping never-opened files last", () => {
    expect(names(sortEntries(entries, "opened", false, { openedAt }))).toEqual(["folder", "new.txt", "old.txt", "b-never.txt", "a-never.txt"]);
  });
});

/**
 * The site-demo build keeps an open page working across a rebuild (#1789):
 * the previous build's lazy chunks stay servable, and the new build replaces
 * the old one whole.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireBuildLock, carryOverRetiredChunks, recoverInterruptedSwap, runDemoBuild, swapIntoPlace } from "../scripts/build-demo.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19);
let dir = "";

function write(path: string, text: string, mtime = NOW) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, mtime / 1000, mtime / 1000);
}

afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("site-demo build", () => {
  it("carries the previous build's chunks into the new one, never replacing a new file", () => {
    dir = mkdtempSync(join(tmpdir(), "build-demo-"));
    const live = join(dir, "live");
    const next = join(dir, "next");
    write(join(live, "_app/immutable/nodes/2.OLD.js"), "old page");
    write(join(live, "_app/immutable/chunks/ListColumnsView.OLD.js"), "old list view");
    write(join(live, "_app/immutable/chunks/shared.SAME.js"), "old copy");
    write(join(live, "index.html"), "old index");
    write(join(next, "_app/immutable/chunks/shared.SAME.js"), "new copy");
    write(join(next, "index.html"), "new index");

    expect(carryOverRetiredChunks(live, next, { now: NOW })).toEqual([
      join("_app/immutable/chunks/ListColumnsView.OLD.js"),
      join("_app/immutable/nodes/2.OLD.js"),
    ]);
    expect(readFileSync(join(next, "_app/immutable/chunks/ListColumnsView.OLD.js"), "utf8")).toBe("old list view");
    expect(readFileSync(join(next, "_app/immutable/chunks/shared.SAME.js"), "utf8")).toBe("new copy");
    // Only content-hashed immutable files carry over; entry pages are the new build's.
    expect(readFileSync(join(next, "index.html"), "utf8")).toBe("new index");
  });

  it("ages a retired chunk from the build that retired it, not from its own date", () => {
    dir = mkdtempSync(join(tmpdir(), "build-demo-"));
    const live = join(dir, "live");
    const next = join(dir, "next");
    // A build that stayed live for a month: its chunks are old files, but
    // pages are open on it, so the build that retires them keeps them.
    write(join(live, "_app/immutable/chunks/month-old.js"), "x", NOW - 30 * DAY);
    mkdirSync(next);
    expect(carryOverRetiredChunks(live, next, { now: NOW, retainMs: 7 * DAY })).toEqual([join("_app/immutable/chunks/month-old.js")]);

    // Carried again six days later: still within the window.
    const again = join(dir, "again");
    expect(carryOverRetiredChunks(next, again, { now: NOW + 6 * DAY, retainMs: 7 * DAY })).toEqual([join("_app/immutable/chunks/month-old.js")]);
    // Eight days after its retirement it goes, however often it was carried.
    const third = join(dir, "third");
    expect(carryOverRetiredChunks(again, third, { now: NOW + 8 * DAY, retainMs: 7 * DAY })).toEqual([]);
    expect(existsSync(join(third, "_app/immutable/chunks/month-old.js"))).toBe(false);
  });

  it("works for a first build, with nothing to carry", () => {
    dir = mkdtempSync(join(tmpdir(), "build-demo-"));
    mkdirSync(join(dir, "next"));
    expect(carryOverRetiredChunks(join(dir, "missing"), join(dir, "next"))).toEqual([]);
  });

  it("swaps the new build into place and removes the old one", () => {
    dir = mkdtempSync(join(tmpdir(), "build-demo-"));
    const live = join(dir, "build-demo");
    const next = join(dir, "build-demo.next");
    write(join(live, "index.html"), "old");
    write(join(next, "index.html"), "new");
    swapIntoPlace(live, next);
    expect(readFileSync(join(live, "index.html"), "utf8")).toBe("new");
    expect(existsSync(next)).toBe(false);
    expect(existsSync(`${live}.old`)).toBe(false);
    // First build: nothing in place yet.
    write(join(next, "index.html"), "newer");
    rmSync(live, { recursive: true });
    swapIntoPlace(live, next);
    expect(readFileSync(join(live, "index.html"), "utf8")).toBe("newer");
  });

  describe("a whole run", () => {
    const LOG = () => {};
    const liveFile = (rel: string) => join(dir, "build-demo", rel);
    const buildInto = (files: Record<string, string>) => () => {
      for (const [rel, text] of Object.entries(files)) write(join(dir, "build-demo.next", rel), text);
      return 0;
    };

    it("a failed build leaves the live build untouched, removes its partial output and releases the lock", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      write(liveFile("index.html"), "live");
      const status = runDemoBuild({
        root: dir,
        log: LOG,
        build: () => { write(join(dir, "build-demo.next", "index.html"), "half"); return 2; },
      });
      expect(status).toBe(2);
      expect(readFileSync(liveFile("index.html"), "utf8")).toBe("live");
      expect(existsSync(join(dir, "build-demo.next"))).toBe(false);
      expect(existsSync(join(dir, "build-demo.lock"))).toBe(false);
    });

    it("refuses to run beside a running build, touching nothing", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      write(liveFile("index.html"), "live");
      write(join(dir, "build-demo.next", "index.html"), "the other build's output");
      // This test process is alive: its pid in the lock is a running build.
      writeFileSync(join(dir, "build-demo.lock"), `${process.pid}\n`);
      let built = false;
      expect(() => runDemoBuild({ root: dir, log: LOG, build: () => { built = true; return 0; } }))
        .toThrow(/already running \(pid \d+/);
      expect(built).toBe(false);
      expect(readFileSync(join(dir, "build-demo.next", "index.html"), "utf8")).toBe("the other build's output");
      expect(readFileSync(join(dir, "build-demo.lock"), "utf8")).toBe(`${process.pid}\n`);
    });

    it("takes over the lock of a build that is gone", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      // pid 2^22 + 1 is above Linux's pid_max, so no process has it.
      writeFileSync(join(dir, "build-demo.lock"), "4194305\n");
      expect(runDemoBuild({ root: dir, log: LOG, build: buildInto({ "index.html": "new" }) })).toBe(0);
      expect(readFileSync(liveFile("index.html"), "utf8")).toBe("new");
      expect(existsSync(join(dir, "build-demo.lock"))).toBe(false);
    });

    it("a second lock on the same path is refused while the first is held", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      const release = acquireBuildLock(join(dir, "lock"));
      expect(() => acquireBuildLock(join(dir, "lock"))).toThrow(/already running/);
      release();
      acquireBuildLock(join(dir, "lock"))();
    });

    it("recovers a swap interrupted between its two renames, then builds over it", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      // The interrupted run had moved the live build aside and not yet put the new one in place.
      write(join(dir, "build-demo.old", "index.html"), "last good");
      write(join(dir, "build-demo.old", "_app/immutable/chunks/open-page.js"), "chunk an open page needs");
      write(join(dir, "build-demo.next", "index.html"), "stale partial");
      expect(runDemoBuild({ root: dir, log: LOG, build: buildInto({ "index.html": "new" }) })).toBe(0);
      expect(readFileSync(liveFile("index.html"), "utf8")).toBe("new");
      // The recovered build's chunks were carried, so its open pages keep working.
      expect(readFileSync(liveFile("_app/immutable/chunks/open-page.js"), "utf8")).toBe("chunk an open page needs");
      expect(existsSync(join(dir, "build-demo.old"))).toBe(false);
    });

    it("recoverInterruptedSwap restores a lone .old build and cleans a leftover one", () => {
      dir = mkdtempSync(join(tmpdir(), "build-demo-"));
      const live = join(dir, "build-demo");
      expect(recoverInterruptedSwap(live)).toBe("none");
      write(join(`${live}.old`, "index.html"), "old");
      expect(recoverInterruptedSwap(live)).toBe("restored");
      expect(readFileSync(join(live, "index.html"), "utf8")).toBe("old");
      write(join(`${live}.old`, "index.html"), "older");
      expect(recoverInterruptedSwap(live)).toBe("cleaned");
      expect(readFileSync(join(live, "index.html"), "utf8")).toBe("old");
      expect(existsSync(`${live}.old`)).toBe(false);
    });
  });
});

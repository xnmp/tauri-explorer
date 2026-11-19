/**
 * The site-demo build keeps an open page working across a rebuild (#1789):
 * the previous build's lazy chunks stay servable, and the new build replaces
 * the old one whole.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { carryOverRetiredChunks, swapIntoPlace } from "../scripts/build-demo.mjs";

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

  it("drops a retired chunk once it is older than the retention window, however often it was carried", () => {
    dir = mkdtempSync(join(tmpdir(), "build-demo-"));
    const live = join(dir, "live");
    const next = join(dir, "next");
    write(join(live, "_app/immutable/chunks/ancient.js"), "x", NOW - 8 * DAY);
    write(join(live, "_app/immutable/chunks/recent.js"), "y", NOW - 6 * DAY);
    mkdirSync(next);

    expect(carryOverRetiredChunks(live, next, { now: NOW, retainMs: 7 * DAY })).toEqual([join("_app/immutable/chunks/recent.js")]);
    const again = join(dir, "again");
    mkdirSync(again);
    // The carried copy keeps its age, so the next build drops it in time.
    expect(carryOverRetiredChunks(next, again, { now: NOW + 2 * DAY, retainMs: 7 * DAY })).toEqual([]);
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
});

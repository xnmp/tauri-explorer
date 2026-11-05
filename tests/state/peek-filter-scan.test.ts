import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { createPeekFilterScan, type PeekFilterScanOptions } from "$lib/state/peek-filter-scan";

const dir = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 0, modified: "" });
const file = (path: string): FileEntry => ({ ...dir(path), kind: "file" });

/** /r/l1/l2/l3/l4/l5, each folder also holding one file. */
const chain = ["/r/l1", "/r/l1/l2", "/r/l1/l2/l3", "/r/l1/l2/l3/l4", "/r/l1/l2/l3/l4/l5"];
const tree: Record<string, FileEntry[]> = Object.fromEntries(chain.map((path, i) => [path, [file(path + "/f"), ...(chain[i + 1] ? [dir(chain[i + 1])] : [])]]));

function scanWith(overrides: Partial<PeekFilterScanOptions> = {}) {
  const requested: string[] = [];
  const onChange = vi.fn();
  const scan = createPeekFilterScan({
    list: async path => { requested.push(path); return tree[path] ?? []; },
    visible: entries => entries,
    onChange,
    ...overrides,
  });
  return { scan, requested, onChange };
}
const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("createPeekFilterScan (#1510)", () => {
  it("lists folders breadth-first down to the depth bound, never deeper", async () => {
    const { scan, requested, onChange } = scanWith();
    scan.start("/r", [dir("/r/l1"), file("/r/top")]);
    await settle();
    // l1 is level 1; l3 (level 3) is the last folder whose listing is needed.
    expect(requested).toEqual(["/r/l1", "/r/l1/l2", "/r/l1/l2/l3"]);
    expect(scan.listing("/r/l1/l2/l3")).toEqual(tree["/r/l1/l2/l3"]);
    expect(scan.listing("/r/l1/l2/l3/l4")).toBeUndefined();
    expect(scan.running).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it("stops at the directory cap", async () => {
    const top = Array.from({ length: 10 }, (_, i) => dir(`/r/d${i}`));
    const { scan, requested } = scanWith({ maxDirectories: 4, concurrency: 2 });
    scan.start("/r", top);
    await settle();
    expect(requested).toHaveLength(4);
    expect(scan.truncated).toBe(true);
  });

  it("drops late replies after stop and requests nothing more", async () => {
    const pending: ((entries: FileEntry[]) => void)[] = [];
    const requested: string[] = [];
    const { scan, onChange } = scanWith({
      concurrency: 1,
      list: path => { requested.push(path); return new Promise(resolve => pending.push(resolve)); },
    });
    scan.start("/r", [dir("/r/l1"), dir("/r/other")]);
    expect(requested).toEqual(["/r/l1"]);
    scan.stop();
    pending[0](tree["/r/l1"]);
    await settle();
    expect(requested).toEqual(["/r/l1"]);
    expect(scan.listing("/r/l1")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reuses cached listings when restarted on the same root and forgets them on another", async () => {
    const { scan, requested } = scanWith();
    scan.start("/r", [dir("/r/l1")]);
    await settle();
    requested.length = 0;
    scan.start("/r", [dir("/r/l1")]);
    await settle();
    expect(requested).toEqual([]);
    scan.start("/elsewhere", [dir("/r/l1")]);
    await settle();
    expect(requested).toEqual(["/r/l1", "/r/l1/l2", "/r/l1/l2/l3"]);
  });

  it("treats an unreadable folder as empty", async () => {
    const { scan } = scanWith({ list: async () => { throw new Error("denied"); } });
    scan.start("/r", [dir("/r/l1")]);
    await settle();
    expect(scan.listing("/r/l1")).toEqual([]);
  });
});

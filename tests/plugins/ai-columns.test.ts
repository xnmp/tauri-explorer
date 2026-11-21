/**
 * AI Columns plugin (#1884): a column's loader (persisted values first, one
 * request for the misses, abort and failure handling) and the persisted store.
 */
import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { valueKey, type AiColumnDefinition } from "$lib/domain/ai-column";
import { aiColumnApplies, createColumnLoader, createOnceReporter, type AiColumnLoaderDeps } from "$lib/plugins/ai-columns/column-loader";
import { createAiColumnStore } from "$lib/plugins/ai-columns/column-store";

const column: AiColumnDefinition = { id: "ext-caps", label: "Extension in caps", description: "file extension in caps" };
const file = (name: string, size = 100): FileEntry => ({ name, path: `/docs/${name}`, kind: "file", size, modified: "2026-01-01T00:00:00Z" });
const text = (row: unknown) => (row as { columns?: Record<string, string> } | null)?.columns?.value;
/** A model that answers every file of a prompt with its name upper-cased. */
const echoModel = (input: string) => JSON.stringify(input.split("\n").slice(2).map((line) => {
  const row = JSON.parse(line) as { i: number; name: string };
  return { i: row.i, value: row.name.toUpperCase() };
}));

function deps(overrides: Partial<AiColumnLoaderDeps> = {}) {
  const stored = new Map<string, string>();
  const base: AiColumnLoaderDeps = {
    generateText: vi.fn(async ({ input }) => ({ text: echoModel(input) })),
    cancelText: vi.fn(async () => true),
    readExcerpt: vi.fn(async () => undefined),
    lookup: (key) => stored.get(key),
    store: (pairs) => { for (const [key, value] of pairs) stored.set(key, value); },
    report: vi.fn(),
    nextRequestId: () => "req-1",
    ...overrides,
  };
  return { deps: base, stored };
}

describe("AI column loader", () => {
  it("asks the model once per batch and returns one value per entry", async () => {
    const { deps: d } = deps();
    const values = await createColumnLoader(column, d)([file("a.pdf"), file("b.txt")], new AbortController().signal);
    expect(values.map(text)).toEqual(["A.PDF", "B.TXT"]);
    expect(d.generateText).toHaveBeenCalledTimes(1);
  });

  it("serves remembered values and sends only the misses", async () => {
    const { deps: d, stored } = deps();
    stored.set(valueKey(file("a.pdf")), "cached");
    const values = await createColumnLoader(column, d)([file("a.pdf"), file("b.txt")], new AbortController().signal);
    expect(values.map(text)).toEqual(["cached", "B.TXT"]);
    const input = vi.mocked(d.generateText).mock.calls[0][0].input;
    expect(input).toContain("b.txt");
    expect(input).not.toContain("a.pdf");
    // The answer is remembered for next time.
    expect(stored.get(valueKey(file("b.txt")))).toBe("B.TXT");
  });

  it("makes no request when every value is remembered", async () => {
    const { deps: d, stored } = deps();
    stored.set(valueKey(file("a.pdf")), "cached");
    expect((await createColumnLoader(column, d)([file("a.pdf")], new AbortController().signal)).map(text)).toEqual(["cached"]);
    expect(d.generateText).not.toHaveBeenCalled();
  });

  it("asks again for a file whose size or time changed", async () => {
    const { deps: d, stored } = deps();
    stored.set(valueKey(file("a.pdf", 100)), "old");
    expect((await createColumnLoader(column, d)([file("a.pdf", 200)], new AbortController().signal)).map(text)).toEqual(["A.PDF"]);
  });

  it("includes an excerpt only when one is supplied", async () => {
    const { deps: d } = deps({ readExcerpt: async (entry) => entry.name.endsWith(".txt") ? "hello there" : undefined });
    await createColumnLoader(column, d)([file("a.pdf"), file("b.txt")], new AbortController().signal);
    const rows = vi.mocked(d.generateText).mock.calls[0][0].input.split("\n").slice(2).map((line) => JSON.parse(line));
    expect(rows.map((row: { excerpt?: string }) => row.excerpt)).toEqual([undefined, "hello there"]);
  });

  it("cancels the request and returns empty values when aborted", async () => {
    const abort = new AbortController();
    let release!: () => void;
    const { deps: d, stored } = deps({
      generateText: vi.fn(() => new Promise<{ text: string }>((_, reject) => { release = () => reject(new Error("cancelled")); })),
    });
    const loading = createColumnLoader(column, d)([file("a.pdf")], abort.signal);
    await vi.waitFor(() => expect(d.generateText).toHaveBeenCalled());
    abort.abort();
    expect(d.cancelText).toHaveBeenCalledWith("req-1");
    release();
    expect((await loading).map(text)).toEqual([undefined]);
    expect(d.report).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it("leaves cells empty and reports a failed request", async () => {
    const { deps: d, stored } = deps({ generateText: vi.fn(async () => { throw { code: "disabled", message: "Text generation is disabled" }; }) });
    const values = await createColumnLoader(column, d)([file("a.pdf"), file("b.txt")], new AbortController().signal);
    expect(values).toEqual([null, null]);
    expect(d.report).toHaveBeenCalledWith(expect.stringContaining("Text generation is disabled"));
    expect(stored.size).toBe(0);
  });

  it("reports an unreadable reply and remembers nothing", async () => {
    const { deps: d, stored } = deps({ generateText: vi.fn(async () => ({ text: "Sorry, I can't do that." })) });
    expect(await createColumnLoader(column, d)([file("a.pdf")], new AbortController().signal)).toEqual([null]);
    expect(d.report).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    expect(stored.size).toBe(0);
  });

  it("keeps the answers it got from a partial reply", async () => {
    const { deps: d, stored } = deps({ generateText: vi.fn(async () => ({ text: '[{"i":1,"value":"two"}]' })) });
    const values = await createColumnLoader(column, d)([file("a.pdf"), file("b.txt")], new AbortController().signal);
    expect(values.map(text)).toEqual([undefined, "two"]);
    expect(d.report).not.toHaveBeenCalled();
    expect([...stored.values()]).toEqual(["two"]);
  });

  it("splits more than 16 misses into several requests instead of dropping the rest", async () => {
    const { deps: d } = deps();
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`));
    const values = await createColumnLoader(column, d)(many, new AbortController().signal);
    expect(values.map(text)).toEqual(many.map((entry) => entry.name.toUpperCase()));
    expect(d.generateText).toHaveBeenCalledTimes(2);
  });

  it("applies to real files and folders, not virtual or Trash entries", () => {
    expect(aiColumnApplies(file("a.pdf"))).toBe(true);
    expect(aiColumnApplies({ ...file("dir"), kind: "directory" })).toBe(true);
    expect(aiColumnApplies({ ...file("x"), path: "demo://recordings/x" })).toBe(false);
    expect(aiColumnApplies({ ...file("x"), path: "trash://abc" })).toBe(false);
  });

  it("reports each column's first error only", () => {
    const sink = vi.fn();
    const report = createOnceReporter(sink);
    report("a", "first");
    report("a", "second");
    report("b", "other column");
    expect(sink.mock.calls).toEqual([["first"], ["other column"]]);
  });
});

describe("AI column store", () => {
  function memoryStorage(initial: Record<string, unknown> = {}) {
    let saved: Record<string, unknown> = structuredClone(initial);
    const set = vi.fn(async (value: Record<string, unknown>) => { saved = structuredClone(value); });
    return { get: async () => structuredClone(saved), set, saved: () => saved };
  }
  const manualTimer = () => {
    const pending: (() => void)[] = [];
    return { setTimer: (run: () => void) => { pending.push(run); return pending.length; }, clearTimer: () => { pending.length = 0; }, fire: () => pending.splice(0).forEach((run) => run()) };
  };

  it("persists columns and their values so a new session finds them", async () => {
    const storage = memoryStorage();
    const timer = manualTimer();
    const first = createAiColumnStore(storage, timer);
    await first.load();
    const added = first.add("document language")!;
    first.store(added.id, [["k1", "English"]]);
    timer.fire();
    await first.flush();

    const next = createAiColumnStore(storage);
    await next.load();
    expect(next.columns).toEqual([added]);
    expect(next.lookup(added.id, "k1")).toBe("English");
  });

  it("writes values on a debounce, not once per batch", async () => {
    const storage = memoryStorage();
    const timer = manualTimer();
    const store = createAiColumnStore(storage, timer);
    await store.load();
    const { id } = store.add("language")!;
    await store.flush();
    storage.set.mockClear();
    for (let i = 0; i < 10; i++) store.store(id, [[`k${i}`, "v"]]);
    expect(storage.set).not.toHaveBeenCalled();
    timer.fire();
    await store.flush();
    expect(storage.set).toHaveBeenCalledTimes(1);
  });

  it("flushes pending values on demand", async () => {
    const storage = memoryStorage();
    const store = createAiColumnStore(storage, manualTimer());
    await store.load();
    const { id } = store.add("language")!;
    store.store(id, [["k", "v"]]);
    await store.flush();
    expect((storage.saved().values as Record<string, Record<string, string>>)[id]).toEqual({ k: "v" });
  });

  it("removing a column forgets its definition and values", async () => {
    const storage = memoryStorage();
    const store = createAiColumnStore(storage, manualTimer());
    await store.load();
    const keep = store.add("language")!;
    const gone = store.add("is this an invoice?")!;
    store.store(gone.id, [["k", "yes"]]);
    expect(store.remove(gone.id)).toBe(true);
    await store.flush();
    expect(store.columns).toEqual([keep]);
    expect(store.lookup(gone.id, "k")).toBeUndefined();
    expect(storage.saved().values).not.toHaveProperty(gone.id);
    expect(store.remove("never-existed")).toBe(false);
  });

  it("never overwrites a column another window added or removed meanwhile", async () => {
    const storage = memoryStorage();
    const timer = manualTimer();
    const windowA = createAiColumnStore(storage, timer);
    const windowB = createAiColumnStore(storage, timer);
    await windowA.load();
    await windowB.load();
    // Both windows loaded the empty file; each change lands after the other's.
    const ours = windowA.add("document language")!;
    await windowA.flush();
    const theirs = windowB.add("is this an invoice?")!;
    await windowB.flush();
    windowA.store(ours.id, [["k", "English"]]);
    timer.fire();
    await windowA.flush();

    const next = createAiColumnStore(storage);
    await next.load();
    expect(next.columns.map((column) => column.id)).toEqual([ours.id, theirs.id]);
    expect(next.lookup(ours.id, "k")).toBe("English");

    // A later-opened window removes our column while ours still answers it.
    const windowC = createAiColumnStore(storage);
    await windowC.load();
    windowC.remove(ours.id);
    await windowC.flush();
    windowA.store(ours.id, [["k2", "German"]]);
    await windowA.flush();
    const after = createAiColumnStore(storage);
    await after.load();
    expect(after.columns.map((column) => column.id)).toEqual([theirs.id]);
    expect(after.lookup(ours.id, "k2")).toBeUndefined();
  });

  it("ignores values for a column that no longer exists", async () => {
    const store = createAiColumnStore(memoryStorage(), manualTimer());
    await store.load();
    store.store("ghost", [["k", "v"]]);
    expect(store.lookup("ghost", "k")).toBeUndefined();
  });

  it("recovers from corrupt or unreadable storage", async () => {
    const corrupt = createAiColumnStore(memoryStorage({ columns: "nope", values: [1, 2] }));
    await corrupt.load();
    expect(corrupt.columns).toEqual([]);
    const failing = createAiColumnStore({ get: async () => { throw new Error("io"); }, set: async () => {} });
    await failing.load();
    expect(failing.columns).toEqual([]);
  });

  it("skips a write whose read fails rather than overwrite the stored columns", async () => {
    const storage = memoryStorage();
    const store = createAiColumnStore(storage, { ...manualTimer(), onWriteError: () => {} });
    await store.load();
    store.add("document language");
    await store.flush();
    const get = storage.get;
    storage.get = async () => { throw new Error("io"); };
    store.add("is this an invoice?");
    await store.flush();
    storage.get = get;
    expect((storage.saved().columns as unknown[]).length).toBe(1);
  });

  it("survives a failed write", async () => {
    const onWriteError = vi.fn();
    const store = createAiColumnStore({ get: async () => ({}), set: async () => { throw new Error("disk full"); } }, { ...manualTimer(), onWriteError });
    await store.load();
    store.add("language");
    await store.flush();
    expect(onWriteError).toHaveBeenCalled();
    expect(store.columns).toHaveLength(1);
  });
});

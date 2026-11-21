/**
 * AI Columns plugin (#1884, #1886): a column's loader (persisted values
 * first, ONE folder-agent job per folder, rerun on demand, abort and failure
 * handling), the persisted store, and the plugin's wiring through the context
 * (menu items, providers, palette commands and their disposers).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/plugins/ai-columns/AiColumnDialog.svelte", () => ({ default: {} }));
const listing = vi.hoisted(() => ({ entries: new Map<string, unknown[]>() }));
vi.mock("$lib/api/files", () => ({
  fetchDirectory: async (path: string) => listing.entries.has(path)
    ? { ok: true, data: { path, entries: listing.entries.get(path) } }
    : { ok: false, error: "not found" },
}));

import type { FileEntry } from "$lib/domain/file";
import type { AgentRequest } from "$lib/domain/ai-agent";
import type { DetailColumnProvider } from "$lib/domain/plugin-detail-columns";
import type { DetailColumnMenuItem } from "$lib/plugins/detail-column-menu-registry.svelte";
import type { PluginContext } from "$lib/plugins/api";
import type { Command } from "$lib/state/commands.svelte";
import { valueKey } from "$lib/domain/ai-column";
import { aiColumnApplies, createColumnLoader, createOnceReporter, type AiColumnLoaderDeps } from "$lib/plugins/ai-columns/column-loader";
import { createAiColumnStore } from "$lib/plugins/ai-columns/column-store";
import { aiColumnsPlugin } from "$lib/plugins/ai-columns";

const column = { id: "ext-caps", label: "Extension in caps", description: "file extension in caps" };
const file = (name: string, size = 100, folder = "/docs"): FileEntry => ({ name, path: `${folder}/${name}`, kind: "file", size, modified: "2026-01-01T00:00:00Z" });
const text = (row: unknown) => (row as { columns?: Record<string, string> } | null)?.columns?.value;
const signal = () => new AbortController().signal;
/** The names a folder prompt asks about. */
const askedNames = (request: AgentRequest) => JSON.parse(request.input.slice(request.input.lastIndexOf("\n") + 1)) as string[];
/** An agent that answers every asked name upper-cased, keyed by name. */
const echoAgent = async (request: AgentRequest) => ({ text: JSON.stringify(Object.fromEntries(askedNames(request).map((name) => [name, name.toUpperCase()]))) });

function deps(overrides: Partial<AiColumnLoaderDeps> = {}, folderEntries: FileEntry[] | null = null) {
  const stored = new Map<string, string>();
  const base: AiColumnLoaderDeps = {
    runAgent: vi.fn(echoAgent),
    listFolder: vi.fn(async () => folderEntries),
    lookup: (key) => stored.get(key),
    store: (pairs) => { for (const [key, value] of pairs) stored.set(key, value); },
    report: vi.fn(),
    ...overrides,
  };
  return { deps: base, stored };
}

describe("AI column loader", () => {
  it("answers every file of the folder from one agent job, keyed by name", async () => {
    const all = [file("a.pdf"), file("b.txt"), file("c.md")];
    const { deps: d, stored } = deps({}, all);
    const values = await createColumnLoader(column, d).load([all[0], all[1]], signal());
    expect(values.map(text)).toEqual(["A.PDF", "B.TXT"]);
    expect(d.runAgent).toHaveBeenCalledTimes(1);
    const request = vi.mocked(d.runAgent).mock.calls[0][0];
    expect(request.folder).toBe("/docs");
    expect(askedNames(request)).toEqual(["a.pdf", "b.txt", "c.md"]);
    expect(request.instructions).toMatch(/read only the files you need/);
    expect(request.timeoutMs).toBeGreaterThan(0);
    // The row not yet rendered is cached too, so scrolling to it costs nothing.
    expect(stored.get(valueKey(all[2]))).toBe("C.MD");
  });

  it("shares one job between concurrent batches of the same folder", async () => {
    const all = Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`));
    const { deps: d } = deps({}, all);
    const loader = createColumnLoader(column, d);
    const [first, second] = await Promise.all([loader.load(all.slice(0, 16), signal()), loader.load(all.slice(16), signal())]);
    expect([...first, ...second].map(text)).toEqual(all.map((entry) => entry.name.toUpperCase()));
    expect(d.runAgent).toHaveBeenCalledTimes(1);
  });

  it("runs one job per folder", async () => {
    const { deps: d } = deps();
    const values = await createColumnLoader(column, d).load([file("a.pdf"), file("b.txt", 1, "/other")], signal());
    expect(values.map(text)).toEqual(["A.PDF", "B.TXT"]);
    expect(vi.mocked(d.runAgent).mock.calls.map(([request]) => request.folder).sort()).toEqual(["/docs", "/other"]);
  });

  it("serves cached values and asks only about uncached files", async () => {
    const all = [file("a.pdf"), file("b.txt")];
    const { deps: d, stored } = deps({}, all);
    stored.set(valueKey(all[0]), "cached");
    const values = await createColumnLoader(column, d).load(all, signal());
    expect(values.map(text)).toEqual(["cached", "B.TXT"]);
    expect(askedNames(vi.mocked(d.runAgent).mock.calls[0][0])).toEqual(["b.txt"]);
  });

  it("makes no job when every rendered value is cached", async () => {
    const { deps: d, stored } = deps();
    stored.set(valueKey(file("a.pdf")), "cached");
    expect((await createColumnLoader(column, d).load([file("a.pdf")], signal())).map(text)).toEqual(["cached"]);
    expect(d.runAgent).not.toHaveBeenCalled();
  });

  it("runs a folder automatically once per session; forget reruns it on demand", async () => {
    const { deps: d, stored } = deps();
    const loader = createColumnLoader(column, d);
    await loader.load([file("a.pdf")], signal());
    // A rewritten file (new size) is a cache miss, but the folder already ran.
    const changed = file("a.pdf", 200);
    expect((await loader.load([changed], signal())).map(text)).toEqual([undefined]);
    expect(d.runAgent).toHaveBeenCalledTimes(1);
    loader.forget("/docs/");
    expect((await loader.load([changed], signal())).map(text)).toEqual(["A.PDF"]);
    expect(d.runAgent).toHaveBeenCalledTimes(2);
    expect(stored.get(valueKey(changed))).toBe("A.PDF");
  });

  it("does not rerun for files the agent left unanswered", async () => {
    const { deps: d } = deps({ runAgent: vi.fn(async () => ({ text: '{"a.pdf":"x"}' })) });
    const loader = createColumnLoader(column, d);
    expect((await loader.load([file("a.pdf"), file("b.txt")], signal())).map(text)).toEqual(["x", undefined]);
    expect((await loader.load([file("b.txt")], signal())).map(text)).toEqual([undefined]);
    expect(d.runAgent).toHaveBeenCalledTimes(1);
    expect(d.report).not.toHaveBeenCalled();
  });

  it("falls back to the rendered rows when the folder cannot be listed", async () => {
    const { deps: d } = deps({ listFolder: vi.fn(async () => { throw new Error("io"); }) });
    expect((await createColumnLoader(column, d).load([file("a.pdf")], signal())).map(text)).toEqual(["A.PDF"]);
  });

  it("dispose cancels the running job, stores nothing and reports nothing", async () => {
    let jobSignal: AbortSignal | undefined;
    const { deps: d, stored } = deps({
      runAgent: vi.fn((_request: AgentRequest, s: AbortSignal) => {
        jobSignal = s;
        return new Promise<{ text: string }>((_, reject) => s.addEventListener("abort", () => reject({ code: "cancelled", message: "cancelled" })));
      }),
    });
    const loader = createColumnLoader(column, d);
    const loading = loader.load([file("a.pdf")], signal());
    await vi.waitFor(() => expect(d.runAgent).toHaveBeenCalled());
    expect(loader.running).toBe(1);
    loader.dispose();
    expect(jobSignal?.aborted).toBe(true);
    expect((await loading).map(text)).toEqual([undefined]);
    expect(stored.size).toBe(0);
    expect(d.report).not.toHaveBeenCalled();
    // Disposed: later loads serve the cache only.
    await loader.load([file("b.txt")], signal());
    expect(d.runAgent).toHaveBeenCalledTimes(1);
  });

  it("a caller's abort stops its wait but not the shared job", async () => {
    let finish!: () => void;
    const { deps: d, stored } = deps({
      runAgent: vi.fn(async (request: AgentRequest) => { await new Promise<void>((resolve) => { finish = resolve; }); return echoAgent(request); }),
    });
    const loader = createColumnLoader(column, d);
    const caller = new AbortController();
    const loading = loader.load([file("a.pdf")], caller.signal);
    await vi.waitFor(() => expect(d.runAgent).toHaveBeenCalled());
    caller.abort();
    expect((await loading).map(text)).toEqual([undefined]);
    finish();
    await vi.waitFor(() => expect(stored.get(valueKey(file("a.pdf")))).toBe("A.PDF"));
  });

  it("leaves cells empty and reports a failed job; a folder outside the panes is silent", async () => {
    const failing = deps({ runAgent: vi.fn(async () => { throw { code: "unsupported", message: "Folder agent jobs need a Claude Code CLI" }; }) });
    expect(await createColumnLoader(column, failing.deps).load([file("a.pdf")], signal())).toEqual([null]);
    expect(failing.deps.report).toHaveBeenCalledWith(expect.stringContaining("Claude Code CLI"));
    const outside = deps({ runAgent: vi.fn(async () => { throw { code: "folder_not_open", message: "no" }; }) });
    expect(await createColumnLoader(column, outside.deps).load([file("a.pdf")], signal())).toEqual([null]);
    expect(outside.deps.report).not.toHaveBeenCalled();
  });

  it("reports an unreadable reply and remembers nothing", async () => {
    const { deps: d, stored } = deps({ runAgent: vi.fn(async () => ({ text: "Sorry, I can't do that." })) });
    expect(await createColumnLoader(column, d).load([file("a.pdf")], signal())).toEqual([null]);
    expect(d.report).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    expect(stored.size).toBe(0);
  });

  it("applies to real files and folders, not virtual or Trash entries", () => {
    expect(aiColumnApplies(file("a.pdf"))).toBe(true);
    expect(aiColumnApplies({ ...file("dir"), kind: "directory" })).toBe(true);
    expect(aiColumnApplies({ ...file("x"), path: "demo://recordings/x" })).toBe(false);
    expect(aiColumnApplies({ ...file("x"), path: "trash://abc" })).toBe(false);
  });

  it("reports each column's first error only, until reset", () => {
    const sink = vi.fn();
    const report = createOnceReporter(sink);
    report("a", "first");
    report("a", "second");
    report("b", "other column");
    report.reset("a");
    report("a", "after refresh");
    expect(sink.mock.calls).toEqual([["first"], ["other column"], ["after refresh"]]);
  });
});

describe("AI Columns plugin wiring", () => {
  function fakeCtx(options: { available?: boolean; agent?: boolean } = {}) {
    let saved: Record<string, unknown> = {};
    const menu = new Map<string, DetailColumnMenuItem>();
    const commands = new Map<string, Command>();
    const providers = new Map<string, DetailColumnProvider>();
    const disposed: string[] = [];
    const runs: { request: AgentRequest; signal?: AbortSignal }[] = [];
    const dialogs: { id: string; props?: Record<string, unknown> }[] = [];
    let release: (() => void) | null = null;
    let hold = false;
    const ctx = {
      agent: options.agent === false ? undefined : {
        describe: vi.fn(async () => ({ available: options.available ?? true })),
        run: vi.fn(async (request: AgentRequest, signal?: AbortSignal) => {
          runs.push({ request, signal });
          if (hold) await new Promise<void>((resolve) => { release = resolve; });
          return { ...(await echoAgent(request)), model: "haiku" };
        }),
      },
      registerDetailColumns: vi.fn((provider: DetailColumnProvider) => {
        providers.set(provider.id, provider);
        return () => { disposed.push(provider.id); if (providers.get(provider.id) === provider) providers.delete(provider.id); };
      }),
      registerDetailColumnMenuItem: vi.fn((item: DetailColumnMenuItem) => { menu.set(item.id, item); return () => { disposed.push(item.id); menu.delete(item.id); }; }),
      registerCommand: vi.fn((command: Command) => { commands.set(command.id, command); return () => { disposed.push(command.id); commands.delete(command.id); }; }),
      registerDialog: vi.fn(),
      openDialog: vi.fn((id: string, props?: Record<string, unknown>) => void dialogs.push({ id, props })),
      openSettings: vi.fn(),
      toast: { show: vi.fn(), error: vi.fn() },
      storage: { get: async () => structuredClone(saved), set: async (value: Record<string, unknown>) => { saved = structuredClone(value); } },
      workspace: { getCurrentDirectory: () => "/docs" },
    } as unknown as PluginContext;
    return { ctx, menu, commands, providers, disposed, runs, dialogs, holdJobs: () => { hold = true; }, release: () => release?.(), saved: () => saved, setSaved: (value: Record<string, unknown>) => { saved = structuredClone(value); } };
  }

  async function withColumn(f: ReturnType<typeof fakeCtx>) {
    await aiColumnsPlugin.activate(f.ctx);
    await f.commands.get("plugin.ai-columns.add")!.handler();
    (f.dialogs.at(-1)!.props!.onSubmit as (description: string) => void)("invoice date");
    return f.providers.get("ai-columns.invoice-date")!;
  }

  it("contributes nothing without the folder agent", async () => {
    const f = fakeCtx({ agent: false });
    await aiColumnsPlugin.activate(f.ctx);
    expect(f.menu.size + f.commands.size + f.providers.size).toBe(0);
    aiColumnsPlugin.deactivate?.();
  });

  it("adds a column from the header menu or the palette, never for the Length column", async () => {
    listing.entries.set("/docs", [file("a.pdf"), file("b.txt")]);
    const f = fakeCtx();
    const provider = await withColumn(f);
    expect([...f.menu.keys()]).toEqual(["ai-columns.add", "ai-columns.refresh", "ai-columns.remove-invoice-date"]);
    expect([...f.commands.keys()]).toEqual(["plugin.ai-columns.add", "plugin.ai-columns.refresh", "plugin.ai-columns.remove-invoice-date"]);
    expect(f.dialogs[0].id).toBe("ai-columns.describe");
    expect(provider.suppliesLength).toBe(false);
    expect(provider.columns).toEqual([{ key: "value", label: "Invoice date", width: 200 }]);
    const values = await provider.load([file("a.pdf")], signal());
    expect(values.map(text)).toEqual(["A.PDF"]);
    expect(f.runs).toHaveLength(1);
    expect(askedNames(f.runs[0].request)).toEqual(["a.pdf", "b.txt"]);
    aiColumnsPlugin.deactivate?.();
  });

  it("refresh drops the folder's cached values and reruns its job", async () => {
    listing.entries.set("/docs", [file("a.pdf")]);
    const f = fakeCtx();
    const provider = await withColumn(f);
    await provider.load([file("a.pdf")], signal());
    expect(f.runs).toHaveLength(1);
    await f.commands.get("plugin.ai-columns.refresh")!.handler();
    // The provider is registered anew so rendered rows reload.
    expect(f.disposed).toContain("ai-columns.invoice-date");
    const fresh = f.providers.get("ai-columns.invoice-date")!;
    expect(fresh).not.toBe(provider);
    expect((await fresh.load([file("a.pdf")], signal())).map(text)).toEqual(["A.PDF"]);
    expect(f.runs).toHaveLength(2);
    aiColumnsPlugin.deactivate?.();
  });

  it("removing a column disposes its provider, menu item and palette command", async () => {
    const f = fakeCtx();
    await withColumn(f);
    f.menu.get("ai-columns.remove-invoice-date")!.run();
    expect(f.disposed).toEqual(expect.arrayContaining(["ai-columns.invoice-date", "ai-columns.remove-invoice-date", "plugin.ai-columns.remove-invoice-date"]));
    expect(f.providers.size).toBe(0);
    expect(f.commands.has("plugin.ai-columns.remove-invoice-date")).toBe(false);
    expect(f.menu.has("ai-columns.add")).toBe(true);
    aiColumnsPlugin.deactivate?.();
  });

  it("deactivation cancels a running job", async () => {
    listing.entries.set("/docs", [file("a.pdf")]);
    const f = fakeCtx();
    const provider = await withColumn(f);
    f.holdJobs();
    void provider.load([file("a.pdf")], signal());
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    aiColumnsPlugin.deactivate?.();
    expect(f.runs[0].signal?.aborted).toBe(true);
    f.release();
  });

  it("persists the column so the next activation restores it", async () => {
    const f = fakeCtx();
    await withColumn(f);
    aiColumnsPlugin.deactivate?.();
    await vi.waitFor(() => expect(JSON.stringify(f.saved())).toContain("invoice-date"));
    f.providers.clear();
    await aiColumnsPlugin.activate(f.ctx);
    expect(f.providers.has("ai-columns.invoice-date")).toBe(true);
    aiColumnsPlugin.deactivate?.();
  });

  it("a column whose id another window stored meanwhile is remounted under a fresh id", async () => {
    const f = fakeCtx();
    await aiColumnsPlugin.activate(f.ctx);
    // Window B stores "invoice-date" after this window loaded its storage.
    f.setSaved({ version: 1, columns: [{ id: "invoice-date", label: "Invoice date?", description: "invoice date?" }], values: {} });
    await f.commands.get("plugin.ai-columns.add")!.handler();
    (f.dialogs.at(-1)!.props!.onSubmit as (description: string) => void)("invoice date");
    await vi.waitFor(() => expect(f.providers.has("ai-columns.invoice-date-2")).toBe(true));
    expect(f.providers.has("ai-columns.invoice-date")).toBe(false);
    expect(f.commands.has("plugin.ai-columns.remove-invoice-date-2")).toBe(true);
    expect(f.commands.has("plugin.ai-columns.remove-invoice-date")).toBe(false);
    expect((f.saved().columns as { id: string; description: string }[]).map((column) => [column.id, column.description]))
      .toEqual([["invoice-date", "invoice date?"], ["invoice-date-2", "invoice date"]]);
    aiColumnsPlugin.deactivate?.();
  });

  it("without an agent connection, Add opens settings instead of the dialog", async () => {
    const f = fakeCtx({ available: false });
    await aiColumnsPlugin.activate(f.ctx);
    await f.commands.get("plugin.ai-columns.add")!.handler();
    expect(f.dialogs).toHaveLength(0);
    expect(f.ctx.openSettings).toHaveBeenCalled();
    aiColumnsPlugin.deactivate?.();
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

  it("drops one folder's values on refresh, in memory and in storage", async () => {
    const storage = memoryStorage();
    const store = createAiColumnStore(storage, manualTimer());
    await store.load();
    const { id } = store.add("language")!;
    const inside = valueKey({ path: "/docs/a.txt", size: 1, modified: "t" });
    const outside = valueKey({ path: "/other/b.txt", size: 1, modified: "t" });
    store.store(id, [[inside, "x"], [outside, "y"]]);
    await store.flush();
    store.dropPaths(id, (path) => path.startsWith("/docs/"));
    await store.flush();
    expect(store.lookup(id, inside)).toBeUndefined();
    expect(store.lookup(id, outside)).toBe("y");
    expect((storage.saved().values as Record<string, Record<string, string>>)[id]).toEqual({ [outside]: "y" });
  });

  it("gives a fresh id to a column whose id another window stored meanwhile, values included", async () => {
    const storage = memoryStorage();
    const onRename = vi.fn();
    const windowA = createAiColumnStore(storage, { ...manualTimer(), onRename });
    const windowB = createAiColumnStore(storage, manualTimer());
    await windowA.load();
    await windowB.load();
    const theirs = windowB.add("invoice date?")!;
    await windowB.flush();
    const ours = windowA.add("Invoice date")!;
    expect(ours.id).toBe(theirs.id);
    windowA.store(ours.id, [["k", "2024-01-01"]]);
    await windowA.flush();
    const renamed = onRename.mock.calls[0]?.[1] as { id: string } | undefined;
    expect(onRename).toHaveBeenCalledWith(ours, expect.objectContaining({ description: "Invoice date" }));
    expect(renamed?.id).not.toBe(theirs.id);
    expect(windowA.columns.map((column) => column.id)).toEqual([renamed!.id]);
    expect(windowA.lookup(renamed!.id, "k")).toBe("2024-01-01");

    const next = createAiColumnStore(storage);
    await next.load();
    expect(next.columns.map((column) => [column.id, column.description])).toEqual([[theirs.id, "invoice date?"], [renamed!.id, "Invoice date"]]);
    expect(next.lookup(renamed!.id, "k")).toBe("2024-01-01");
    expect(next.lookup(theirs.id, "k")).toBeUndefined();

    // A later column with the same description never takes the moved-away id.
    const again = windowA.add("invoice date")!;
    expect([theirs.id, renamed!.id]).not.toContain(again.id);
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

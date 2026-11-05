import { describe, it, expect, vi } from "vitest";
import { AI_FILTER_UNAVAILABLE, createAiFilterController, type AiFilterHost, type AiTextBackend } from "$lib/state/ai-filter.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { TextDescription, TextResult } from "$lib/domain/text-connections";

const entry = (name: string): FileEntry => ({ name, path: `/d/${name}`, kind: "file", size: 1, modified: "2026-11-03T10:00:00" });

function host(names = ["invoice-1.pdf", "invoice-2.pdf", "notes.txt"]) {
  const h = {
    state: { currentPath: "/d" },
    filterPredicate: null as ((entry: FileEntry) => boolean) | null,
    selected: false,
    entries: names.map(entry),
    visibleEntries() { return h.entries; },
    setFilterPredicate(predicate: ((entry: FileEntry) => boolean) | null, select = false) {
      h.filterPredicate = predicate;
      h.selected = select;
    },
    shown() { return h.entries.filter(h.filterPredicate ?? (() => true)).map((e) => e.name); },
  };
  return h satisfies AiFilterHost & Record<string, unknown>;
}

const description = (available = true): TextDescription => ({ version: 1, enabled: available, available, configurationRevision: 7 });
const result = (text: string): TextResult => ({ text, context: { profileId: "p", configurationRevision: 7, fingerprint: "f", transport: "codex-cli", requestedModel: "m" } });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function backend(reply: string | Promise<TextResult> = '{"names":["invoice-1.pdf","invoice-2.pdf"]}', available = true) {
  return {
    describeText: vi.fn(async () => description(available)),
    generateText: vi.fn(async (_request: Parameters<AiTextBackend["generateText"]>[0]) => typeof reply === "string" ? result(reply) : reply),
    cancelText: vi.fn(async (_id: string) => true),
  } satisfies AiTextBackend;
}

let ids = 0;
const options = { now: () => new Date("2026-11-04T12:00:00"), requestId: () => `r${++ids}` };

describe("AI filter controller", () => {
  it("applies the model's exact matches as the pane's listing and selects the first", async () => {
    const h = host(), b = backend();
    const ai = createAiFilterController(h, b, options);
    await ai.run("invoices from last 3 days");
    expect(ai.state.kind).toBe("applied");
    expect(h.shown()).toEqual(["invoice-1.pdf", "invoice-2.pdf"]);
    expect(h.selected).toBe(true);
    const request = b.generateText.mock.calls[0]![0];
    expect(request.expectedConfigurationRevision).toBe(7);
    expect(request.input).toContain("Request: invoices from last 3 days");
    expect(request.input).toContain("notes.txt");
  });

  it("sends nothing when no language model is available", async () => {
    const h = host(), b = backend(undefined, false);
    const ai = createAiFilterController(h, b, options);
    await ai.run("invoices");
    expect(b.generateText).not.toHaveBeenCalled();
    expect(ai.state).toMatchObject({ kind: "error", message: AI_FILTER_UNAVAILABLE });
    expect(h.filterPredicate).toBeNull();
  });

  it("shows the full listing while loading and drops a result after navigation", async () => {
    const pending = deferred<TextResult>();
    const h = host(), b = backend(pending.promise);
    const ai = createAiFilterController(h, b, options);
    const run = ai.run("invoices");
    await vi.waitFor(() => expect(b.generateText).toHaveBeenCalled());
    expect(ai.state.kind).toBe("loading");
    expect(h.shown()).toHaveLength(3);
    // The explorer resets its filter on navigation.
    h.state.currentPath = "/other";
    h.filterPredicate = null;
    expect(ai.state.kind).toBe("idle");
    pending.resolve(result('{"names":["notes.txt"]}'));
    await run;
    expect(ai.state.kind).toBe("idle");
    expect(h.filterPredicate).toBeNull();
  });

  it("drops a result when the box was edited (predicate cleared) in flight", async () => {
    const pending = deferred<TextResult>();
    const h = host(), b = backend(pending.promise);
    const ai = createAiFilterController(h, b, options);
    const run = ai.run("invoices");
    await vi.waitFor(() => expect(b.generateText).toHaveBeenCalled());
    h.setFilterPredicate(null); // explorer.setFilter while typing
    pending.resolve(result('{"names":["notes.txt"]}'));
    await run;
    expect(ai.state.kind).toBe("idle");
    expect(h.filterPredicate).toBeNull();
  });

  it("cancels the in-flight request on clear and ignores its cancellation error", async () => {
    const pending = deferred<TextResult>();
    const h = host(), b = backend(pending.promise);
    const ai = createAiFilterController(h, b, options);
    const run = ai.run("invoices");
    await vi.waitFor(() => expect(b.generateText).toHaveBeenCalled());
    const id = b.generateText.mock.calls[0]![0].requestId;
    ai.clear();
    expect(b.cancelText).toHaveBeenCalledWith(id);
    expect(h.filterPredicate).toBeNull();
    pending.reject({ code: "cancelled", message: "Text request was cancelled" });
    await run;
    expect(ai.state.kind).toBe("idle");
  });

  it("a new request supersedes and cancels the previous one", async () => {
    const first = deferred<TextResult>();
    const h = host(), b = backend(first.promise);
    const ai = createAiFilterController(h, b, options);
    const run1 = ai.run("invoices");
    await vi.waitFor(() => expect(b.generateText).toHaveBeenCalledTimes(1));
    const firstId = b.generateText.mock.calls[0]![0].requestId;
    b.generateText.mockImplementation(async () => result('{"names":["notes.txt"]}'));
    await ai.run("notes");
    expect(b.cancelText).toHaveBeenCalledWith(firstId);
    first.resolve(result('{"names":["invoice-1.pdf"]}'));
    await run1;
    expect(ai.state).toMatchObject({ kind: "applied", query: "notes" });
    expect(h.shown()).toEqual(["notes.txt"]);
  });

  it("reports failures and malformed replies, returning the listing to the box", async () => {
    const h = host(), b = backend("sorry, no idea");
    const ai = createAiFilterController(h, b, options);
    await ai.run("invoices");
    expect(ai.state.kind).toBe("error");
    expect(h.filterPredicate).toBeNull();
    b.generateText.mockRejectedValueOnce({ code: "timed_out", message: "Text request deadline elapsed" });
    await ai.run("invoices");
    expect(ai.state).toMatchObject({ kind: "error", message: "AI filter failed: Text request deadline elapsed" });
  });

  it("ignores names the model invented", async () => {
    const h = host(), b = backend('{"names":["ghost.pdf","notes.txt"]}');
    const ai = createAiFilterController(h, b, options);
    await ai.run("notes");
    expect(ai.state).toMatchObject({ kind: "applied", ignored: 1 });
    expect(h.shown()).toEqual(["notes.txt"]);
  });

  it("does nothing for an empty query", async () => {
    const h = host(), b = backend();
    const ai = createAiFilterController(h, b, options);
    await ai.run("   ");
    expect(b.describeText).not.toHaveBeenCalled();
    expect(ai.state.kind).toBe("idle");
  });
});

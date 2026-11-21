/** Adversarial review of the AI Columns plugin (#1886): rows no job asked about and cross-window column ids. */
import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { AgentRequest } from "$lib/domain/ai-agent";
import { createColumnLoader, type AiColumnLoaderDeps } from "$lib/plugins/ai-columns/column-loader";
import { createAiColumnStore } from "$lib/plugins/ai-columns/column-store";

const column = { id: "ext-caps", label: "Ext", description: "file extension in caps" };
const file = (name: string, folder = "/docs"): FileEntry => ({ name, path: `${folder}/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00" });
const text = (row: unknown) => (row as { columns?: Record<string, string> } | null)?.columns?.value;
const signal = () => new AbortController().signal;
const askedNames = (request: AgentRequest) => JSON.parse(request.input.slice(request.input.lastIndexOf("\n") + 1)) as string[];
const echoAgent = async (request: AgentRequest) => ({ text: JSON.stringify(Object.fromEntries(askedNames(request).map((n) => [n, n.toUpperCase()]))) });

function deps(folderEntries: FileEntry[] | null) {
  const stored = new Map<string, string>();
  const d: AiColumnLoaderDeps = {
    runAgent: vi.fn(echoAgent),
    listFolder: vi.fn(async () => folderEntries),
    lookup: (key) => stored.get(key),
    store: (pairs) => { for (const [k, v] of pairs) stored.set(k, v); },
    report: vi.fn(),
  };
  return { d, stored };
}

describe("adversarial: AI column loader", () => {
  it("a rendered row past the 400-name cap is eventually answered (refresh included)", async () => {
    // 450-file folder; the view is sorted so the rendered rows are listing-order 420..435.
    const all = Array.from({ length: 450 }, (_, i) => file(`f${String(i).padStart(3, "0")}.txt`));
    const rendered = all.slice(420, 436);
    const { d, stored } = deps(all);
    const loader = createColumnLoader(column, d);
    await loader.load(rendered, signal());
    // Refresh, as the plugin does: drop the folder's values and forget the folder.
    stored.clear();
    loader.forget("/docs");
    const values = await loader.load(rendered, signal());
    expect(values.map(text)).toEqual(rendered.map((e) => e.name.toUpperCase()));
  });

  it("a dot-file row in a second concurrent batch is answered", async () => {
    const visible = Array.from({ length: 16 }, (_, i) => file(`f${i}.txt`));
    const hidden = file(".env");
    const { d } = deps(visible); // listFolder drops dot-files (activate.ts listFolder)
    const loader = createColumnLoader(column, d);
    const [, second] = await Promise.all([loader.load(visible, signal()), loader.load([hidden], signal())]);
    expect(second.map(text)).toEqual([".ENV"]);
  });

  it("when listing fails, rows of a second concurrent batch are answered", async () => {
    const all = Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`));
    const { d } = deps(null);
    const loader = createColumnLoader(column, d);
    const [, second] = await Promise.all([loader.load(all.slice(0, 16), signal()), loader.load(all.slice(16), signal())]);
    expect(second.map(text)).toEqual(all.slice(16).map((e) => e.name.toUpperCase()));
  });
});

describe("adversarial: AI column store across windows", () => {
  it("a column added in window A does not inherit window B's same-id column", async () => {
    let saved: Record<string, unknown> = {};
    const storage = { get: vi.fn(async () => structuredClone(saved)), set: vi.fn(async (v: Record<string, unknown>) => { saved = structuredClone(v); }) };
    const a = createAiColumnStore(storage);
    const b = createAiColumnStore(storage);
    await a.load();
    await b.load();
    const colB = b.add("invoice date?")!;
    await b.flush();
    const colA = a.add("Invoice date")!; // A's in-memory copy does not know B's column
    expect(colA.id).toBe(colB.id); // same slug: id collision
    a.store(colA.id, [["k", "2024-01-01"]]);
    await a.flush();
    const fresh = createAiColumnStore(storage);
    await fresh.load();
    // A's column is not persisted (B's description won) yet A's answers were written under that id.
    expect(fresh.columns.map((c) => c.description)).toContain("Invoice date");
  });
});

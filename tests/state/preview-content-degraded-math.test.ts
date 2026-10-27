/**
 * A Markdown render made while KaTeX could not load leaves TeX literal; it is
 * not remembered, so the next visit retries the typesetter (#1418).
 */
import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

const mocks = vi.hoisted(() => ({ readTextFile: vi.fn(), mathAvailable: false }));
vi.mock("$lib/api/files", () => ({ readTextFile: mocks.readTextFile, fetchDirectory: vi.fn() }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));
vi.mock("$lib/domain/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/domain/markdown")>();
  return {
    ...actual,
    renderMarkdownBlocks: async (md: string) => mocks.mathAvailable
      ? actual.renderMarkdownBlocks(md)
      : { blocks: [actual.renderMarkdown(md)], degraded: true },
  };
});
import { createPreviewContentLoader, type PreviewContent } from "$lib/state/preview-content";

const md = (name: string): FileEntry => ({ name, path: `/${name}`, kind: "file", size: 12, modified: "today" });

describe("degraded math renders (#1418)", () => {
  it("are retried on the next visit, and remembered once KaTeX loads", async () => {
    let content: PreviewContent = { kind: "empty" };
    const loader = createPreviewContentLoader(vi.fn(), { pdf: vi.fn(), video: vi.fn() }, { now: () => 0, nextFrame: async () => {} });
    const load = (entry: FileEntry) => loader.load(entry, content, { localRevision: 0, imageOptions: {} }, (next) => { content = next; });
    const html = () => (content.kind === "markdown" ? content.blocks.join("") : "");
    const reads = () => mocks.readTextFile.mock.calls.filter(([path]) => path === "/math.md").length;
    mocks.readTextFile.mockResolvedValue({ ok: true, data: "Euler: $e^{i\\pi}$" });

    await load(md("math.md"));
    expect(html()).not.toContain("katex");
    await load(md("other.md"));
    mocks.mathAvailable = true;
    await load(md("math.md"));
    expect(reads()).toBe(2);
    expect(html()).toContain("katex");
    await load(md("other.md"));
    await load(md("math.md"));
    expect(reads()).toBe(2);
    expect(html()).toContain("katex");
  });
});

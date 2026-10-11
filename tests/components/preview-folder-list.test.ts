/**
 * Preview folder list (#1040): previewing a huge folder must not mount a row
 * (and FileIcon) for every child — that lagged the UI on folders with
 * thousands of entries. Rendered with Svelte's server renderer.
 */
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import PreviewFolderList from "$lib/components/PreviewFolderList.svelte";
import type { FileEntry } from "$lib/domain/file";

function entries(count: number): FileEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const idx = String(i).padStart(5, "0");
    return { name: `file-${idx}.txt`, path: `/big/file-${idx}.txt`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };
  });
}

function renderList(list: FileEntry[], collapsedRoot: string | null = null, collapsedNote: string | null = null): string {
  return render(PreviewFolderList as never, { props: { entries: list, collapsedRoot, collapsedNote } } as never).body;
}

const rowNames = (html: string) =>
  [...html.matchAll(/<span class="folder-item-name[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);

describe("PreviewFolderList", () => {
  it("renders only a windowed slice of a 5000-entry folder, starting at its first child", () => {
    const html = renderList(entries(5000));
    const names = rowNames(html);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(200);
    expect(names[0]).toBe("file-00000.txt");
  });

  it("keeps every child reachable: the scroll extent covers all 5000 rows", () => {
    const html = renderList(entries(5000));
    const canvas = html.match(/class="virtual-canvas[^"]*" style="height: (\d+)px/);
    expect(canvas).not.toBeNull();
    const oneRow = renderList(entries(1)).match(/class="virtual-canvas[^"]*" style="height: (\d+)px/);
    expect(Number(canvas![1])).toBe(Number(oneRow![1]) * 5000);
  });

  it("still shows the collapsed single-folder indicator above the list", () => {
    const html = renderList(entries(2), "bundle", "single top-level folder");
    expect(html).toContain("bundle/");
    expect(html).toContain("single top-level folder");
    expect(rowNames(html)).toEqual(["file-00000.txt", "file-00001.txt"]);
  });
});

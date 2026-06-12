/**
 * Content search flattening, filtering and highlight rendering
 * (src/lib/domain/content-search-flatten.ts).
 */

import { describe, it, expect } from "vitest";
import {
  flattenFile,
  flattenBatch,
  rebuildAllFlattened,
  escapeHtml,
  highlightMatch,
} from "../../src/lib/domain/content-search-flatten";
import type { ContentSearchResult, ContentMatch } from "../../src/lib/api/files";

function match(line: number, content: string, start = 0, end = 1): ContentMatch {
  return { lineNumber: line, column: start + 1, lineContent: content, matchStart: start, matchEnd: end };
}

function file(path: string, matches: ContentMatch[]): ContentSearchResult {
  return { path, relativePath: path.replace(/^\//, ""), matches };
}

const none = new Set<string>();

describe("flattenFile", () => {
  it("marks only the first row of a file as header and carries the total", () => {
    const rows = flattenFile(file("/a.ts", [match(1, "x"), match(2, "y")]), "", none);
    expect(rows.map((r) => r.isFirstInFile)).toEqual([true, false]);
    expect(rows.every((r) => r.totalFileMatches === 2)).toBe(true);
  });

  it("collapses files over the 5-match limit behind a show-more row", () => {
    const matches = Array.from({ length: 8 }, (_, i) => match(i + 1, `line ${i}`));
    const rows = flattenFile(file("/a.ts", matches), "", none);

    // 5 visible rows + 1 show-more row
    expect(rows).toHaveLength(6);
    const showMore = rows[5];
    expect(showMore.isShowMore).toBe(true);
    expect(showMore.hiddenCount).toBe(3);
  });

  it("shows all matches when the file is expanded", () => {
    const matches = Array.from({ length: 8 }, (_, i) => match(i + 1, `line ${i}`));
    const rows = flattenFile(file("/a.ts", matches), "", new Set(["/a.ts"]));
    expect(rows).toHaveLength(8);
    expect(rows.some((r) => r.isShowMore)).toBe(false);
  });

  it("exactly at the limit there is no show-more row", () => {
    const matches = Array.from({ length: 5 }, (_, i) => match(i + 1, `line ${i}`));
    const rows = flattenFile(file("/a.ts", matches), "", none);
    expect(rows).toHaveLength(5);
    expect(rows.some((r) => r.isShowMore)).toBe(false);
  });

  it("filters by line content OR relative path, case-insensitively", () => {
    const f = file("/src/Widget.ts", [match(1, "const Foo = 1"), match(2, "const bar = 2")]);

    // Line-content match keeps only that row
    const byContent = flattenFile(f, "foo", none);
    expect(byContent).toHaveLength(1);
    expect(byContent[0].match.lineContent).toBe("const Foo = 1");

    // Path match keeps every row of the file
    const byPath = flattenFile(f, "widget", none);
    expect(byPath).toHaveLength(2);
  });

  it("returns nothing when the filter excludes all matches", () => {
    const rows = flattenFile(file("/a.ts", [match(1, "alpha")]), "zzz", none);
    expect(rows).toEqual([]);
  });

  it("handles a file with no matches", () => {
    expect(flattenFile(file("/a.ts", []), "", none)).toEqual([]);
  });
});

describe("flattenBatch / rebuildAllFlattened", () => {
  const files = [
    file("/a.ts", [match(1, "one")]),
    file("/b.ts", [match(2, "two"), match(3, "three")]),
  ];

  it("flattens files in order with per-file headers", () => {
    const rows = flattenBatch(files, "", none);
    expect(rows.map((r) => [r.filePath, r.isFirstInFile])).toEqual([
      ["/a.ts", true],
      ["/b.ts", true],
      ["/b.ts", false],
    ]);
  });

  it("rebuild equals batch flatten over the same inputs", () => {
    expect(rebuildAllFlattened(files, "", none)).toEqual(flattenBatch(files, "", none));
  });
});

describe("escapeHtml / highlightMatch", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml(`<img src="x" & more>`)).toBe(
      "&lt;img src=&quot;x&quot; &amp; more&gt;"
    );
  });

  it("wraps the match range in <mark> and escapes around it", () => {
    // "<b>" is the match inside a line containing other markup
    const line = `a <i> <b> z`;
    const html = highlightMatch(line, 6, 9);
    expect(html).toBe("a &lt;i&gt; <mark>&lt;b&gt;</mark> z");
  });

  it("handles a match spanning the whole line and an empty match", () => {
    expect(highlightMatch("abc", 0, 3)).toBe("<mark>abc</mark>");
    expect(highlightMatch("abc", 1, 1)).toBe("a<mark></mark>bc");
  });
});

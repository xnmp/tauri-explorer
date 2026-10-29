/** Lineage prompt labels (#1449): label selection, depth gating through the
 * real tree walk and row builder, malformed and long provider text, the
 * "prompt" sort and the unlabelled markup. */
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import EntryNameLabel from "$lib/components/EntryNameLabel.svelte";
import { sortEntries, type FileEntry } from "$lib/domain/file";
import { projectLineage, type EntryLineage, type LineageParent } from "$lib/domain/entry-lineage";
import { buildPeekRows, flattenPeekEntries } from "$lib/domain/folder-peek";
import { LINEAGE_PROMPT_MAX, LINEAGE_TITLE_MAX, isLineageChildRow, lineageText, normalizeLineageLabels } from "$lib/domain/lineage-labels";
import { COLUMN_KEYS, columnGridTemplate, normalizeColumnWidths } from "$lib/domain/detail-columns";
import { normalizeSettingsInput } from "$lib/state/settings.svelte";
import { normalizeDirectorySeed } from "$lib/domain/window-input";

const R = "/r";
const file = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ name, path: `${R}/${name}`, kind, size: 1, modified: "2026-01-01T00:00:00Z" });
const p = (name: string): LineageParent => ({ kind: "entry", path: `${R}/${name}` });
const labelsOf = (labels: Record<string, unknown>) => new Map(Object.entries(labels).map(([name, value]) => [`${R}/${name}`, value]));

describe("label selection", () => {
  const labels = normalizeLineageLabels(labelsOf({
    "both.png": { prompt: "Full prompt text", title: "Short title" },
    "prompt.png": { prompt: "Only a prompt" },
    "title.png": { title: "Only a title" },
    "empty.png": { prompt: "   ", title: "" },
  }), false)!;

  it("prefers the title for the row label, then the prompt, then the filename (null)", () => {
    expect(labels.label(`${R}/both.png`)).toBe("Short title");
    expect(labels.label(`${R}/prompt.png`)).toBe("Only a prompt");
    expect(labels.label(`${R}/title.png`)).toBe("Only a title");
    expect(labels.label(`${R}/empty.png`)).toBeNull();
    expect(labels.label(`${R}/unknown.png`)).toBeNull();
  });

  it("shows the prompt in the column, falling back to the title, else nothing (\"—\")", () => {
    expect(labels.prompt(`${R}/both.png`)).toBe("Full prompt text");
    expect(labels.prompt(`${R}/title.png`)).toBe("Only a title");
    expect(labels.prompt(`${R}/empty.png`)).toBeNull();
    expect(labels.prompt(`${R}/unknown.png`)).toBeNull();
  });

  it("looks paths up by the platform's path rules", () => {
    expect(labels.prompt(`${R}//prompt.png`)).toBe("Only a prompt");
    const windows = normalizeLineageLabels(new Map([["C:\\Work\\a.png", { prompt: "x" }]]), true)!;
    expect(windows.prompt("c:/Work/a.png")).toBe("x");
  });

  it("matches the name filter on prompt and title text, case-insensitively", () => {
    expect(labels.matches(`${R}/both.png`, "prompt text")).toBe(true);
    expect(labels.matches(`${R}/both.png`, "short")).toBe(true);
    expect(labels.matches(`${R}/both.png`, "missing")).toBe(false);
    expect(labels.matches(`${R}/unknown.png`, "prompt")).toBe(false);
  });
});

describe("absent and malformed labels", () => {
  it("is null without a labels Map: older providers show no column and no labels", () => {
    expect(normalizeLineageLabels(undefined, false)).toBeNull();
    expect(normalizeLineageLabels(null, false)).toBeNull();
    expect(normalizeLineageLabels({ [`${R}/a.png`]: { prompt: "x" } }, false)).toBeNull();
    expect(normalizeLineageLabels([[`${R}/a.png`, { prompt: "x" }]], false)).toBeNull();
  });

  it("ignores malformed keys and values without throwing", () => {
    const raw = new Map<unknown, unknown>([
      [42, { prompt: "number key" }], ["relative.png", { prompt: "relative" }], [`${R}/null.png`, null],
      [`${R}/string.png`, "just a string"], [`${R}/types.png`, { prompt: 7, title: { text: "x" } }],
      [`${R}/ok.png`, { prompt: "fine", title: ["array"] }],
    ]);
    const labels = normalizeLineageLabels(raw, false)!;
    expect(labels.prompt(`${R}/null.png`)).toBeNull();
    expect(labels.prompt(`${R}/string.png`)).toBeNull();
    expect(labels.prompt(`${R}/types.png`)).toBeNull();
    expect(labels.label(`${R}/ok.png`)).toBe("fine");
  });

  it("collapses multi-line prompts to one line and bounds very long ones", () => {
    expect(lineageText("  first line\n\n\tsecond   line  ", 100)).toBe("first line second line");
    const long = "word ".repeat(10_000);
    const labels = normalizeLineageLabels(labelsOf({ "long.png": { prompt: long, title: long } }), false)!;
    const prompt = labels.prompt(`${R}/long.png`)!;
    expect(prompt.length).toBeLessThanOrEqual(LINEAGE_PROMPT_MAX);
    expect(prompt.endsWith("…")).toBe(true);
    expect(prompt.startsWith("word word")).toBe(true);
    expect(labels.label(`${R}/long.png`)!.length).toBeLessThanOrEqual(LINEAGE_TITLE_MAX);
  });
});

describe("depth gating", () => {
  // A edited into c; A + B merged into m; folder F is peeked beside them.
  const A = file("A.png"), B = file("B.png"), c = file("c.png"), m = file("m.png"), F = file("F", "directory");
  const inner: FileEntry = { name: "inner.png", path: `${R}/F/inner.png`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };
  const lineage: EntryLineage = { revision: "1", parents: new Map([[c.path, [p("A.png")]], [m.path, [p("A.png"), p("B.png")]]]) };
  const projection = projectLineage([A, B, F, c, m], lineage, false);
  if (projection.kind !== "grouped") throw new Error("expected grouping");
  const open = [A.path, F.path, "group:/r/A.png|/r/B.png"];
  const tree = flattenPeekEntries({
    root: R, entries: projection.roots, expanded: new Map(open.map((id, index) => [id, index + 1])),
    listing: path => path === F.path ? [inner] : undefined, project: items => items, capability: "tree", windows: false,
    lineage: projection,
  });
  const labels = normalizeLineageLabels(new Map([
    [A.path, { prompt: "root prompt" }], [c.path, { title: "c title", prompt: "c prompt" }],
    [m.path, { prompt: "merge prompt" }], [inner.path, { prompt: "inner prompt" }],
  ]), false)!;
  const rowLabels = buildPeekRows(tree, () => undefined).rows.flatMap(row => row.kind === "entry"
    ? [[row.entry.name, row.depth, labels.rowLabel(row, R)] as const] : []);

  it("labels lineage children (direct and in a group), never depth 0 or folder-peek children", () => {
    expect(rowLabels).toEqual([
      ["A.png", 0, null],
      ["m.png", 2, "merge prompt"],
      ["c.png", 1, "c title"],
      ["B.png", 0, null],
      ["F", 0, null],
      ["inner.png", 1, null],
    ]);
  });

  it("classifies placements without labels", () => {
    expect(isLineageChildRow({ entry: c, depth: 1, parentPath: R, parentKey: A.path }, R)).toBe(true);
    expect(isLineageChildRow({ entry: inner, depth: 1, parentPath: F.path }, R)).toBe(false);
    expect(isLineageChildRow({ entry: inner, depth: 2, parentPath: F.path, parentKey: `${A.path}\0${F.path}` }, R)).toBe(false);
    expect(isLineageChildRow({ entry: A, depth: 0, parentPath: R }, R)).toBe(false);
  });
});

describe("unlabelled rows", () => {
  it("render byte-identical name markup when no label is passed", () => {
    const html = (props: Record<string, unknown>) => render(EntryNameLabel as never, { props: { name: "c.png", variant: "details", ...props } } as never).body;
    expect(html({ text: undefined, tooltip: undefined })).toBe(html({}));
    expect(html({ text: null })).toBe(html({}));
    const labelled = html({ text: "Blue fox", tooltip: "c.png\nMake the fox blue" });
    expect(labelled).toContain(">Blue fox<");
    expect(labelled).toContain('title="c.png\nMake the fox blue"');
  });
});

describe("Prompt sort", () => {
  const entries = [file("a.png"), file("b.png"), file("c.png"), file("d.png"), file("Dir", "directory")];
  const prompts: Record<string, string> = { "a.png": "zebra", "b.png": "Apple", "d.png": "apple" };
  const promptOf = (entry: FileEntry) => prompts[entry.name];
  const names = (list: FileEntry[]) => list.map(entry => entry.name);

  it("sorts by prompt text, ties by name, files without one after, folders first", () => {
    expect(names(sortEntries(entries, "prompt", true, promptOf))).toEqual(["Dir", "b.png", "d.png", "a.png", "c.png"]);
    expect(names(sortEntries(entries, "prompt", false, promptOf))).toEqual(["Dir", "c.png", "a.png", "d.png", "b.png"]);
  });

  it("falls back to name order without prompts", () => {
    expect(names(sortEntries(entries, "prompt", true))).toEqual(names(sortEntries(entries, "name", true)));
  });

  it("is accepted as a window seed's sort", () => {
    const seed = normalizeDirectorySeed({ currentPath: "/r", ts: 1000, entries: [], viewMode: "details", sortBy: "prompt", sortAscending: true }, "/r", 1000);
    expect(seed?.sortBy).toBe("prompt");
  });
});

describe("Prompt column layout", () => {
  it("is a keyed column right after Name, projected only while visible", () => {
    expect(COLUMN_KEYS).toEqual(["name", "prompt", "date", "type", "size", "length", "resolution"]);
    const widths = { ...normalizeColumnWidths(), prompt: 222 };
    const visible = { date: false, type: false, size: false, length: false, resolution: false };
    expect(columnGridTemplate(widths, { ...visible, prompt: true })).toBe("300px 222px");
    expect(columnGridTemplate(widths, visible)).toBe("300px");
  });

  it("is visible by default, including for settings saved before the column existed", () => {
    expect(normalizeSettingsInput({ columnVisibility: { date: false } }).columnVisibility)
      .toEqual({ prompt: true, date: false, type: true, size: true, length: true, resolution: true });
  });
});

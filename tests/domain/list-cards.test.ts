import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { buildPeekRows, flattenPeekEntries, type PeekListing } from "$lib/domain/folder-peek";
import { flatPeekEntries, flatPeekRows } from "$lib/domain/folder-peek-flat";
import { resolveListMove, LIST_COLUMN_STRIDE, LIST_COLUMN_WIDTH, LIST_SLOT_HEIGHT, type ListFlowModel } from "$lib/domain/list-column-flow";
import {
  buildListModel, buildListStructure, sizeListModel, listMoreExpansion, listCardVisibleRows, fullFlowGuideSpans, fullFlowGuideSegments, cardFades, cardMaxRows, cardMoreCount, cardRevealTop, cardVisibleRows, cardWheelConsumes,
  cardWindow, gripKeyRows, gripRows, rememberCardRows, springCardFits, springWrapBridges, LIST_CARD_DEFAULT_ROWS,
  listSpillCap, listSpillCut, SPRING_CARD_FIT, columnFlow,
} from "$lib/domain/list-cards";

// ---------------------------------------------------------------------------
// Fixture: the mock's TOP/KIDS/TREE_KIDS data (docs/execution-plans/folder-peek-mock.html).
const ROOT = "/r";
const D = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path: `${ROOT}/${path}`, kind: "directory", size: 0, modified: "" });
const F = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path: `${ROOT}/${path}`, kind: "file", size: 1, modified: "" });
const TOP = [
  ...["Inbox", "Career", "Codex", "Personal", "Archive", "AI Draft Archive"].map(D),
  ...["freeze-fix-guide.md", "Scrivo Sample.md", "Totality Dividends.xlsx", "Totality Trades History.xlsx", "numbers_backup.md", "bpay-2026-oct-receipt.png", "Revenue NSW.pdf", "bot_pat.txt", "numbers_backup_2.md"].map(F),
];
const FILLER = Array.from({ length: 75 }, (_, i) => F(`filler-${String(i).padStart(3, "0")}.txt`));
const archiveExtra = ["2018", "2019", "2020", "2021", "2022", "2023"].flatMap(y =>
  [`bank-statements-${y}.pdf`, `receipts-${y}.zip`, `notes-${y}.md`, `budget-${y}.xlsx`, `insurance-${y}.pdf`, `scan-${y}.jpg`, `misc-${y}.txt`]);
const kids = (parent: string, dirs: string[], files: string[]) => [...dirs.map(d => D(`${parent}/${d}`)), ...files.map(f => F(`${parent}/${f}`))];
const KIDS: Record<string, FileEntry[]> = {
  Inbox: kids("Inbox", ["to-file"], ["scan-0193.pdf", "invoice-oct.pdf", "meeting-notes.md", "screenshot-2026-10-15.png", "quote.txt"]),
  Career: kids("Career", ["Applications", "Cover Letters", "Portfolio"], ["Resume-2026.pdf", "Interview Prep.md", "References.docx", "salary-research.xlsx", "headshot.jpg", "offer-letter.pdf"]),
  Codex: kids("Codex", ["prompts", "sessions", "skills"], ["agents-guide.md", "config.toml", "notes.md", "rollout-2026-10-12.jsonl", "auth-flow.png", "todo.txt", "history.jsonl", "readme-notes.md", "mcp-servers.json", "rollout-2026-10-14.jsonl", "sandbox.log"]),
  Personal: kids("Personal", ["Health", "Travel", "Recipes"], Array.from({ length: 20 }, (_, i) => `personal-${i}.pdf`)),
  Archive: kids("Archive", ["2019", "2020", "2021", "2022", "2023"], ["taxes-2022.pdf", "old-notes.md", "scans.zip", ...archiveExtra]),
  "AI Draft Archive": kids("AI Draft Archive", ["drafts-2025"], ["essay-v3.md", "outline.md", "cover-image.png", "prompts.txt", "essay-v1.md", "essay-v2.md", "notes-chat.md", "references.docx", "figure-1.png", "summary.pdf"]),
  "Career/Applications": kids("Career/Applications", ["Acme Corp", "Globex", "Initech"], ["tracker.xlsx", "follow-ups.md"]),
  "Career/Applications/Acme Corp": kids("Career/Applications/Acme Corp", [], ["cover-letter.pdf", "notes.md"]),
  "Career/Applications/Globex": kids("Career/Applications/Globex", [], ["application.pdf", "interview.md"]),
  "Career/Applications/Initech": kids("Career/Applications/Initech", [], ["resume.pdf", "contacts.txt"]),
  "Career/Cover Letters": kids("Career/Cover Letters", [], ["general.pdf", "draft.md"]),
  "Career/Portfolio": kids("Career/Portfolio", [], ["case-study.pdf", "preview.png"]),
  "Codex/prompts": kids("Codex/prompts", [], ["system.md", "review.md"]),
  "Codex/sessions": kids("Codex/sessions", [], ["session-notes.md", "summary.txt"]),
  "Codex/skills": kids("Codex/skills", [], ["workflow.md"]),
  "Archive/2019": kids("Archive/2019", [], ["taxes-2019.pdf", "notes.md"]),
  "Archive/2020": kids("Archive/2020", [], ["taxes-2020.pdf", "notes.md"]),
  "Archive/2023": kids("Archive/2023", [], ["taxes-2023.pdf", "receipts.zip"]),
  "Inbox/to-file": kids("Inbox/to-file", [], ["receipt.pdf", "notes.txt"]),
  "Personal/Health": kids("Personal/Health", [], ["checkup.pdf", "appointments.md"]),
  "AI Draft Archive/drafts-2025": kids("AI Draft Archive/drafts-2025", [], ["essay.md", "outline.txt"]),
};
const listingOf = (path: string): PeekListing | undefined => {
  const entries = KIDS[path.slice(ROOT.length + 1)];
  return entries ? { status: "loaded", entries } : undefined;
};

/** The real phase-1 projection: flattened tree, then the row model with pseudo-rows. */
function rowsFor(top: readonly FileEntry[], expanded: readonly string[], listing = listingOf, creating = false) {
  const tree = flattenPeekEntries({
    root: ROOT, entries: top, expanded: new Map(expanded.map((path, i) => [`${ROOT}/${path}`, i])),
    listing: path => listing(path)?.entries, project: entries => entries, capability: "tree", windows: false,
  });
  return { tree, rows: buildPeekRows(tree, listing, creating) };
}
type Heights = Record<string, number>;
const modelFor = (expanded: readonly string[], R = 6, heights: Heights = {}, top: readonly FileEntry[] = TOP) =>
  buildListModel(rowsFor(top, expanded).rows, R, path => heights[path.slice(ROOT.length + 1)]);
const nameOf = (model: ListFlowModel, index: number) => {
  const item = model.items[index];
  return item.card ? item.card.path.slice(ROOT.length + 1) : item.key.slice(`entry:${ROOT}/`.length);
};
const positions = (model: ListFlowModel) => Object.fromEntries(model.layout.byIndex.map(p => [nameOf(model, p.index), [p.column, p.row]]));
const names = (model: ListFlowModel) => model.layout.columns.map(column => column.map(p => nameOf(model, p.index)));

describe("card height clamp", () => {
  it("ports the mock's card slot counts (whole rows, header plus visible rows)", () => {
    expect([[48, 6], [3, 6], [0, 6]].map(([n, p]) => 1 + cardVisibleRows(n, p, 21))).toEqual([7, 4, 1]);
    expect([1 + cardVisibleRows(48, 2.6, 21), 1 + cardVisibleRows(3, 0, 21)]).toEqual([4, 2]);
  });
  it("caps preferred rows at 70% of a column so a card always fits one column", () => {
    expect([4, 6, 9, 21].map(R => cardVisibleRows(100, 100, R))).toEqual([2, 4, 6, 14]);
    for (let R = 4; R <= 200; R++) expect(1 + cardVisibleRows(10_000, 10_000, R)).toBeLessThanOrEqual(R);
    expect(cardMaxRows(4)).toBe(2);
    expect(cardVisibleRows(10, Number.NaN, 21)).toBe(LIST_CARD_DEFAULT_ROWS);
    expect(cardVisibleRows(-3, 6, 21)).toBe(0);
    expect(cardVisibleRows(Number.POSITIVE_INFINITY, 6, 21)).toBe(0);
    expect(cardVisibleRows(10, Number.POSITIVE_INFINITY, 21)).toBe(LIST_CARD_DEFAULT_ROWS);
  });
});

describe("List structure and sizing", () => {
  it("re-sizes cards for a new R without rebuilding plain items, and matches a full build", () => {
    const rows = rowsFor(TOP, ["Archive"]).rows;
    const structure = buildListStructure(rows);
    expect(structure.cards).toHaveLength(1);
    const [card] = structure.cards;
    const tall = sizeListModel(structure, 20, () => 12), short = sizeListModel(structure, 8, () => 12);
    expect(tall.items[card].card?.visibleRows).toBe(12);
    // Archive heads row 4 of 8: it opens in place, shrunk to the 3 rows left (#1365).
    expect(short.layout.byIndex[card]).toMatchObject({ column: 0, row: 4 });
    expect(short.items[card].card?.visibleRows).toBe(3);
    // Plain items keep their identity across sizes; the card item is re-sized.
    expect(short.items.filter((item, index) => index !== card && item !== tall.items[index])).toEqual([]);
    const full = buildListModel(rows, 8, () => 12);
    expect([short.items, short.layout.byIndex, short.entryItem, short.entryOffset]).toEqual([full.items, full.layout.byIndex, full.entryItem, full.entryOffset]);
  });
  it("allocates no item copies while no card is open", () => {
    const structure = buildListStructure(rowsFor(TOP, []).rows);
    expect(structure.cards).toEqual([]);
    expect(sizeListModel(structure, 4, () => undefined).items).toBe(structure.items);
    expect(sizeListModel(structure, 9, () => undefined).items).toBe(structure.items);
  });
});

describe("buildListModel (ports the mock selfTest)", () => {
  const basePaths = [
    ["Inbox", "Career", "Codex", "Personal", "Archive", "AI Draft Archive"],
    ["freeze-fix-guide.md", "Scrivo Sample.md", "Totality Dividends.xlsx", "Totality Trades History.xlsx", "numbers_backup.md", "bpay-2026-oct-receipt.png"],
    ["Revenue NSW.pdf", "bot_pat.txt", "numbers_backup_2.md"],
  ];
  it("lays closed items out column by column", () => {
    const base = modelFor([]);
    expect(names(base)).toEqual(basePaths);
    expect(base.layout.columns.map(column => column.map(p => p.row))).toEqual([[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5], [0, 1, 2]]);
    expect(base.items.every(item => !item.card)).toBe(true);
  });
  it("opens a card in place and shifts every later item by exactly its added slots", () => {
    const career = modelFor(["Career"]);
    const card = career.layout.byIndex[1];
    expect(positions(career).Career).toEqual([0, 1]);
    expect([card.row, card.slots]).toEqual([1, 5]);
    career.layout.byIndex.slice(2).forEach((p, i) => expect(p.column * 6 + p.row - (i + 2)).toBe(card.slots - 1));
  });
  it("wraps a card that does not fit to the next column, leaving a tail gap", () => {
    const ai = modelFor(["AI Draft Archive"]);
    expect(positions(ai)["AI Draft Archive"]).toEqual([1, 0]);
    expect(ai.layout.columns[0].map(p => [nameOf(ai, p.index), p.row])).toEqual(TOP.slice(0, 5).map((item, i) => [item.name, i]));
    expect(positions(ai)["freeze-fix-guide.md"]).toEqual([1, 5]);
    expect(ai.layout.atSlot(0, 5)).toBeUndefined();
  });
  // Spring-loaded peeks (#1242): `springCardFits` from the drag's temporary paths.
  const springModel = (top: readonly FileEntry[], expanded: readonly string[], temporary: readonly string[], R: number, listing = listingOf) => {
    const { rows } = rowsFor(top, expanded, listing);
    const structure = buildListStructure(rows);
    const paths = temporary.map(path => `${ROOT}/${path}`);
    return { model: sizeListModel(structure, R, () => undefined, springCardFits(structure, paths)), paths };
  };
  it("a temporary card keeps its place when its header and two rows fit there, shrinking to the rows left", () => {
    // Personal (row 3 of 6) has three slots left: header plus two rows, in place.
    const { model } = springModel(TOP, ["Personal"], ["Personal"], 6);
    expect(positions(model).Personal).toEqual([0, 3]);
    expect(model.items[3].card).toMatchObject({ visibleRows: 2 });
    // A user card in the same place follows the same rule (#1365); a temporary card that fits is unchanged.
    expect(positions(modelFor(["Personal"])).Personal).toEqual([0, 3]);
    expect(springModel(TOP, ["Inbox"], ["Inbox"], 21).model.layout.byIndex).toEqual(modelFor(["Inbox"], 21).layout.byIndex);
  });
  it("a temporary card with fewer than two rows left starts the next column, whatever its listing holds", () => {
    // AI Draft Archive sits in the column's last row: no header-only card.
    const { model, paths } = springModel(TOP, ["AI Draft Archive"], ["AI Draft Archive"], 6);
    expect(positions(model)["AI Draft Archive"]).toEqual([1, 0]);
    expect(model.items[5].card!.visibleRows).toBe(cardMaxRows(6));
    expect(springWrapBridges(model, paths).length).toBeGreaterThan(0);
    // Two slots left fit a one-row folder, but the choice must not change as its
    // listing loads (a header-only Loading card, then its row): it wraps both times.
    const top = [F("a"), F("b"), F("c"), F("d"), D("One"), F("z")];
    const one = (status: "loading" | "loaded") => (path: string): PeekListing | undefined => path === `${ROOT}/One`
      ? (status === "loaded" ? { status, entries: [F("One/x")] } : { status, entries: [], showLoading: false }) : undefined;
    for (const status of ["loading", "loaded"] as const) {
      expect(positions(springModel(top, ["One"], ["One"], 6, one(status)).model).One).toEqual([1, 0]);
      // A user card there follows the same rule (#1365).
      expect(positions(buildListModel(rowsFor(top, ["One"], one(status)).rows, 6, () => undefined)).One).toEqual([1, 0]);
    }
  });
  it("a card holding a temporary peek keeps its place, so springing a nested folder never moves the card", () => {
    // Career (rows 1..5 of 6) grows when Applications springs open inside it.
    const before = modelFor(["Career"]);
    const { model } = springModel(TOP, ["Career", "Career/Applications"], ["Career/Applications"], 6);
    expect(positions(model).Career).toEqual(positions(before).Career);
    expect(model.layout.byIndex[1].slots).toBe(before.layout.byIndex[1].slots);
    // At R=4 the grown user card wraps; holding the temporary peek it stays.
    expect(positions(modelFor(["Career"], 4)).Career).toEqual([0, 1]);
    expect(positions(modelFor(["Career", "Career/Applications"], 4)).Career).toEqual([0, 1]);
    expect(positions(springModel(TOP, ["Career", "Career/Applications"], ["Career/Applications"], 4).model).Career).toEqual([0, 1]);
    const plain = rowsFor(TOP, ["Career"]).rows;
    expect(springCardFits(buildListStructure(plain), [])).toBeUndefined();
  });
  it("a card that had started the next column keeps starting it when a nested folder springs open inside it", () => {
    // AI Draft Archive holds column 0's last row, so as a user card it starts column 1.
    const before = modelFor(["AI Draft Archive"]);
    expect(positions(before)["AI Draft Archive"]).toEqual([1, 0]);
    const nested = ["AI Draft Archive", "AI Draft Archive/drafts-2025"];
    const { model } = springModel(TOP, nested, ["AI Draft Archive/drafts-2025"], 6);
    expect(positions(model)["AI Draft Archive"]).toEqual([1, 0]);
    expect(model.items[5].card!.visibleRows).toBe(before.items[5].card!.visibleRows);
    // Its temporary rows do not count towards the place it had: a shorter card
    // that fitted in place stays there however many rows the spring adds.
    const top = [F("a"), F("b"), F("c"), D("Two"), F("z")];
    const two = (path: string): PeekListing | undefined => path === `${ROOT}/Two` ? { status: "loaded", entries: [D("Two/Deep"), F("Two/x")] }
      : path === `${ROOT}/Two/Deep` ? { status: "loaded", entries: Array.from({ length: 9 }, (_, i) => F(`Two/Deep/${i}`)) } : undefined;
    expect(positions(buildListModel(rowsFor(top, ["Two"], two).rows, 6, () => undefined)).Two).toEqual([0, 3]);
    expect(positions(springModel(top, ["Two", "Two/Deep"], ["Two/Deep"], 6, two).model).Two).toEqual([0, 3]);
    // Opened by the user, the same nested expansion keeps the card in place too (#1365).
    expect(positions(buildListModel(rowsFor(top, ["Two", "Two/Deep"], two).rows, 6, () => undefined)).Two).toEqual([0, 3]);
  });
  it("bridges a wrapped temporary card from its vacated slot: both columns' spare rows and the gap channel", () => {
    const { model, paths } = springModel(TOP, ["AI Draft Archive"], ["AI Draft Archive"], 6);
    const [H, W, S] = [LIST_SLOT_HEIGHT, LIST_COLUMN_WIDTH, LIST_COLUMN_STRIDE];
    const path = `${ROOT}/AI Draft Archive`;
    expect(model.layout.byIndex[5].slots).toBe(5);
    const bridges = springWrapBridges(model, paths);
    expect(bridges).toEqual([
      { path, left: 0, top: 5 * H, width: S, height: H }, // its old slot and the gap beside it
      { path, left: S, top: 5 * H, width: W, height: H }, // below the card in its new column
      { path, left: W, top: 0, width: S - W, height: 5 * H }, // the gap channel up to the card
    ]);
    // The card ends its column, so the items it displaced start the one after and
    // every bridge covers empty space: a displaced row still takes its own drop.
    expect(positions(model)["freeze-fix-guide.md"]).toEqual([2, 0]);
    expect(model.layout.columns[1].map(p => p.index)).toEqual([5]);
    for (const p of model.layout.byIndex) {
      const box = { left: p.column * S, top: p.row * H, right: p.column * S + W, bottom: (p.row + p.slots) * H };
      for (const b of bridges) {
        const overlaps = b.left < box.right && box.left < b.left + b.width && b.top < box.bottom && box.top < b.top + b.height;
        expect({ item: nameOf(model, p.index), overlaps }).toEqual({ item: nameOf(model, p.index), overlaps: false });
      }
    }
    // Only temporary cards that wrapped are bridged: not a user card, not one in place.
    expect(springWrapBridges(modelFor(["AI Draft Archive"]), [`${ROOT}/Inbox`])).toEqual([]);
    expect(springWrapBridges(springModel(TOP, ["Personal"], ["Personal"], 6).model, [`${ROOT}/Personal`])).toEqual([]);
    expect(springWrapBridges(model, [])).toEqual([]);
  });
  it("a minimal reveal of a wrapped card leaves a pointer from its old slot inside a bridge or on the card", () => {
    const { model, paths } = springModel(TOP, ["AI Draft Archive"], ["AI Draft Archive"], 6);
    const bridges = springWrapBridges(model, paths);
    const card = model.layout.byIndex[5];
    const left = card.column * LIST_COLUMN_STRIDE;
    const onCard = (x: number, y: number) => x >= left && x < left + LIST_COLUMN_WIDTH && y < card.slots * LIST_SLOT_HEIGHT;
    const inside = (x: number, y: number) => onCard(x, y) || bridges.some(b => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height);
    // Any point of the old slot, shifted right by any scroll up to the card column's far edge.
    for (let x = 0; x < LIST_COLUMN_WIDTH; x += 13) {
      for (let shift = 0; x + shift < left + LIST_COLUMN_WIDTH; shift += 17) expect(inside(x + shift, 5.5 * LIST_SLOT_HEIGHT)).toBe(true);
    }
  });
  it("columnFlow keeps a card with a valid fit in place while that many slots are left, else wraps it", () => {
    const item = (slots: number, fit?: number) => ({ slots, card: slots > 1, ...(fit === undefined ? {} : { fit }) });
    const flow = (specs: { slots: number; card: boolean; fit?: number }[]) => columnFlow(specs, 6, spec => spec).byIndex.map(p => [p.column, p.row, p.slots]);
    const three = [item(1), item(1), item(1)];
    expect(flow([...three, item(5, 1)])).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 3]]);
    expect(flow([...three, item(5, 4)])).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1], [1, 0, 5]]);
    // Fewer than `fit` slots left wraps even a card that would fit there.
    expect(flow([...three, item(1), item(2, 3)])).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 1], [1, 0, 2]]);
    expect(flow([...three, item(1), item(2)])).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 2]]);
    // A fit larger than a column never leaves an empty column.
    expect(flow([item(3, 9)])).toEqual([[0, 0, 3]]);
    for (const fit of [0, -1, 1.5, Number.NaN]) expect(flow([...three, item(5, fit)])).toEqual([[0, 0, 1], [0, 1, 1], [0, 2, 1], [1, 0, 5]]);
    // A plain item never shrinks or grows.
    expect(flow([item(1), item(1, 1)])).toEqual([[0, 0, 1], [0, 1, 1]]);
  });
  it("columnFlow ends the column after a card that `alone` wrapped, and only then", () => {
    const flow = (specs: { slots: number; card: boolean; fit?: number; alone?: boolean }[]) => columnFlow(specs, 6, spec => spec).byIndex.map(p => [p.column, p.row, p.slots]);
    const plain = { slots: 1, card: false };
    const four = [plain, plain, plain, plain, plain];
    expect(flow([...four, { slots: 3, card: true, fit: 3, alone: true }, plain])).toEqual([...four.map((_, i) => [0, i, 1]), [1, 0, 3], [2, 0, 1]]);
    // Without `alone`, or in place, the next item follows the card.
    expect(flow([...four, { slots: 3, card: true, fit: 3 }, plain])).toEqual([...four.map((_, i) => [0, i, 1]), [1, 0, 3], [1, 3, 1]]);
    expect(flow([plain, { slots: 3, card: true, fit: 3, alone: true }, plain])).toEqual([[0, 0, 1], [0, 1, 3], [0, 4, 1]]);
    expect(flow([{ slots: 3, card: true, fit: 3, alone: true }, plain])).toEqual([[0, 0, 3], [0, 3, 1]]);
  });
  it("puts nested expansion inside the card, in tree order, and maps entries to their card", () => {
    const { rows, tree } = rowsFor(TOP, ["Career", "Career/Applications"]);
    const model = buildListModel(rows, 6, () => undefined);
    const card = model.items[1].card!;
    const content = rows.rows.slice(card.start, card.end).map(row => row.kind === "entry" ? row.entry.path.slice(3) : row.kind);
    const careerKids = KIDS.Career.map(e => e.path.slice(3));
    expect(content).toEqual([careerKids[0], ...KIDS["Career/Applications"].map(e => e.path.slice(3)), ...careerKids.slice(1)]);
    expect(model.items).toHaveLength(TOP.length);
    // Every descendant entry belongs to the Career card at its content offset.
    tree.entries.forEach((entry, index) => {
      const depth = tree.meta.get(entry.path)!.depth;
      expect(model.entryItem[index]).toBe(depth ? 1 : TOP.indexOf(entry));
      if (depth) expect(rows.rows[card.start + model.entryOffset[index]]).toMatchObject({ kind: "entry", entry });
      else expect(model.entryOffset[index]).toBe(-1);
    });
  });
  it("closing restores the original layout and reopening restores nested expansion, with no history", () => {
    expect(names(modelFor(["Career/Applications"]))).toEqual(basePaths);
    expect(modelFor(["Career/Applications", "Career"]).layout.byIndex).toEqual(modelFor(["Career", "Career/Applications"]).layout.byIndex);
  });
  it("draws a header-only card until a listing yields a row, then a pseudo-row for an empty folder", () => {
    const top = [D("Empty"), F("one")];
    const loading = buildListModel(rowsFor(top, ["Empty"], () => ({ status: "loading", entries: [], showLoading: false })).rows, 4, () => undefined);
    expect(loading.layout.byIndex.map(p => [p.row, p.slots])).toEqual([[0, 1], [1, 1]]);
    expect(loading.items[0].card).toMatchObject({ visibleRows: 0 });
    const empty = buildListModel(rowsFor(top, ["Empty"], () => ({ status: "loaded", entries: [] })).rows, 4, () => undefined);
    expect(empty.layout.byIndex.map(p => [p.row, p.slots])).toEqual([[0, 2], [2, 1]]);
    const failed = buildListModel(rowsFor(top, ["Empty"], () => ({ status: "error", entries: [], error: "denied" })).rows, 4, () => undefined);
    expect(failed.items[0].card).toMatchObject({ visibleRows: 1 });
    expect(columnFlow([], 4, () => ({ slots: 1, card: false })).columns).toEqual([]);
    expect(buildListModel(flatPeekRows(flatPeekEntries(ROOT, []), false), 4, () => undefined).items).toEqual([]);
  });
  it("keeps the creation row as a non-entry top-level item", () => {
    const model = buildListModel(rowsFor(TOP, ["Career"], listingOf, true).rows, 6, () => undefined);
    expect(model.items[0]).toEqual({ key: "create", entryIndex: null, card: null });
    // Sentinel, Inbox, then the card in place, shrunk to the 4 slots left (#1365).
    expect(positions(model).Career).toEqual([0, 2]);
    expect(model.layout.byIndex[2].slots).toBe(4);
    expect(model.entryItem[0]).toBe(1);
  });
  it("applies remembered heights through the clamp and places a card at the end of the flow", () => {
    const tall = modelFor(["Career"], 6, { Career: 50 });
    expect(tall.items[1].card!.visibleRows).toBe(cardMaxRows(6));
    const last = [...TOP.slice(0, 5), F("z.txt"), D("Zed")];
    const zed = buildListModel(rowsFor(last, ["Zed"], () => ({ status: "loaded", entries: Array.from({ length: 30 }, (_, i) => F(`Zed/${i}.txt`)) })).rows, 6, () => 2).layout;
    expect(zed.byIndex.at(-1)).toEqual({ index: 6, column: 1, row: 0, slots: 3 });
    expect(zed.columns).toHaveLength(2);
  });
  it("tolerates malformed row models: orphan rows become plain items, every entry keeps an owner", () => {
    const { rows } = rowsFor(TOP, ["Career"]);
    const broken = { ...rows, groups: rows.groups.map(group => ({ ...group, startRow: group.startRow + 1 })) };
    const model = buildListModel(broken, 6, () => undefined);
    expect([...model.entryItem].every(item => item >= 0 && item < model.items.length)).toBe(true);
    expect(model.items.every(item => !item.card)).toBe(true);
    const truncated = { ...rows, groups: rows.groups.map(group => ({ ...group, endRow: 10_000 })) };
    expect(() => buildListModel(truncated, 6, () => undefined)).not.toThrow();
    expect(() => modelFor([], 3)).toThrow(RangeError);
    expect(() => modelFor([], Number.NaN)).toThrow(RangeError);
  });
  it("builds 10,000 entries with several 5,000-row cards quickly and without a slot matrix", () => {
    const top = Array.from({ length: 10_000 }, (_, i) => (i % 16 ? F : D)(`item-${String(i).padStart(5, "0")}`));
    const open = top.filter(e => e.kind === "directory").slice(0, 4).map(e => e.name);
    const big = (path: string): PeekListing => ({ status: "loaded", entries: Array.from({ length: 5000 }, (_, i) => F(`${path.slice(3)}/c-${i}`)) });
    const started = performance.now();
    const { rows } = rowsFor(top, open, big);
    const model = buildListModel(rows, 21, () => undefined);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(model.items).toHaveLength(10_000);
    expect(model.entryItem).toHaveLength(30_000);
    expect(model.items.filter(item => item.card).map(item => item.card!.visibleRows)).toEqual([6, 6, 6, 6]);
    expect(model.layout.atSlot(model.layout.columns.length - 1, 0)).toBeDefined();
  });
  it("matches an independent slot oracle through seeded toggles and resizes, without history", () => {
    const toggles = Object.keys(KIDS);
    const oracle = (items: readonly FileEntry[], R: number, expanded: Set<string>, heights: Heights) => {
      let index = 0;
      return items.map(item => {
        const tree = rowsFor([item], [...expanded]).rows;
        const content = tree.rows.length - 1;
        const card = item.kind === "directory" && expanded.has(item.name);
        let slots = card ? 1 + Math.min(content, Math.max(1, Math.min(Math.round(heights[item.name] ?? 6), Math.floor(0.7 * R)))) : 1;
        // An open folder keeps its place while its header and two rows fit (#1365).
        if (card && index % R > 0 && R - index % R < 3) index += R - index % R;
        if (card) slots = Math.min(slots, R - index % R);
        const position = [item.name, Math.floor(index / R), index % R, slots];
        index += slots;
        return position;
      });
    };
    let seed = 0x51c0ffee;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
    for (const R of [4, 6, 9, 21]) for (const items of [TOP, [...TOP, ...FILLER]]) {
      let expanded = new Set<string>(), heights: Heights = {};
      const compute = () => modelFor([...expanded], R, heights, items);
      const signature = (model: ListFlowModel) => model.layout.byIndex.map(p => [nameOf(model, p.index), p.column, p.row, p.slots]);
      for (let step = 0; step < 120; step++) {
        const before = positions(compute());
        const resize = random(4) === 0;
        const path = resize ? TOP[random(6)].name : toggles[random(toggles.length)];
        const root = path.split("/")[0];
        const opening = !resize && !expanded.has(path);
        if (resize) heights = { ...heights, [root]: 1 + random(R * 3) };
        else expanded = new Set(opening ? [...expanded, path] : [...expanded].filter(p => p !== path));
        const after = compute();
        const columns = after.layout.columns;
        columns.forEach((column, c) => {
          let end = 0;
          for (const p of column) { expect(p.row).toBe(end); end = p.row + p.slots; expect(end).toBeLessThanOrEqual(R); }
          // A column ends early only for an open folder with fewer than three slots left.
          if (end < R && c < columns.length - 1) {
            expect(R - end).toBeLessThan(3);
            expect(after.items[columns[c + 1][0].index].card).not.toBeNull();
          }
        });
        expect(signature(after)).toEqual(oracle(items, R, expanded, heights).map(([name, c, r, s]) => [name, c, r, s]));
        const afterPos = positions(after);
        for (const item of items.slice(0, items.findIndex(item => item.name === root))) expect(afterPos[item.name]).toEqual(before[item.name]);
        if (opening && path === root) {
          const [c, r] = before[root];
          const slots = after.layout.byIndex[items.findIndex(item => item.name === root)].slots;
          expect(slots).toBeLessThanOrEqual(R - afterPos[root][1]);
          expect(afterPos[root]).toEqual(r === 0 || R - r >= 3 ? [c, r] : [c + 1, 0]);
        }
      }
      expect(signature(modelFor([], R, heights, items))).toEqual(signature(modelFor([], R, {}, items)));
    }
  });
});

describe("card grip, scroll edges and reveal", () => {
  it("snaps grip travel to whole rows within 1..min(content, 70% of R)", () => {
    expect(gripRows(6, 44, 40, 21)).toBe(7);
    expect(gripRows(6, 46, 40, 21)).toBe(8);
    expect(gripRows(6, -1000, 40, 21)).toBe(1);
    expect(gripRows(6, 10_000, 40, 21)).toBe(14);
    expect(gripRows(6, 10_000, 9, 21)).toBe(9);
    expect(gripRows(6, Number.NaN, 40, 21)).toBe(6);
    expect(gripRows(3, 0, 0, 21)).toBe(0);
  });
  it("resizes by one row per arrow and jumps to the ends with Home/End", () => {
    expect(["ArrowUp", "ArrowDown", "Home", "End", "Enter"].map(key => gripKeyRows(key, 6, 40, 21))).toEqual([5, 7, 1, 14, null]);
    expect(gripKeyRows("ArrowUp", 1, 40, 21)).toBe(1);
    expect(gripKeyRows("ArrowDown", 9, 9, 21)).toBe(9);
    expect(gripKeyRows("End", 2, 5, 4)).toBe(2);
  });
  it("never grows past the rows left in the card's column, so a resize cannot move the card", () => {
    // R = 10, header at row 3: six rows remain below it.
    expect(gripRows(6, 10_000, 40, 10, 6)).toBe(6);
    expect(gripRows(4, 30, 40, 10, 6)).toBe(5);
    expect(gripRows(6, -1000, 40, 10, 6)).toBe(1);
    expect(["ArrowDown", "End", "ArrowUp", "Home"].map(key => gripKeyRows(key, 6, 40, 10, 6))).toEqual([6, 6, 5, 1]);
    // No rows left still allows one (never zero), and empty content stays empty.
    expect(gripRows(6, 0, 40, 10, 0)).toBe(1);
    expect(gripRows(3, 0, 0, 21, 5)).toBe(0);
    expect(gripRows(6, 10_000, 40, 10, Number.NaN)).toBe(7);
  });
  it("counts rows whose centre lies below the visible area", () => {
    expect(cardMoreCount(10, 6, 0)).toBe(4);
    expect(cardMoreCount(10, 6, 15)).toBe(3);
    expect(cardMoreCount(10, 6, 16)).toBe(3);
    expect(cardMoreCount(10, 6, 120)).toBe(0);
    expect(cardMoreCount(6, 6, 0)).toBe(0);
    expect(cardMoreCount(0, 0, 0)).toBe(0);
    expect(cardMoreCount(10, 6, Number.NaN)).toBe(4);
    expect(cardMoreCount(10_000, 6, 1e9)).toBe(0);
  });
  it("shows a fade only on an edge with content scrolled out of view", () => {
    expect(cardFades(10, 6, 0)).toEqual({ top: false, bottom: true });
    expect(cardFades(10, 6, 60)).toEqual({ top: true, bottom: true });
    expect(cardFades(10, 6, 120)).toEqual({ top: true, bottom: false });
    expect(cardFades(10, 6, 119.5)).toEqual({ top: true, bottom: false });
    expect(cardFades(3, 3, 0)).toEqual({ top: false, bottom: false });
  });
  it("reveals a content row with the minimal scroll", () => {
    expect(cardRevealTop(0, 6, 0)).toBe(0);
    expect(cardRevealTop(6, 6, 0)).toBe(30);
    expect(cardRevealTop(9, 6, 0)).toBe(120);
    expect(cardRevealTop(2, 6, 120)).toBe(60);
    expect(cardRevealTop(5, 6, 60)).toBe(60);
    expect(cardRevealTop(4, 6, Number.NaN)).toBe(0);
  });
  it("windows card content to the visible rows plus overscan", () => {
    expect(cardWindow(5000, 6, 0)).toEqual({ start: 0, end: 8 });
    expect(cardWindow(5000, 6, 3000)).toEqual({ start: 98, end: 108 });
    expect(cardWindow(5000, 6, 1e12)).toEqual({ start: 4992, end: 5000 });
    expect(cardWindow(0, 0, 0)).toEqual({ start: 0, end: 0 });
  });
  it("consumes vertical wheel only while the card can still scroll that way", () => {
    const wheel = (deltaY: number, extra = {}) => ({ deltaX: 0, deltaY, ctrlKey: false, ...extra });
    expect(cardWheelConsumes(wheel(40), 0, 120)).toBe(true);
    expect(cardWheelConsumes(wheel(40), 120, 120)).toBe(false);
    expect(cardWheelConsumes(wheel(-40), 0, 120)).toBe(false);
    expect(cardWheelConsumes(wheel(-40), 30, 120)).toBe(true);
    expect(cardWheelConsumes(wheel(40, { ctrlKey: true }), 0, 120)).toBe(false);
    expect(cardWheelConsumes(wheel(40, { deltaX: 60 }), 0, 120)).toBe(false);
    expect(cardWheelConsumes(wheel(Number.NaN), 0, 120)).toBe(false);
    expect(cardWheelConsumes(wheel(40), 0, 0)).toBe(false);
  });
  it("remembers card heights per path, most recent last, bounded", () => {
    let heights: ReadonlyMap<string, number> = new Map();
    for (let i = 0; i < 502; i++) heights = rememberCardRows(heights, `/r/${i}`, 3);
    expect(heights.size).toBe(500);
    expect(heights.has("/r/0")).toBe(false);
    heights = rememberCardRows(heights, "/r/2", 9.4);
    expect([...heights.keys()].at(-1)).toBe("/r/2");
    expect(heights.get("/r/2")).toBe(9);
    expect(rememberCardRows(heights, "/r/2", Number.NaN).has("/r/2")).toBe(false);
  });
});

describe("List moves with cards", () => {
  // R=6: Inbox | Career card (header + 4 visible of 9) | Codex ; next column ...
  const setup = (scroll: Record<string, number> = {}) => {
    const { rows, tree } = rowsFor(TOP, ["Career"]);
    const model = buildListModel(rows, 6, () => undefined);
    const index = (path: string) => tree.entries.findIndex(e => e.path === `${ROOT}/${path}`);
    const move = (key: string, from: string, modifiers = {}) => {
      const result = resolveListMove({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers }, model, index(from), 500,
        path => scroll[path.slice(ROOT.length + 1)] ?? 0);
      return result?.kind === "focus" ? tree.entries[result.index].path.slice(ROOT.length + 1) : result?.kind;
    };
    return { model, move };
  };
  it("passes Up/Down through a card's rows and stops at the column's ends", () => {
    const { move } = setup();
    expect(move("ArrowDown", "Inbox")).toBe("Career");
    expect(move("ArrowDown", "Career")).toBe("Career/Applications");
    expect(move("ArrowDown", "Career/Applications")).toBe("Career/Cover Letters");
    expect(move("ArrowUp", "Career/Applications")).toBe("Career");
    expect(move("ArrowUp", "Inbox")).toBe("handled");
    // Column 0 is Inbox then the Career card (rows 1-5); its last descendant is
    // the column's end, and Codex starts column 1.
    expect(move("ArrowDown", "Career/offer-letter.pdf")).toBe("handled");
    expect(move("ArrowUp", "Codex")).toBe("handled");
    expect(move("ArrowDown", "Codex")).toBe("Personal");
  });
  it("moves Left/Right to the same on-screen row through the card's scroll", () => {
    const top = setup();
    // Column 1 row 2 is Archive; the card's first content row is drawn at row 2.
    expect(top.move("ArrowLeft", "Archive")).toBe("Career/Applications");
    expect(top.move("ArrowRight", "Career/Applications")).toBe("Archive");
    expect(top.move("ArrowLeft", "Personal")).toBe("Career");
    expect(top.move("ArrowLeft", "Codex")).toBe("Inbox");
    expect(top.move("ArrowRight", "Career/Resume-2026.pdf")).toBe("Scrivo Sample.md");
    const scrolled = setup({ Career: 90 });
    expect(scrolled.move("ArrowLeft", "Archive")).toBe("Career/Resume-2026.pdf");
    expect(scrolled.move("ArrowRight", "Career/Resume-2026.pdf")).toBe("Archive");
    // A row scrolled out of view behaves as the nearest visible card row.
    expect(scrolled.move("ArrowRight", "Career/Applications")).toBe("Archive");
    expect(top.move("ArrowLeft", "Inbox")).toBe("handled");
  });
  it("selects the first and last entries with Home/End and keeps modifiers", () => {
    const { move } = setup();
    expect(move("Home", "Codex")).toBe("Inbox");
    expect(move("End", "Inbox")).toBe("numbers_backup_2.md");
    expect(move("Home", "Inbox")).toBe("Inbox");
    expect(move("ArrowDown", "Career", { shiftKey: true })).toBe("Career/Applications");
  });
  it("skips pseudo-rows and never targets the creation sentinel", () => {
    const top = [D("A"), F("b"), F("c"), F("d"), F("e"), D("Empty"), F("f")];
    const listing = (path: string): PeekListing => path.endsWith("/Empty") ? { status: "loaded", entries: [] }
      : { status: "loaded", entries: [F("A/one"), D("A/Sub"), F("A/two")] };
    const { rows, tree } = rowsFor(top, ["A", "A/Sub", "Empty"], listing, true);
    const model = buildListModel(rows, 6, () => undefined);
    const at = (path: string) => tree.entries.findIndex(e => e.path === `${ROOT}/${path}`);
    const move = (key: string, from: string) => {
      const result = resolveListMove({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, model, at(from), 500);
      return result?.kind === "focus" ? tree.entries[result.index].path.slice(3) : result?.kind;
    };
    // Sub is empty: its "Empty folder" row is not an entry, so Down skips it.
    expect(move("ArrowDown", "A/Sub")).toBe("A/two");
    expect(move("ArrowUp", "A")).toBe("handled");
    // The creation sentinel holds column 0 row 0 but is never a target.
    expect(model.items[0].entryIndex).toBeNull();
    expect(move("ArrowLeft", "b")).toBe("A");
    expect(move("Home", "f")).toBe("A");
    // A card slot showing only a pseudo-row resolves to the card's header.
    const files = ["a", "b", "c", "d", "e", "f"].map(F);
    const second = rowsFor([...files, D("Empty"), F("g")], ["Empty"], listing);
    const secondModel = buildListModel(second.rows, 6, () => undefined);
    const result = resolveListMove({ key: "ArrowRight", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, secondModel,
      second.tree.entries.findIndex(e => e.path === `${ROOT}/b`), 500);
    expect(result?.kind === "focus" && second.tree.entries[result.index].name).toBe("Empty");
  });
  it("fails closed for malformed cursors and empty models", () => {
    const { model } = setup();
    const key = { key: "ArrowDown", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
    expect(resolveListMove(key, model, Number.NaN, 500)).toBeNull();
    expect(resolveListMove(key, model, model.entryItem.length, 500)).toBeNull();
    expect(resolveListMove({ ...key, altKey: true }, model, 0, 500)).toBeNull();
    const empty = buildListModel(flatPeekRows(flatPeekEntries(ROOT, []), false), 4, () => undefined);
    expect(resolveListMove(key, empty, -1, 500)).toEqual({ kind: "handled" });
  });
});


describe("full-flow List peeks (#1324)", () => {
  it("flows every descendant into normal columns and keeps nested entry mappings", () => {
    const { tree, rows } = rowsFor([D("Career"), F("after.txt")], ["Career", "Career/Applications"]);
    const structure = buildListStructure(rows, new Set(["/r/Career"]));
    const model = sizeListModel(structure, 6, () => 2);
    expect(model.items).toHaveLength(rows.rows.length);
    expect(model.items.every(item => item.card === null)).toBe(true);
    expect(model.layout.columns.length).toBeGreaterThan(2);
    tree.entries.forEach((_entry, index) => {
      const item = model.items[model.entryItem[index]];
      expect(item.entryIndex).toBe(index);
      expect(model.entryOffset[index]).toBe(-1);
    });
    const deep = tree.indices.get("/r/Career/Applications/tracker.xlsx")!;
    expect(model.items[model.entryItem[deep]].entryIndex).toBe(deep);
    expect(model.layout.byIndex[model.entryItem[tree.entries.length - 2]].column).toBeGreaterThan(0);
    expect(resolveListMove({ key: "End", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, model, 0, 500)).toMatchObject({ kind: "focus", index: tree.entries.length - 1 });
  });

  it("retains empty/error status rows as ordinary identified slots in full flow", () => {
    const listing = (path: string): PeekListing => path === "/r/Career"
      ? { status: "loaded", entries: [D("Career/Empty"), D("Career/Denied")] }
      : path.endsWith("Denied") ? { status: "error", entries: [], error: "permission denied" }
      : { status: "loaded", entries: [] };
    const { rows } = rowsFor([D("Career"), F("after.txt")], ["Career", "Career/Empty", "Career/Denied"], listing);
    const model = sizeListModel(buildListStructure(rows, new Set(["/r/Career"])), 4, () => 1);
    expect(model.items.map(item => item.key)).toEqual(rows.rows.map(row => row.key));
    for (const [index, row] of rows.rows.entries()) {
      if (row.kind !== "peek-state") continue;
      expect(model.items[index]).toMatchObject({ rowIndex: index, entryIndex: null, card: null });
      expect(model.layout.byIndex[index].slots).toBe(1);
    }
  });

  it("full flow applies to the chosen top-level group while other cards retain their grip height", () => {
    const { rows } = rowsFor([D("Career"), D("Codex")], ["Career", "Codex"]);
    const model = sizeListModel(buildListStructure(rows, new Set(["/r/Career"])), 10, () => 3);
    expect(model.items.filter(item => item.card).map(item => [item.card!.path, item.card!.visibleRows]))
      .toEqual([["/r/Codex", 3]]);
    expect(model.items.filter(item => item.key.startsWith("entry:/r/Career/")).length).toBe(KIDS.Career.length);
  });
});


it("horizontal navigation over a full-flow status chooses the nearest selectable row", () => {
  const listing = (path: string): PeekListing => ({ status: "loaded", entries: path === "/r/Career"
    ? [D("Career/Empty"), F("Career/after.txt")] : [] });
  const { rows } = rowsFor([F("a"), F("b"), F("c"), F("d"), D("Career")], ["Career", "Career/Empty"], listing);
  const model = sizeListModel(buildListStructure(rows, new Set(["/r/Career"])), 4, () => 1);
  expect(resolveListMove({ key: "ArrowRight", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, model, 2, 500))
    .toMatchObject({ kind: "focus", index: 5 });
});


it("full-flow nested guides split across columns without covering later siblings", () => {
  const listing = (path: string): PeekListing => ({ status: "loaded", entries: path === "/r/Career"
    ? [D("Career/Nested"), F("Career/after.txt")]
    : path === "/r/Career/Nested" ? Array.from({ length: 9 }, (_, index) => F(`Career/Nested/${index}`)) : [] });
  const { rows } = rowsFor([D("Career"), D("Codex")], ["Career", "Career/Nested", "Codex"], listing);
  const model = sizeListModel(buildListStructure(rows, new Set(["/r/Career"])), 4, () => 2);
  const spans = fullFlowGuideSpans(rows, model);
  expect(spans.map(span => span.path)).toEqual(["/r/Career/Nested"]);
  expect(fullFlowGuideSegments(spans, [0, 1, 2], 4)).toEqual([
    { path: "/r/Career/Nested", depth: 1, column: 0, top: 57, height: 55 },
    { path: "/r/Career/Nested", depth: 1, column: 1, top: -3, height: 115 },
    { path: "/r/Career/Nested", depth: 1, column: 2, top: -3, height: 85 },
  ]);
  expect(fullFlowGuideSegments(spans, [1], 4)).toHaveLength(1);
});


describe("staged List expansion (#1324)", () => {
  it("+N more spills a compact card, and every later stage's +N more shows all rows (#1365)", () => {
    expect(listMoreExpansion("card")).toBe("spill");
    expect(listMoreExpansion("spill")).toBe("full");
    expect(listMoreExpansion("column")).toBe("full");
    expect(listMoreExpansion("full")).toBe("full");
  });

  it("reserves the header slot, sizes with the viewport, and bounds malformed counts", () => {
    expect(listCardVisibleRows(80, 6, 10, true)).toBe(9);
    expect(listCardVisibleRows(80, 6, 20, true)).toBe(19);
    expect(listCardVisibleRows(2, 6, 20, true)).toBe(2);
    expect(listCardVisibleRows(Number.NaN, 6, 20, true)).toBe(0);
    expect(listCardVisibleRows(80, 6, 10, false)).toBe(6);
  });

  it("places a scrollable group in one whole column while other groups keep grip heights", () => {
    const { rows } = rowsFor([F("before.txt"), D("Career"), D("Codex")], ["Career", "Career/Applications", "Codex"]);
    const model = sizeListModel(buildListStructure(rows), 6, () => 2, undefined, new Set(["/r/Career"]));
    const index = model.items.findIndex(item => item.card?.path === "/r/Career");
    expect(model.items[index].card?.visibleRows).toBe(5);
    expect(model.layout.byIndex[index]).toMatchObject({ row: 0, slots: 6 });
    expect(model.items.find(item => item.card?.path === "/r/Codex")?.card?.visibleRows).toBe(2);
    expect(model.entryOffset.filter(offset => offset >= 0).length).toBeGreaterThan(5);
  });
});


describe("spill stage: +N more never moves the folder's header (#1365)", () => {
  const files = (count: number, prefix = "f") => Array.from({ length: count }, (_, i) => F(`${prefix}-${String(i).padStart(3, "0")}`));
  const bigListing = (size: number, extra: Record<string, FileEntry[]> = {}) => (path: string): PeekListing | undefined => {
    const key = path.slice(ROOT.length + 1);
    if (key === "Big") return { status: "loaded", entries: extra.Big ?? files(size, "Big/item") };
    return extra[key] ? { status: "loaded", entries: extra[key] } : undefined;
  };
  /** `before` plain files, then the open folder Big, then two files. */
  const scene = (before: number, size = 80, extra: Record<string, FileEntry[]> = {}, expanded: string[] = ["Big"]) =>
    rowsFor([...files(before), D("Big"), F("z-after-1"), F("z-after-2")], expanded, bigListing(size, extra));
  const BIG = `${ROOT}/Big`;
  const stageModel = (rows: ReturnType<typeof scene>["rows"], stage: "card" | "spill" | "full", R: number) =>
    sizeListModel(buildListStructure(rows, new Set(stage === "full" ? [BIG] : []), new Set(stage === "spill" ? [BIG] : [])), R, () => undefined);
  const headerOf = (model: ListFlowModel) => model.layout.byIndex[model.items.findIndex(item => item.key === `entry:${BIG}`)];
  const moreOf = (model: ListFlowModel) => {
    const index = model.items.findIndex(item => item.more);
    return index < 0 ? null : { item: model.items[index], placement: model.layout.byIndex[index] };
  };

  it("caps the spill at the rest of the header's column plus the next column", () => {
    expect([0, 4, 7, 9].map(row => listSpillCap(10, row))).toEqual([19, 15, 12, 10]);
    // A header on the last row spills into the next column only.
    expect(listSpillCap(10, 9)).toBe(10);
    // The cap follows R.
    expect([4, 6, 21].map(R => listSpillCap(R, 2))).toEqual([5, 9, 39]);
    // Malformed rows clamp into the column.
    expect([listSpillCap(10, -3), listSpillCap(10, 99), listSpillCap(10, Number.NaN)]).toEqual([19, 10, 19]);
  });

  it("cuts a group over the cap to cap - 1 rows plus one +N more slot for the rest", () => {
    expect(listSpillCut(80, 19)).toEqual({ shown: 18, hidden: 62 });
    expect(listSpillCut(19, 19)).toEqual({ shown: 19, hidden: 0 });
    expect(listSpillCut(20, 19)).toEqual({ shown: 18, hidden: 2 });
    expect(listSpillCut(0, 19)).toEqual({ shown: 0, hidden: 0 });
    expect(listSpillCut(Number.NaN, 19)).toEqual({ shown: 0, hidden: 0 });
  });

  for (const [label, before] of [["top", 0], ["middle", 4], ["third-from-last", 7]] as const) {
    it(`a header on the ${label} row keeps its place; rows fill its column and the next, ending in +N more`, () => {
      const R = 10;
      const { rows } = scene(before);
      const card = stageModel(rows, "card", R), spill = stageModel(rows, "spill", R);
      const header = headerOf(spill);
      expect(header).toEqual({ ...headerOf(card), slots: 1 });
      expect([header.column, header.row]).toEqual([0, before]);
      const cap = listSpillCap(R, header.row);
      // Every slot below the header in its column, then the whole next column.
      const slots = spill.layout.byIndex.filter(p => p.index > header.index && p.index <= header.index + cap);
      expect(slots.map(p => [p.column, p.row])).toEqual([
        ...Array.from({ length: R - header.row - 1 }, (_, i) => [0, header.row + 1 + i]),
        ...Array.from({ length: R }, (_, i) => [1, i]),
      ]);
      const more = moreOf(spill)!;
      expect(more.placement).toMatchObject({ column: 1, row: R - 1, slots: 1 });
      expect(more.item.more).toMatchObject({ path: BIG, count: 80 - (cap - 1) });
      // The rows the slot stands for start at its own peek row.
      expect(rows.rows[more.item.more!.rowIndex]).toMatchObject({ kind: "entry", entry: { path: `${BIG}/item-${String(cap - 1).padStart(3, "0")}` } });
      // Later items start the column after.
      expect(spill.layout.byIndex[spill.items.findIndex(item => item.key === `entry:${ROOT}/z-after-1`)]).toMatchObject({ column: 2, row: 0 });
    });
  }

  it("a folder opened with fewer than SPRING_CARD_FIT slots left starts the next column, and spills from there", () => {
    const R = 10;
    expect(SPRING_CARD_FIT).toBe(3);
    // Three slots left (row 7): in place, shrunk to its two rows.
    const inPlace = stageModel(scene(7).rows, "card", R);
    expect(headerOf(inPlace)).toMatchObject({ column: 0, row: 7, slots: 3 });
    // Two or one left (rows 8 and 9): the next column.
    for (const before of [8, 9]) {
      const { rows } = scene(before);
      for (const stage of ["card", "spill", "full"] as const) expect(headerOf(stageModel(rows, stage, R))).toMatchObject({ column: 1, row: 0 });
      // A header that could only reach the last row closed therefore spills
      // across its new column and the next: R - 1 + R slots.
      const more = moreOf(stageModel(rows, "spill", R))!;
      expect(more.placement).toMatchObject({ column: 2, row: R - 1 });
      expect(more.item.more!.count).toBe(80 - (listSpillCap(R, 0) - 1));
    }
  });

  it("never moves the header across compact, spill and full stages, at any row or column height", () => {
    for (const R of [4, 6, 10, 21]) for (let before = 0; before < 2 * R + 2; before++) {
      const { rows } = scene(before);
      const placements = (["card", "spill", "full"] as const).map(stage => {
        const { column, row } = headerOf(stageModel(rows, stage, R));
        return [column, row];
      });
      expect({ R, before, placements }).toEqual({ R, before, placements: [placements[0], placements[0], placements[0]] });
      // Items before the folder never move either.
      const closed = stageModel(scene(before, 80, {}, []).rows, "card", R);
      expect(stageModel(rows, "spill", R).layout.byIndex.slice(0, before)).toEqual(closed.layout.byIndex.slice(0, before));
    }
  });

  it("re-cuts when R changes, from the structure alone", () => {
    const { rows } = scene(4);
    const structure = buildListStructure(rows, new Set(), new Set([BIG]));
    for (const R of [6, 10, 21]) {
      const model = sizeListModel(structure, R, () => undefined);
      const header = headerOf(model), more = moreOf(model)!;
      expect(more.placement).toMatchObject({ column: header.column + 1, row: R - 1 });
      expect(more.item.more!.count).toBe(80 - (listSpillCap(R, header.row) - 1));
    }
  });

  it("shows every row with no +N more slot when the folder fits the cap, as in full flow", () => {
    const { rows } = scene(4, 12);
    const spill = stageModel(rows, "spill", 10), full = stageModel(rows, "full", 10);
    expect(moreOf(spill)).toBeNull();
    expect(spill.layout.byIndex).toEqual(full.layout.byIndex);
    expect(spill.items).toEqual(full.items);
  });

  it("hidden rows have no slot; keyboard moves cross the column break and End stops at the last shown row", () => {
    const R = 10;
    const { rows, tree } = rowsFor([F("a"), D("Big")], ["Big"], bigListing(80));
    const model = stageModel(rows, "spill", R);
    const at = (path: string) => tree.indices.get(`${ROOT}/${path}`)!;
    const key = (name: string) => ({ key: name, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    // Header on row 1: 8 rows below it, then 9 more rows plus +N more in column 1.
    const shown = listSpillCap(R, 1) - 1;
    for (let i = 0; i < 80; i++) expect(model.entryItem[at(`Big/item-${String(i).padStart(3, "0")}`)] >= 0).toBe(i < shown);
    // Right from the bottom of column 0 lands on the same row of column 1.
    const move = (name: string, from: string) => {
      const result = resolveListMove(key(name), model, at(from), 600);
      return result?.kind === "focus" ? tree.entries[result.index].path.slice(ROOT.length + 1) : result?.kind;
    };
    // Column 0 holds item-000..007 on rows 2-9; column 1 item-008..016 on rows 0-8.
    expect(move("ArrowRight", "Big/item-000")).toBe("Big/item-010");
    expect(move("ArrowLeft", "Big/item-016")).toBe("Big/item-006");
    // Row 9 of column 1 is the +N more slot: the nearest row in that column.
    expect(move("ArrowRight", "Big/item-007")).toBe("Big/item-016");
    expect(move("ArrowLeft", "Big/item-008")).toBe("a");
    // Up/Down stop at the column ends, as for any column.
    expect(move("ArrowDown", "Big/item-007")).toBe("handled");
    expect(move("ArrowUp", "Big/item-008")).toBe("handled");
    // The last shown row; the +N more slot is not an entry.
    expect(move("End", "a")).toBe(`Big/item-${String(shown - 1).padStart(3, "0")}`);
    expect(move("ArrowDown", `Big/item-${String(shown - 1).padStart(3, "0")}`)).toBe("handled");
    // A cursor a spill hid (e.g. scrolled to inside the compact card before
    // "+N more") resumes on the last row shown before it, for any move key.
    for (const name of ["ArrowDown", "ArrowUp", "ArrowRight", "PageDown"]) {
      expect(move(name, "Big/item-050")).toBe(`Big/item-${String(shown - 1).padStart(3, "0")}`);
    }
    expect(resolveListMove({ ...key("ArrowDown"), shiftKey: true }, model, at("Big/item-050"), 600)).toMatchObject({ selection: "extend" });
  });

  it("closes a nested group's guide at the cut instead of drawing it into hidden rows", () => {
    const R = 6;
    // Big: Nested (12 files), then 20 files. Header on row 0: cap 11 = 10 rows + more.
    const extra = { Big: [D("Big/Nested"), ...files(20, "Big/x")], "Big/Nested": files(12, "Big/Nested/n"), "Big/Later": [] };
    const { rows } = scene(0, 0, extra, ["Big", "Big/Nested"]);
    const model = stageModel(rows, "spill", R);
    const more = moreOf(model)!;
    expect(more.placement).toMatchObject({ column: 1, row: R - 1 });
    const spans = fullFlowGuideSpans(rows, model);
    expect(spans.map(span => span.path)).toEqual([`${BIG}/Nested`]);
    // Nested's rows start at row 2 (row 1 is Nested itself) and are cut after
    // the slot before +N more: the guide ends there, never under the slot.
    const [span] = spans;
    expect(span.first).toMatchObject({ column: 0, row: 2 });
    expect(span.last).toMatchObject({ column: 1, row: R - 2 });
    const segments = fullFlowGuideSegments(spans, [0, 1, 2], R);
    expect(segments.map(segment => segment.column)).toEqual([0, 1]);
    const bottom = Math.max(...segments.filter(segment => segment.column === 1).map(segment => segment.top + segment.height));
    expect(bottom).toBeLessThanOrEqual(more.placement.row * LIST_SLOT_HEIGHT);
    // A nested group wholly behind the cut draws no guide at all.
    const late = { Big: [...files(20, "Big/x"), D("Big/Late")], "Big/Late": files(3, "Big/Late/n") };
    const hidden = scene(0, 0, late, ["Big", "Big/Late"]).rows;
    expect(fullFlowGuideSpans(hidden, stageModel(hidden, "spill", R))).toEqual([]);
    expect(fullFlowGuideSpans(hidden, stageModel(hidden, "full", R)).map(span => span.path)).toEqual([`${BIG}/Late`]);
  });

  it("cuts several spilled folders in order, each at the cap for its own header row", () => {
    const R = 6;
    const listing = (path: string): PeekListing | undefined => path === `${ROOT}/A` || path === `${ROOT}/B`
      ? { status: "loaded", entries: files(30, `${path.slice(ROOT.length + 1)}/i`) } : undefined;
    const { rows } = rowsFor([F("x"), D("A"), F("y"), D("B")], ["A", "B"], listing);
    const model = sizeListModel(buildListStructure(rows, new Set(), new Set([`${ROOT}/A`, `${ROOT}/B`])), R, () => undefined);
    const place = (key: string) => model.layout.byIndex[model.items.findIndex(item => item.key === key)];
    expect(place(`entry:${ROOT}/A`)).toMatchObject({ column: 0, row: 1 });
    expect(place(`more:${ROOT}/A`)).toMatchObject({ column: 1, row: 5 });
    expect(place(`entry:${ROOT}/y`)).toMatchObject({ column: 2, row: 0 });
    expect(place(`entry:${ROOT}/B`)).toMatchObject({ column: 2, row: 1 });
    expect(place(`more:${ROOT}/B`)).toMatchObject({ column: 3, row: 5 });
    expect(model.items.filter(item => item.more).map(item => item.more!.count)).toEqual([30 - (listSpillCap(R, 1) - 1), 30 - (listSpillCap(R, 1) - 1)]);
    // Every placed entry maps to an item that names it.
    model.entryItem.forEach((item, entry) => { if (item >= 0) expect(model.items[item].entryIndex ?? model.items[item].card).not.toBeNull(); });
  });
});

it("flows a spill in one pass: hundreds of spilled folders size quickly", () => {
  const F2 = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path: `${ROOT}/${path}`, kind: "file", size: 1, modified: "" });
  const D2 = (path: string): FileEntry => ({ ...F2(path), kind: "directory", size: 0 });
  const top = [...Array.from({ length: 200 }, (_, i) => D2(`s-${String(i).padStart(3, "0")}`)), ...Array.from({ length: 20_000 }, (_, i) => F2(`f-${i}`))];
  const listing = (path: string): PeekListing => ({ status: "loaded", entries: Array.from({ length: 100 }, (_, i) => F2(`${path.slice(ROOT.length + 1)}/c-${i}`)) });
  const { rows } = rowsFor(top, top.slice(0, 200).map(entry => entry.name), listing);
  const structure = buildListStructure(rows, new Set(), new Set(top.slice(0, 200).map(entry => entry.path)));
  const started = performance.now();
  const model = sizeListModel(structure, 30, () => undefined);
  expect(performance.now() - started).toBeLessThan(150);
  expect(model.items.filter(item => item.more)).toHaveLength(200);
  expect(model.layout.byIndex).toHaveLength(model.items.length);
});

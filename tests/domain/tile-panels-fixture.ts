/** Shared fixture for the Tiles panel domain tests: the mock's folders
 * (docs/execution-plans/folder-peek-mock.html) in the app's name order. */
import type { FileEntry } from "$lib/domain/file";
import { buildPeekRows, flattenPeekEntries, type PeekListing } from "$lib/domain/folder-peek";
import { buildTilePanelModel, type BandSide, type TilePanelInput } from "$lib/domain/tile-panels";
import { tileLayout } from "$lib/domain/tile-layout";

export const ROOT = "/r";
export const D = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path: `${ROOT}/${path}`, kind: "directory", size: 0, modified: "" });
export const F = (path: string): FileEntry => ({ name: path.split("/").at(-1)!, path: `${ROOT}/${path}`, kind: "file", size: 1, modified: "" });
export const P = (name: string): string => `${ROOT}/${name}`;

/** Name order, folders first: AI Draft Archive(0) Archive(1) Career(2) Codex(3) Inbox(4) Personal(5). */
export const FOLDERS = ["AI Draft Archive", "Archive", "Career", "Codex", "Inbox", "Personal"];
export const TOP: FileEntry[] = [
  ...FOLDERS.map(D),
  ...["Revenue NSW.pdf", "Scrivo Sample.md", "Totality Dividends.xlsx", "Totality Trades History.xlsx", "bot_pat.txt", "bpay-2026-oct-receipt.png", "freeze-fix-guide.md", "numbers_backup.md", "numbers_backup_2.md"].map(F),
  ...Array.from({ length: 40 }, (_, i) => F(`filler-${String(i).padStart(3, "0")}.txt`)),
];
const kids = (parent: string, dirs: string[], files: string[]) => [...dirs.map(d => D(`${parent}/${d}`)), ...files.map(f => F(`${parent}/${f}`))];
const years = ["2018", "2019", "2020", "2021", "2022", "2023"];
export const KIDS: Record<string, FileEntry[]> = {
  Inbox: kids("Inbox", ["to-file"], ["invoice-oct.pdf", "meeting-notes.md", "quote.txt", "scan-0193.pdf", "screenshot-2026-10-15.png"]),
  Career: kids("Career", ["Applications", "Cover Letters", "Portfolio"], ["Interview Prep.md", "References.docx", "Resume-2026.pdf", "headshot.jpg", "offer-letter.pdf", "salary-research.xlsx"]),
  Codex: kids("Codex", ["prompts", "sessions", "skills"], ["agents-guide.md", "auth-flow.png", "config.toml", "history.jsonl", "mcp-servers.json", "notes.md", "readme-notes.md", "rollout-2026-10-12.jsonl", "rollout-2026-10-14.jsonl", "sandbox.log", "todo.txt"]),
  Personal: kids("Personal", ["Health", "Recipes", "Travel"], Array.from({ length: 20 }, (_, i) => `personal-${i}.pdf`)),
  Archive: kids("Archive", ["2019", "2020", "2021", "2022", "2023"], ["old-notes.md", "scans.zip", "taxes-2022.pdf", ...years.flatMap(y => [`bank-statements-${y}.pdf`, `budget-${y}.xlsx`, `insurance-${y}.pdf`, `misc-${y}.txt`, `notes-${y}.md`, `receipts-${y}.zip`, `scan-${y}.jpg`])]),
  "AI Draft Archive": kids("AI Draft Archive", ["drafts-2025"], ["cover-image.png", "essay-v1.md", "essay-v2.md", "essay-v3.md", "figure-1.png", "notes-chat.md", "outline.md", "prompts.txt", "references.docx", "summary.pdf"]),
};
export const listingOf = (path: string): PeekListing | undefined => {
  const entries = KIDS[path.slice(ROOT.length + 1)];
  return entries ? { status: "loaded", entries } : undefined;
};

/** The real peek projection (Tiles is "top-level"), then the row model. */
export function rowsFor(open: readonly string[], listing: (path: string) => PeekListing | undefined = listingOf, top = TOP, creating = false) {
  const tree = flattenPeekEntries({
    root: ROOT, entries: top, expanded: new Map(open.map((name, i) => [P(name), i])),
    listing: path => listing(path)?.entries, project: entries => entries, capability: "top-level", windows: false,
  });
  return { tree, rows: buildPeekRows(tree, listing, creating) };
}

/** Medium tiles: 108px minimum columns with a 6px gap; C = 7 at 792px. */
export const MEDIUM = tileLayout("medium");
export const widthFor = (C: number, cell = 108, gap = MEDIUM.gap) => C * cell + (C - 1) * gap;

export function modelFor(open: readonly string[], options: Partial<Omit<TilePanelInput, "rows" | "order">> & { listing?: (path: string) => PeekListing | undefined; top?: FileEntry[]; creating?: boolean; remembered?: ReadonlyMap<string, BandSide> } = {}) {
  const { listing = listingOf, top = TOP, creating = false, ...rest } = options;
  const { rows, tree } = rowsFor(open, listing, top, creating);
  const columns = rest.columns ?? 7;
  const model = buildTilePanelModel({
    rows, order: open.map(P), columns, width: rest.width ?? widthFor(columns),
    viewportHeight: rest.viewportHeight ?? 1000, layout: rest.layout ?? MEDIUM,
    preferred: rest.preferred ?? (() => undefined), remembered: rest.remembered,
  });
  return { model, rows, tree };
}

/** "Name:side" per placement, in opening order (the mock selfTest's format). */
export const sides = (model: ReturnType<typeof modelFor>["model"]) =>
  model.placements.map(p => `${p.path.slice(ROOT.length + 1)}:${p.side}`);

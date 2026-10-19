import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drop targeting inside a drag's temporary peek (#1242): rows no component
// owns as targets (file rows, peek-state rows, the Tiles band bridge) drop
// into the peek's folder, through the ordinary folder target; outside
// temporary peeks they keep their ordinary behaviour.
const { panes } = vi.hoisted(() => ({ panes: new Map<string, unknown>() }));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: { zoomLevel: 100 } }));
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getExplorer: (id: string) => panes.get(id), tabs: [], getTabPath: () => null },
}));
import { clearHighlights, highlightTargetElement, resolveDropTargetFromElement } from "$lib/composables/use-native-drop-target.svelte";
import { dropElement } from "../helpers/drop-element";

const spring = { folder: "/r/Inbox" as string | null, calls: [] as [string, string][] };
function explorer(temporary: string[]) {
  return {
    springPeeks: temporary,
    isSpringPeek: (path: string) => temporary.includes(path),
    springDropFolder: (path: string, row: string) => { spring.calls.push([path, row]); return temporary.length ? spring.folder : null; },
  };
}
function listing() {
  const root = dropElement("explorer-pane", { "data-pane-id": "p1" });
  const list = dropElement("file-list", {}, root);
  const content = dropElement("content", { "data-current-path": "/r" }, list);
  return { root, content };
}

beforeEach(() => { panes.clear(); spring.folder = "/r/Inbox"; spring.calls = []; });
afterEach(() => { clearHighlights(); vi.unstubAllGlobals(); });

describe("spring redirect in resolveDropTargetFromElement", () => {
  it("a file row inside a temporary peek targets the peek's folder", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const row = dropElement("entry-item file-item", { "data-path": "/r/Inbox/a.txt" }, content);
    const name = dropElement("name", {}, row);
    expect(resolveDropTargetFromElement(name)).toEqual({ type: "folder", path: "/r/Inbox", spring: true });
    expect(spring.calls).toEqual([["/r/Inbox/a.txt", "file"]]);
  });

  it("a Details row wrapper (hit at a row's pixel-snapped edge) resolves like its row", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const file = dropElement("", { "data-row-path": "/r/Inbox/a.txt", "data-row-kind": "file" }, content);
    expect(resolveDropTargetFromElement(file)).toEqual({ type: "folder", path: "/r/Inbox", spring: true });
    spring.folder = "/r/Inbox/Nested";
    const folder = dropElement("", { "data-row-path": "/r/Inbox/Nested", "data-row-kind": "directory" }, content);
    expect(resolveDropTargetFromElement(folder)).toEqual({ type: "folder", path: "/r/Inbox/Nested", spring: true });
    expect(spring.calls).toEqual([["/r/Inbox/a.txt", "file"], ["/r/Inbox/Nested", "directory"]]);
    // Outside temporary peeks a wrapper stays the pane background, as before.
    panes.set("p1", explorer([]));
    expect(resolveDropTargetFromElement(file)).toEqual({ type: "background", path: "/r" });
  });

  it("a Details peek-state row asks for its folder as a state row", () => {
    panes.set("p1", explorer(["/r/Empty"]));
    spring.folder = "/r/Empty";
    const { content } = listing();
    const state = dropElement("peek-state", { "data-peek-state": "/r/Empty" }, content);
    expect(resolveDropTargetFromElement(state)).toEqual({ type: "folder", path: "/r/Empty", spring: true });
    expect(spring.calls).toEqual([["/r/Empty", "state"]]);
  });

  it("the Tiles band bridge of a temporary panel targets its folder", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const group = dropElement("tile-outline", { "data-panel-owner": "/r/Inbox" }, dropElement("tile-outlines", {}, content));
    const bridge = dropElement("outline-bridge-hit", { "data-spring-bridge": "/r/Inbox" }, group);
    expect(resolveDropTargetFromElement(bridge)).toEqual({ type: "folder", path: "/r/Inbox", spring: true });
    // A stale bridge (its panel no longer temporary) is plain background.
    panes.set("p1", explorer(["/r/Other"]));
    expect(resolveDropTargetFromElement(bridge)).toEqual({ type: "background", path: "/r" });
  });

  it("without temporary peeks, file rows keep their non-target behaviour", () => {
    panes.set("p1", explorer([]));
    const { content } = listing();
    const row = dropElement("entry-item file-item", { "data-path": "/r/Inbox/a.txt" }, content);
    expect(resolveDropTargetFromElement(row)).toEqual({ type: "background", path: "/r", domDisabled: true });
    expect(spring.calls).toEqual([]);
    // A row outside the temporary peek (the explorer answers null) likewise.
    panes.set("p1", explorer(["/r/Inbox"]));
    spring.folder = null;
    expect(resolveDropTargetFromElement(row)).toEqual({ type: "background", path: "/r", domDisabled: true });
  });

  it("folder rows and card or panel surfaces keep their own targets", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const nested = dropElement("entry-item directory", { "data-path": "/r/Inbox/Nested" }, content);
    const surface = dropElement("tile-panel peek-drop-target", { "data-path": "/r/Inbox" }, content);
    expect(resolveDropTargetFromElement(nested)).toEqual({ type: "folder", path: "/r/Inbox/Nested" });
    expect(resolveDropTargetFromElement(surface)).toEqual({ type: "folder", path: "/r/Inbox" });
    expect(spring.calls).toEqual([]);
  });

  it("a row in no pane, or in a pane without an explorer, is never redirected", () => {
    const loose = dropElement("entry-item", { "data-path": "/r/Inbox/a.txt" }, dropElement("content", {}));
    expect(resolveDropTargetFromElement(loose)).toEqual({ type: "background", domDisabled: true });
    const { content } = listing();
    expect(resolveDropTargetFromElement(dropElement("entry-item", { "data-path": "/r/Inbox/a.txt" }, content)))
      .toEqual({ type: "background", path: "/r", domDisabled: true });
  });
});

/** Permanent peeks expose the same folder destination as temporary peeks (#1323).
 * The metadata is the existing explorer projection, not a filesystem path guess. */
describe("permanently expanded peek drop destinations", () => {
  function permanent() {
    const folder = "/r/Career";
    const nested = `${folder}/Portfolio`;
    const file = `${nested}/resume.md`;
    panes.set("p1", {
      ...explorer([]), peekEnabled: true, peekCapability: "tree",
      expandedPaths: new Set([folder, nested]),
      isPeekExpanded: (path: string) => path === folder || path === nested,
      entryMeta: new Map([
        [folder, { depth: 0, parentPath: "/r" }],
        [nested, { depth: 1, parentPath: folder }],
        [file, { depth: 2, parentPath: nested }],
        ["/r/root.txt", { depth: 0, parentPath: "/r" }],
      ]),
    });
    return { ...listing(), folder, nested, file };
  }

  it("a nested Details file targets its immediate peek folder", () => {
    const { content, nested, file } = permanent();
    const row = dropElement("entry-item file-item", { "data-path": file }, content);
    expect(resolveDropTargetFromElement(dropElement("name", {}, row)))
      .toMatchObject({ type: "folder", path: nested });
  });

  it("a Details file wrapper targets the same immediate peek folder", () => {
    const { content, nested, file } = permanent();
    const wrapper = dropElement("", { "data-row-path": file, "data-row-kind": "file" }, content);
    expect(resolveDropTargetFromElement(wrapper)).toMatchObject({ type: "folder", path: nested });
  });

  it("an empty Details peek targets its folder", () => {
    const { content, nested } = permanent();
    const state = dropElement("peek-state", { "data-peek-state": nested }, content);
    expect(resolveDropTargetFromElement(state)).toMatchObject({ type: "folder", path: nested });
  });

  it.each(["list-card-scroll", "tile-panel"])("a file inside a permanent %s targets its folder", className => {
    const { content, folder } = permanent();
    const surface = dropElement(`${className} peek-drop-target`, { "data-path": folder }, content);
    const file = `${folder}/notes.md`;
    (panes.get("p1") as { entryMeta: Map<string, unknown> }).entryMeta.set(file, { depth: 1, parentPath: folder });
    const row = dropElement("entry-item", { "data-path": file }, surface);
    expect(resolveDropTargetFromElement(row)).toMatchObject({ type: "folder", path: folder });
  });

  it("a nested List file targets its immediate folder rather than the outer card", () => {
    const { content, folder, nested, file } = permanent();
    const card = dropElement("list-card-scroll peek-drop-target", { "data-path": folder }, content);
    const row = dropElement("entry-item", { "data-path": file }, card);
    expect(resolveDropTargetFromElement(row)).toMatchObject({ type: "folder", path: nested });
  });

  it("keeps actual directory rows and classic root file rows unchanged", () => {
    const { content, nested } = permanent();
    const directory = dropElement("entry-item directory", { "data-path": nested }, content);
    expect(resolveDropTargetFromElement(directory)).toEqual({ type: "folder", path: nested });
    const rootFile = dropElement("entry-item", { "data-path": "/r/root.txt" }, content);
    expect(resolveDropTargetFromElement(rootFile)).toEqual({ type: "background", path: "/r", domDisabled: true });
  });
});

describe("spring redirect feedback", () => {
  it("highlights the folder's own surface around the row when there is one", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const card = dropElement("list-card-scroll peek-drop-target", { "data-path": "/r/Inbox" }, content);
    const row = dropElement("entry-item list-item", { "data-path": "/r/Inbox/a.txt" }, card);
    highlightTargetElement(row);
    expect(card.classList.contains("drop-target")).toBe(true);
    expect(row.classList.contains("drop-target")).toBe(false);
  });

  it("otherwise highlights the folder's row in the same listing (Details)", () => {
    panes.set("p1", explorer(["/r/Inbox"]));
    const { content } = listing();
    const folderRow = dropElement("entry-item directory", { "data-path": "/r/Inbox" }, content);
    const queries: string[] = [];
    Object.assign(content, { querySelector: (selector: string) => { queries.push(selector); return folderRow; } });
    const row = dropElement("entry-item", { "data-path": "/r/Inbox/a.txt" }, content);
    highlightTargetElement(row);
    expect(folderRow.classList.contains("drop-target")).toBe(true);
    expect(queries[0]).toContain('.entry-item.directory[data-path="/r/Inbox"]');
    // Leaving for a non-target clears it.
    highlightTargetElement(null);
    expect(folderRow.classList.contains("drop-target")).toBe(false);
  });

  it("escapes the folder path in the lookup", () => {
    panes.set("p1", explorer(['/r/a"b']));
    spring.folder = '/r/a"b';
    const { content } = listing();
    const queries: string[] = [];
    Object.assign(content, { querySelector: (selector: string) => { queries.push(selector); return null; } });
    highlightTargetElement(dropElement("entry-item", { "data-path": '/r/a"b/x' }, content));
    expect(queries[0]).toContain('[data-path="/r/a\\"b"]');
  });
});

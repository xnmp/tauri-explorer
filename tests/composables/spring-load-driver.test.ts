import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: { zoomLevel: 100, folderPeek: true } }));
import { createSpringLoadDriver, observeSpringHit, type SpringHitDeps, type SpringHitElement, type SpringPaneView } from "$lib/composables/spring-load-driver";
import { SPRING_LOAD_DELAY_MS, type SpringObservation } from "$lib/domain/spring-load";
import { springRowOf } from "$lib/domain/spring-rows";
import { pathComparison } from "$lib/domain/path";
import { dropElement } from "../helpers/drop-element";

// Spring-loaded peeks (#1242): what the element under a drag says about the
// pane and its peeks, and how the driver applies the controller to panes.
const pane = (patch: Partial<SpringPaneView> = {}): SpringPaneView => ({
  peekCapability: "tree",
  entryMeta: new Map([["/r/Inbox", { depth: 0 }], ["/r/Inbox/Nested", { depth: 1 }], ["/r/notes.txt", { depth: 0 }]]),
  isPeekExpanded: () => false,
  springRequest: [],
  ...patch,
});
const hitDeps = (patch: Partial<SpringHitDeps> = {}): SpringHitDeps => ({
  pane: id => id === "p1" ? pane() : undefined,
  row: springRowOf,
  plain: path => !path.startsWith("trash://"),
  blocked: () => false,
  dragged: () => ["/r/drag.txt"],
  ...patch,
});
/** A pane's file listing: `.file-list .content` inside `[data-pane-id]`. */
function listing(id = "p1") {
  const root = dropElement("explorer-pane", { "data-pane-id": id });
  const list = dropElement("file-list", {}, root);
  const content = dropElement("content", { "data-current-path": "/r" }, list);
  return { root, list, content };
}
const el = (classes: string, attrs: Record<string, string>, parent: HTMLElement) => dropElement(classes, attrs, parent);
const hit = (element: HTMLElement | null, deps = hitDeps()) => observeSpringHit(element as unknown as SpringHitElement | null, deps);

describe("observeSpringHit", () => {
  it("a folder row names its pane, its folder and itself as the anchor", () => {
    const { content } = listing();
    const row = el("entry-item directory", { "data-path": "/r/Inbox" }, content);
    const icon = el("icon", {}, row);
    expect(hit(icon)).toEqual({
      pane: "p1", anchors: ["/r/Inbox"], dragged: ["/r/drag.txt"],
      folder: { path: "/r/Inbox", depth: 0, capability: "tree", expanded: false, plain: true },
    });
  });

  it("a file row anchors at itself and offers no folder", () => {
    const { content } = listing();
    const row = el("entry-item", { "data-path": "/r/Inbox/a.txt" }, content);
    expect(hit(row)).toMatchObject({ pane: "p1", anchors: ["/r/Inbox/a.txt"], folder: null });
  });

  it("reports what decides eligibility: depth, capability, real expansion and plain location", () => {
    const { content } = listing();
    const nested = el("entry-item directory", { "data-path": "/r/Inbox/Nested" }, content);
    const deps = hitDeps({ pane: () => pane({ peekCapability: "top-level", isPeekExpanded: path => path === "/r/Inbox/Nested" }) });
    expect(hit(nested, deps).folder).toEqual({ path: "/r/Inbox/Nested", depth: 1, capability: "top-level", expanded: true, plain: true });
  });

  it("a folder row the pane does not know (not in its rows) offers no folder", () => {
    const { content } = listing();
    expect(hit(el("entry-item directory", { "data-path": "/r/Gone" }, content)).folder).toBeNull();
  });

  it("a Details peek-state row anchors at its folder", () => {
    const { content } = listing();
    const state = el("peek-state", { "data-peek-state": "/r/Inbox" }, content);
    expect(hit(el("", {}, state)).anchors).toEqual(["/r/Inbox"]);
  });

  it("anywhere in a List card's slot (header, scroll area, grip) anchors at its folder", () => {
    const { content } = listing();
    const slot = el("list-slot list-place", { "data-motion-key": "entry:/r/Inbox" }, content);
    const grip = el("list-card-grip", {}, slot);
    const scroll = el("list-card-scroll peek-drop-target", { "data-path": "/r/Inbox" }, slot);
    expect(hit(grip).anchors).toEqual(["/r/Inbox"]);
    expect(hit(scroll).anchors).toEqual(["/r/Inbox"]);
    // A creation row's slot is no folder.
    const create = el("list-slot", { "data-motion-key": "create" }, content);
    expect(hit(create).anchors).toEqual([]);
  });

  it("a Tiles panel, its ribbon and its band bridge anchor at the panel's folder", () => {
    const { content } = listing();
    const panel = el("tile-panel peek-drop-target", { "data-path": "/r/Inbox", "data-panel-owner": "/r/Inbox" }, content);
    expect(hit(panel).anchors).toEqual(["/r/Inbox"]);
    const svg = el("tile-outlines", {}, content);
    const group = el("tile-outline", { "data-panel-owner": "/r/Inbox" }, svg);
    const bridge = el("outline-bridge-hit", { "data-spring-bridge": "/r/Inbox" }, group);
    expect(hit(bridge).anchors).toEqual(["/r/Inbox"]);
  });

  it("a Details row wrapper (a row's pixel-snapped edge) reads like the row it wraps", () => {
    const { content } = listing();
    const folder = el("", { "data-row-path": "/r/Inbox", "data-row-kind": "directory" }, content);
    expect(hit(folder)).toMatchObject({ anchors: ["/r/Inbox"], folder: { path: "/r/Inbox", depth: 0 } });
    const file = el("", { "data-row-path": "/r/Inbox/a.txt", "data-row-kind": "file" }, content);
    expect(hit(file)).toMatchObject({ anchors: ["/r/Inbox/a.txt"], folder: null });
    const state = el("", { "data-row-path": "/r/Inbox", "data-row-kind": "state" }, content);
    expect(hit(state)).toMatchObject({ anchors: ["/r/Inbox"], folder: null });
  });

  it("identities outside the pane's listing are not anchors", () => {
    const outer = dropElement("frame", { "data-path": "/elsewhere", "data-panel-owner": "/elsewhere" });
    const root = el("explorer-pane", { "data-pane-id": "p1" }, outer);
    const list = el("file-list", {}, root);
    const content = el("content", {}, list);
    expect(hit(el("spacer", {}, content))).toMatchObject({ pane: "p1", anchors: [], folder: null });
  });

  it("is outside every pane off a listing, in an unknown pane, under a modal, or for no element", () => {
    const { root, content } = listing();
    const header = el("pane-header", {}, root);
    const row = el("entry-item directory", { "data-path": "/r/Inbox" }, content);
    const outside = { pane: null, anchors: [], folder: null, dragged: ["/r/drag.txt"] };
    expect(hit(header)).toEqual(outside);
    expect(hit(null)).toEqual(outside);
    expect(hit(row, hitDeps({ blocked: () => true }))).toEqual(outside);
    expect(hit(listing("p9").content)).toEqual(outside);
    // A `.content` that is not a file listing's.
    const other = dropElement("content", {}, dropElement("settings", { "data-pane-id": "p1" }));
    expect(hit(other)).toEqual(outside);
  });

  it("passes the live drag's paths so a dragged folder cannot spring inside itself", () => {
    const { content } = listing();
    const row = el("entry-item directory", { "data-path": "/r/Inbox" }, content);
    expect(hit(row, hitDeps({ dragged: () => ["/r/Inbox"] })).dragged).toEqual(["/r/Inbox"]);
    expect(hit(row, hitDeps({ dragged: () => [] })).dragged).toEqual([]);
  });
});

describe("spring-load driver (fake timers)", () => {
  const paths = pathComparison(false);
  const over = (pane: string | null, folder: string | null, anchors: string[] = folder ? [folder] : []): SpringObservation => ({
    pane, anchors, dragged: [],
    folder: folder ? { path: folder, depth: folder.split("/").length - 3, capability: "tree", expanded: false, plain: true } : null,
  });
  let applied: [string, readonly string[]][];
  /** Each pane keeps the request it was last given, as `setSpringPeeks` does. */
  let requests: Map<string, readonly string[]>;
  let driver: ReturnType<typeof createSpringLoadDriver<SpringObservation>>;
  beforeEach(() => {
    vi.useFakeTimers();
    applied = [];
    requests = new Map();
    driver = createSpringLoadDriver<SpringObservation>({
      paths, observe: observation => observation ?? over(null, null),
      apply: (pane, open) => { applied.push([pane, open]); requests.set(pane, open); },
      requested: pane => requests.get(pane),
    });
  });
  afterEach(() => vi.useRealTimers());
  /** Run the deferred apply (a 0ms timeout set inside a timer callback is due 1ms later). */
  const nextTask = () => vi.advanceTimersByTimeAsync(1);
  /** The spring delay and its deferred apply. */
  const springDelay = () => vi.advanceTimersByTimeAsync(SPRING_LOAD_DELAY_MS + 1);

  it("applies an opened peek to its pane after the delay, one macrotask later", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    vi.advanceTimersByTime(599);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual([]);
    await nextTask();
    expect(applied).toEqual([["p1", ["/r/Inbox"]]]);
  });

  it("a close lands after the current task, so a drop's own handlers still see the peek", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    applied.length = 0;
    driver.end();
    expect(applied).toEqual([]);
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
  });

  it("nested peeks reach the pane outer first, and leaving the outer closes both at once", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    driver.hover(over("p1", "/r/Inbox/Nested"));
    await springDelay();
    expect(applied.at(-1)).toEqual(["p1", ["/r/Inbox", "/r/Inbox/Nested"]]);
    driver.hover(over("p1", null, ["/r/notes.txt"]));
    await nextTask();
    expect(applied.at(-1)).toEqual(["p1", []]);
  });

  it("moving to another pane closes the first pane's peek and opens the other's", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    driver.hover(over("p2", "/r/Inbox"));
    await nextTask();
    expect(applied.at(-1)).toEqual(["p1", []]);
    await springDelay();
    expect(applied.at(-1)).toEqual(["p2", ["/r/Inbox"]]);
  });

  it("a hold keeps the applied peeks until its start settles, however long that takes, and a release is idempotent", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    applied.length = 0;
    const release = driver.hold();
    const other = driver.hold();
    driver.hover(over("p1", null, ["/r/notes.txt"]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied).toEqual([]);
    release(); release();
    await nextTask();
    expect(applied).toEqual([]);
    other();
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
  });

  it("the drag session ending releases every hold, so a start that never settles cannot freeze the peeks", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    applied.length = 0;
    const stale = driver.hold();
    driver.hold();
    driver.end();
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
    // The next drag springs and holds as usual; a release left over from the
    // ended session does not release its hold.
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    expect(applied.at(-1)).toEqual(["p1", ["/r/Inbox"]]);
    applied.length = 0;
    const release = driver.hold();
    stale();
    driver.hover(over("p1", null, ["/r/notes.txt"]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(applied).toEqual([]);
    release();
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
  });

  it("a pane that dropped its peeks itself (navigation) lets the folder spring again", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    expect(applied.at(-1)).toEqual(["p1", ["/r/Inbox"]]);
    // Back and forward again: the pane replaced its request; the folder is closed.
    requests.set("p1", []);
    applied.length = 0;
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    expect(applied).toEqual([["p1", ["/r/Inbox"]]]);
    // A closed pane (no request at all) is forgotten too, without an apply to it.
    requests.delete("p1");
    applied.length = 0;
    driver.hover(over("p2", "/r/Inbox"));
    await nextTask();
    expect(applied).toEqual([]);
    await springDelay();
    expect(applied).toEqual([["p2", ["/r/Inbox"]]]);
  });

  it("coalesces changes within one task and skips panes whose peeks did not change", async () => {
    driver.hover(over("p1", "/r/Inbox"));
    await springDelay();
    applied.length = 0;
    // Several changes within one task reach the pane once.
    driver.hover(over("p1", null, ["/r/notes.txt"]));
    driver.end();
    driver.hover(over("p1", "/r/Archive"));
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
    applied.length = 0;
    driver.end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toEqual([]);
  });

  it("a replayed drop's scoped end neither closes a newer drag's peeks nor drops its holds (#1269)", async () => {
    driver.hover(over("p1", "/r/Inbox"), "drag-1");
    await springDelay();
    const releaseFirst = driver.hold();
    const first = driver.gesture;
    // A second drag springs its own folder while the first drop's start is pending.
    driver.hover(over("p1", "/r/Archive"), "drag-2");
    await springDelay();
    applied.length = 0;
    const releaseSecond = driver.hold();
    driver.end(first);
    releaseFirst();
    await nextTask();
    expect(applied).toEqual([]);
    // The second drag's hold is intact: its peeks stay until it releases.
    driver.hover(over("p1", null, ["/r/notes.txt"]), "drag-2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toEqual([]);
    releaseSecond();
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
  });

  it("every change to the applied peeks advances the revision a resolved drop target is checked against", async () => {
    const start = driver.revision;
    driver.hover(over("p1", "/r/Inbox"), "drag-1");
    await springDelay();
    const opened = driver.revision;
    expect(opened).toBeGreaterThan(start);
    driver.hover(over("p1", "/r/Inbox"), "drag-1"); // a repeat changes nothing
    await nextTask();
    expect(driver.revision).toBe(opened);
    driver.endSoon();
    await vi.advanceTimersByTimeAsync(499);
    expect(driver.revision).toBe(opened);
    await vi.advanceTimersByTimeAsync(2);
    expect(applied.at(-1)).toEqual(["p1", []]);
    expect(driver.revision).toBeGreaterThan(opened);
  });

  it("a native Drop just before the deadline ends the peeks itself, once, and the fallback never fires", async () => {
    driver.hover(over("p1", "/r/Inbox"), "drag-1");
    await springDelay();
    applied.length = 0;
    driver.endSoon();
    await vi.advanceTimersByTimeAsync(499);
    driver.end(); // what the native Drop does
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toEqual([["p1", []]]);
  });

  it("a pending drop's hold outlives the fallback; the peeks close when it is released (#1269)", async () => {
    driver.hover(over("p1", "/r/Inbox"), "drag-1");
    await springDelay();
    applied.length = 0;
    const release = driver.hold();
    driver.endSoon();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toEqual([]);
    release();
    await nextTask();
    expect(applied).toEqual([["p1", []]]);
  });

  it("a hold released after a newer drag started ends nothing", async () => {
    driver.hover(over("p1", "/r/Inbox"), "drag-1");
    await springDelay();
    const release = driver.hold();
    driver.endSoon();
    await vi.advanceTimersByTimeAsync(600);
    driver.hover(over("p1", "/r/Archive"), "drag-2");
    await springDelay();
    applied.length = 0;
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toEqual([]);
  });
});

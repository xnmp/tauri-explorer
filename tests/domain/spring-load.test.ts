import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpringLoadController, springIdle, stepSpringLoad, SPRING_LOAD_DELAY_MS, SPRING_LOST_LEAVE_MS,
  type SpringFolder, type SpringObservation, type SpringTarget,
} from "$lib/domain/spring-load";
import { pathComparison } from "$lib/domain/path";

const paths = pathComparison(false);
const folder = (path: string, patch: Partial<SpringFolder> = {}): SpringFolder => ({
  path, depth: path.split("/").length - 3, capability: "tree", expanded: false, plain: true, ...patch,
});
/** The pointer over `path`'s row in `pane` (anchored to that row). */
const over = (path: string | null, patch: Partial<SpringObservation> & { folder?: SpringFolder | null } = {}): SpringObservation => ({
  pane: "p1", anchors: path ? [path] : [], folder: path && !path.endsWith(".txt") ? folder(path) : null, dragged: ["/r/drag.txt"], ...patch,
});
const outside: SpringObservation = { pane: null, anchors: [], folder: null, dragged: [] };

describe("spring-load controller (fake timers)", () => {
  let opened: SpringTarget[][];
  let controller: ReturnType<typeof createSpringLoadController>;
  const openPaths = () => controller.state.open.map(target => `${target.pane}:${target.path}`);
  beforeEach(() => {
    vi.useFakeTimers();
    opened = [];
    controller = createSpringLoadController({ paths, apply: open => opened.push([...open]) });
  });
  afterEach(() => vi.useRealTimers());

  it("opens a temporary peek after exactly SPRING_LOAD_DELAY_MS over a closed folder, and not before", () => {
    expect(SPRING_LOAD_DELAY_MS).toBe(600);
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(599);
    expect(openPaths()).toEqual([]);
    expect(opened).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
    expect(opened).toEqual([[{ pane: "p1", path: "/r/Inbox" }]]);
  });

  it("repeated hovers over the same folder keep one running delay (dragover repeats)", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(400);
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(200);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
  });

  it("re-hovering a different folder restarts the delay for that folder", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(500);
    controller.hover(over("/r/Archive"));
    vi.advanceTimersByTime(500);
    expect(openPaths()).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(openPaths()).toEqual(["p1:/r/Archive"]);
  });

  it("moving off the folder before the delay cancels it; coming back starts over", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(500);
    controller.hover(over("/r/notes.txt"));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(599);
    expect(openPaths()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
  });

  it("stays open over the folder's own rows and surfaces, and closes once the point is in neither", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    // A child row, the card or panel surface (anchored to the folder) and a
    // bridge across a gap all anchor inside the peek.
    for (const anchors of [["/r/Inbox/a.txt"], ["/r/Inbox"], ["/r/Inbox/Nested/deep.txt", "/r/Inbox"]]) {
      controller.hover({ ...over(null), anchors });
      expect(openPaths()).toEqual(["p1:/r/Inbox"]);
    }
    controller.hover(over("/r/notes.txt"));
    expect(openPaths()).toEqual([]);
    expect(opened.at(-1)).toEqual([]);
  });

  it("a sibling with a shared name prefix is outside the peek", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Inbox-old/file.txt"));
    expect(openPaths()).toEqual([]);
  });

  it("a folder inside a temporary peek springs open in turn, and leaving it keeps the outer peek", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Inbox/Nested"));
    vi.advanceTimersByTime(600);
    expect(openPaths()).toEqual(["p1:/r/Inbox", "p1:/r/Inbox/Nested"]);
    controller.hover(over("/r/Inbox/a.txt"));
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
  });

  it("leaving the outer peek closes the nested one with it (cascade)", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Inbox/Nested"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/notes.txt"));
    expect(openPaths()).toEqual([]);
    expect(opened.at(-1)).toEqual([]);
  });

  it("Tiles springs top-level folders only (panels do not nest)", () => {
    controller.hover(over("/r/Inbox", { folder: folder("/r/Inbox", { capability: "top-level" }) }));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Inbox/Nested", { folder: folder("/r/Inbox/Nested", { capability: "top-level", depth: 1 }) }));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
  });

  it("never re-opens a folder the user already expanded", () => {
    controller.hover(over("/r/Inbox", { folder: folder("/r/Inbox", { expanded: true }) }));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("excludes virtual and provider locations, and panes without peek capability", () => {
    controller.hover(over("trash://", { folder: folder("trash://Old", { plain: false }) }));
    vi.advanceTimersByTime(5_000);
    controller.hover(over("/r/Inbox", { folder: folder("/r/Inbox", { capability: "none" }) }));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
  });

  it("a dragged folder never springs open over itself or inside itself", () => {
    const dragged = ["/r/Inbox"];
    controller.hover(over("/r/Inbox", { dragged }));
    vi.advanceTimersByTime(5_000);
    controller.hover(over("/r/Inbox/Nested", { dragged }));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
  });

  it("drag end, cancel and drop close every temporary peek and cancel a running delay", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Inbox/Nested"));
    vi.advanceTimersByTime(300);
    controller.end();
    expect(openPaths()).toEqual([]);
    expect(opened.at(-1)).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an observation outside every pane (drag left the window) closes peeks and cancels the delay", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover(over("/r/Archive"));
    controller.hover(outside);
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
  });

  it("a reset forgets one pane's open peeks and running delay, so its folders can spring again", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
    controller.reset("p1");
    expect(openPaths()).toEqual([]);
    // Still over the folder: it springs again after a full delay.
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS - 1);
    expect(openPaths()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(openPaths()).toEqual(["p1:/r/Inbox"]);
    // A pending delay in the reset pane is cancelled.
    controller.hover(over("/r/Archive"));
    controller.reset("p1");
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    expect(openPaths()).toEqual([]);
    const state = controller.state;
    controller.reset("p9");
    expect(controller.state).toBe(state);
  });

  it("panes are independent: the same folder in another pane is another target", () => {
    controller.hover(over("/r/Inbox"));
    vi.advanceTimersByTime(600);
    controller.hover({ ...over("/r/Inbox"), pane: "p2" });
    expect(openPaths()).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(openPaths()).toEqual(["p2:/r/Inbox"]);
  });

  it("ignores malformed observations: empty paths and paths the platform cannot key", () => {
    controller.hover(over("", { folder: folder("") }));
    controller.hover(over("relative/dir", { folder: folder("relative/dir") }));
    vi.advanceTimersByTime(5_000);
    expect(openPaths()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps state identity when nothing changes (no spurious apply)", () => {
    const state = stepSpringLoad(springIdle, { type: "hover", observation: over("/r/notes.txt") }, paths);
    expect(state).toBe(springIdle);
    expect(stepSpringLoad(springIdle, { type: "end" }, paths)).toBe(springIdle);
  });

  it("handles a very deep nesting chain without losing order", () => {
    let path = "/r";
    for (let i = 0; i < 50; i++) {
      path += `/d${i}`;
      controller.hover(over(path));
      vi.advanceTimersByTime(600);
    }
    expect(controller.state.open).toHaveLength(50);
    expect(controller.state.open.at(-1)!.path).toBe(path);
    controller.hover(over("/r/d0/x.txt"));
    expect(openPaths()).toEqual(["p1:/r/d0"]);
  });

  it("an injected timer replaces setTimeout", () => {
    const calls: [() => void, number][] = [];
    const custom = createSpringLoadController({
      paths, apply: () => {}, delay: 250,
      timer: { set: (callback, ms) => { calls.push([callback, ms]); return calls.length; }, clear: () => {} },
    });
    custom.hover(over("/r/Inbox"));
    expect(calls.map(([, ms]) => ms)).toEqual([250]);
    calls[0][0]();
    expect(custom.state.open).toEqual([{ pane: "p1", path: "/r/Inbox" }]);
  });
});

// Gesture identity and the lost-Leave fallback (#1269).
describe("spring-load controller gestures", () => {
  let controller: ReturnType<typeof createSpringLoadController>;
  let ended: number;
  const openPaths = () => controller.state.open.map(target => target.path);
  const openInbox = (scope: string) => {
    controller.hover(over("/r/Inbox"), scope);
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    ended = 0;
    controller = createSpringLoadController({ paths, apply: () => {}, onEnd: () => { ended++; } });
  });
  afterEach(() => vi.useRealTimers());

  it("a replayed drop's end, scoped to its own gesture, cannot close a newer drag's springs", () => {
    openInbox("drag-1");
    const captured = controller.gesture!;
    // A second drag begins and springs open its own peek before the replay fires.
    openInbox("drag-2");
    expect(openPaths()).toEqual(["/r/Inbox"]);
    expect(controller.end(captured)).toBe(false);
    expect(openPaths()).toEqual(["/r/Inbox"]);
    expect(controller.gesture).toBe("drag-2");
  });

  it("an end scoped to the live gesture closes its springs", () => {
    openInbox("drag-1");
    expect(controller.end("drag-1")).toBe(true);
    expect(openPaths()).toEqual([]);
    expect(controller.gesture).toBeUndefined();
  });

  it("an unscoped end always ends the gesture", () => {
    openInbox("drag-1");
    controller.end();
    expect(openPaths()).toEqual([]);
  });

  it("a hover from a newer drag retires the older one and reports the end (releasing its holds)", () => {
    openInbox("drag-1");
    ended = 0;
    controller.hover(over("/r/notes.txt"), "drag-2");
    expect(ended).toBe(1);
    expect(openPaths()).toEqual([]);
    controller.hover(over("/r/notes.txt"), "drag-2");
    expect(ended).toBe(1);
  });

  it("the lost-Leave fallback closes the springs after the bounded wait, and not before", () => {
    expect(SPRING_LOST_LEAVE_MS).toBe(500);
    openInbox("drag-1");
    controller.endSoon();
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS - 1);
    expect(openPaths()).toEqual(["/r/Inbox"]);
    vi.advanceTimersByTime(1);
    expect(openPaths()).toEqual([]);
  });

  it("a native Drop or Leave just before the deadline cancels the fallback", () => {
    openInbox("drag-1");
    controller.endSoon();
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS - 1);
    controller.settle();
    vi.advanceTimersByTime(10_000);
    expect(openPaths()).toEqual(["/r/Inbox"]);
  });

  it("an end before the deadline leaves no timer to end a later drag", () => {
    openInbox("drag-1");
    controller.endSoon();
    controller.end();
    openInbox("drag-2");
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS * 2);
    expect(openPaths()).toEqual(["/r/Inbox"]);
  });

  it("a newer drag arriving before the deadline is not ended by the older fallback", () => {
    openInbox("drag-1");
    controller.endSoon();
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS - 100);
    openInbox("drag-2");
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS);
    expect(openPaths()).toEqual(["/r/Inbox"]);
    expect(controller.gesture).toBe("drag-2");
  });

  it("the fallback deadline is injectable", () => {
    const custom = createSpringLoadController({ paths, apply: () => {}, lostLeaveMs: 50 });
    custom.hover(over("/r/Inbox"), "g");
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    custom.endSoon();
    vi.advanceTimersByTime(50);
    expect(custom.state.open).toEqual([]);
  });

  it("endSoon with no live gesture arms nothing", () => {
    controller.endSoon();
    openInbox("drag-1");
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS * 2);
    expect(openPaths()).toEqual(["/r/Inbox"]);
  });

  it("while a reason to keep the peeks open stands, the fallback waits for endDeferred", () => {
    let held = true;
    const kept = createSpringLoadController({ paths, apply: () => {}, keepOpen: () => held });
    kept.hover(over("/r/Inbox"), "g");
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    kept.endSoon();
    vi.advanceTimersByTime(SPRING_LOST_LEAVE_MS * 4);
    expect(kept.state.open).toHaveLength(1);
    kept.endDeferred();
    expect(kept.state.open).toHaveLength(1);
    held = false;
    kept.endDeferred();
    expect(kept.state.open).toEqual([]);
  });
});

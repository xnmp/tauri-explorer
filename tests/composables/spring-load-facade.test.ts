import { beforeEach, expect, it, vi } from "vitest";

// The eager spring-load entry point (#1242): free while Folder Peek is off,
// loads the driver on the first eligible hover and replays only what is
// still current once it has loaded.
const { settings, calls, drag } = vi.hoisted(() => ({
  settings: { folderPeek: true },
  calls: [] as string[],
  /** The in-app drag's session, and the gesture each driver call was given. */
  drag: { session: undefined as string | undefined, hovered: [] as (string | undefined)[], expired: undefined as (() => void) | undefined },
}));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: settings }));
vi.mock("$lib/state/drag.svelte", () => ({
  dragState: { latestSource: () => drag.session === undefined ? null : { sessionId: drag.session } },
}));
vi.mock("$lib/composables/spring-load-driver", () => ({
  createDomSpringLoadDriver: () => ({
    hover: (element: { id: string } | null, gesture?: string) => { drag.hovered.push(gesture); calls.push(`hover:${element?.id ?? "null"}`); },
    end: (gesture?: string) => calls.push(gesture === undefined ? "end" : `end:${gesture}`),
    endSoon: (expired?: () => void) => { drag.expired = expired; calls.push("endSoon"); },
    settle: () => calls.push("settle"),
    get gesture() { return drag.hovered.at(-1) ?? ""; },
    hold: () => { calls.push("hold"); return () => calls.push("release"); },
  }),
}));

const element = (id: string, isConnected = true) => ({ id, isConnected }) as unknown as Element;

beforeEach(() => {
  vi.resetModules();
  settings.folderPeek = true;
  calls.length = 0;
  drag.session = undefined; drag.hovered = []; drag.expired = undefined;
});
const load = () => import("$lib/composables/spring-load");
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("Folder Peek off: never hit-tests and never loads the driver", async () => {
  settings.folderPeek = false;
  const { springHover, springEnd, springHold } = await load();
  const locate = vi.fn(() => element("row"));
  springHover(locate);
  springEnd();
  springHold()();
  await settle();
  expect(locate).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

it("the first hover loads the driver and is replayed; later hovers go straight through", async () => {
  const { springHover, springEnd, springHold } = await load();
  springHover(() => element("a"));
  springHover(() => element("b"));
  await settle();
  expect(calls).toEqual(["hover:b"]);
  springHover(() => element("c"));
  springEnd();
  springHold()();
  expect(calls).toEqual(["hover:b", "hover:c", "end", "hold", "release"]);
});

it("a drag that ends, leaves or loses its element before the driver loads replays nothing", async () => {
  const first = await load();
  first.springHover(() => element("a"));
  first.springEnd();
  await settle();
  expect(calls).toEqual([]);

  vi.resetModules();
  const second = await load();
  second.springHover(() => element("a"));
  second.springHover(() => null);
  await settle();
  expect(calls).toEqual([]);

  vi.resetModules();
  const third = await load();
  third.springHover(() => element("gone", false));
  await settle();
  expect(calls).toEqual([]);
});

it("turning Folder Peek off mid-drag closes the drag's peeks", async () => {
  const { springHover } = await load();
  springHover(() => element("a"));
  await settle();
  settings.folderPeek = false;
  const locate = vi.fn(() => element("b"));
  springHover(locate);
  expect(locate).not.toHaveBeenCalled();
  expect(calls).toEqual(["hover:a", "hover:null"]);
});

it("hands the driver the source's session as the drag's identity, and scopes a later end to it (#1269)", async () => {
  const { springHover, springEnd, springEndSoon, springSettle, springGesture } = await load();
  drag.session = "session-7";
  springHover(() => element("a"));
  await settle();
  springHover(() => element("b"));
  expect(drag.hovered).toEqual(["session-7", "session-7"]);
  expect(springGesture()).toBe("session-7");
  // A newer drag: the captured identity is what a late end must carry.
  const captured = springGesture();
  drag.session = "session-8";
  springHover(() => element("c"));
  expect(springGesture()).toBe("session-8");
  springEnd(captured);
  const expired = () => {};
  springEndSoon(expired);
  springSettle();
  expect(calls).toEqual(["hover:a", "hover:b", "hover:c", "end:session-7", "endSoon", "settle"]);
  expect(drag.expired).toBe(expired);
});

it("a drag without an in-app source passes no gesture, leaving the current one alone", async () => {
  const { springHover } = await load();
  springHover(() => element("a"));
  await settle();
  springHover(() => element("b"));
  expect(drag.hovered).toEqual([undefined, undefined]);
});

it("before the driver loads there is no gesture to scope to, and the fallback calls are inert", async () => {
  const { springGesture, springEnd, springEndSoon, springSettle } = await load();
  expect(springGesture()).toBe("");
  springEnd(springGesture());
  springEndSoon();
  springSettle();
  expect(calls).toEqual([]);
});

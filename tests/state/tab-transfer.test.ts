/** Current pointer/native transfer boundary; the obsolete BroadcastChannel
 * removal protocol has no production caller and is intentionally absent. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  adoptTab: vi.fn(),
  listener: undefined as ((event: { payload: unknown }) => Promise<void>) | undefined,
  emitTo: vi.fn(async () => {}),
  visible: true,
  acceptsTransfers: true,
  visibilityWait: null as Promise<void> | null,
  visibilityStarted: undefined as (() => void) | undefined,
  visibilityError: null as Error | null,
}));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {
  get acceptsTransfers() { return harness.acceptsTransfers; },
  windowLabel: "main", adoptTab: harness.adoptTab,
} }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: harness.emitTo,
  listen: vi.fn(async (_name: string, handler: typeof harness.listener) => {
    harness.listener = handler;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFocus: async () => {}, isVisible: async () => {
  harness.visibilityStarted?.();
  await harness.visibilityWait;
  if (harness.visibilityError) throw harness.visibilityError;
  return harness.visible;
} }) }));
import { createTabDragState, initTabTransferListener } from "$lib/state/tab-transfer";

let tabDragState = createTabDragState();

beforeEach(() => { tabDragState = createTabDragState(); localStorage.clear(); harness.visible = true; harness.acceptsTransfers = true; harness.visibilityWait = null; harness.visibilityStarted = undefined; harness.visibilityError = null; harness.adoptTab.mockReset(); harness.emitTo.mockClear(); harness.listener = undefined; });

describe("tab drag marker", () => {
  it("owns transient valid data and rejects malformed drag input", () => {
    const data = { sourceWindow: "explorer-1", tabId: "tab-123", snapshot: { path: "/home/user/Documents" } };
    const id = tabDragState.start(data);
    expect(tabDragState.read()).toEqual({ ...data, id });
    tabDragState.clear(id);
    expect(tabDragState.read()).toBeNull();
    for (const raw of [{}, { sourceWindow: 1, tabId: {}, snapshot: { path: 2 } }, { ...data, snapshot: null }]) {
      expect(tabDragState.start(raw)).toBeNull();
      expect(tabDragState.read()).toBeNull();
    }
  });
});

it("an older detach cannot clear a replacement drag", () => {
  const older = tabDragState.start({ sourceWindow: "main", tabId: "old", snapshot: { path: "/old" } });
  const current = tabDragState.start({ sourceWindow: "main", tabId: "new", snapshot: { path: "/new" } });
  tabDragState.clear(older);
  expect(tabDragState.read()).toMatchObject({ id: current, tabId: "new", snapshot: { path: "/new" } });
  tabDragState.clear(current);
  expect(tabDragState.read()).toBeNull();
});

it("does not consume a different window's marker or persist a drag across launches", () => {
  const otherWindow = createTabDragState();
  const id = tabDragState.start({ sourceWindow: "main", tabId: "one", snapshot: { path: "/one" } });
  expect(otherWindow.read()).toBeNull();
  expect(otherWindow.clear(id)).toBe(false);
  expect(localStorage.getItem("explorer-tab-drag")).toBeNull();
  expect(tabDragState.read()?.id).toBe(id);
});

describe("native tab receiver", () => {
  it("leaves ownership with the sender when the destination closes during its visibility check", async () => {
    const stop = initTabTransferListener();
    try {
      await vi.waitFor(() => expect(harness.listener).toBeTypeOf("function"));
      harness.visibilityError = new Error("window destroyed");
      await expect(harness.listener!({ payload: {
        snapshot: { path: "/valid" }, handoff: { sourceWindow: "source", requestId: "closing" },
      } })).resolves.toBeUndefined();
      expect(harness.adoptTab).not.toHaveBeenCalled();
      expect(harness.emitTo).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("acknowledges only after a valid snapshot is adopted", async () => {
    const stop = initTabTransferListener();
    try {
      await vi.waitFor(() => expect(harness.listener).toBeTypeOf("function"));
      await harness.listener!({ payload: { snapshot: null } });
      await harness.listener!({ payload: { snapshot: { path: "/valid" }, handoff: null } });
      expect(harness.adoptTab).not.toHaveBeenCalled();
      expect(harness.emitTo).not.toHaveBeenCalled();
      const handoff = { sourceWindow: "source", requestId: "request-1" };
      harness.visible = false;
      await harness.listener!({ payload: { snapshot: { path: "/valid" }, handoff } });
      expect(harness.adoptTab).not.toHaveBeenCalled();
      harness.visible = true;
      await harness.listener!({ payload: { snapshot: { path: "/valid" }, handoff } });
      expect(harness.adoptTab).toHaveBeenCalledWith({ path: "/valid" });
      expect(harness.emitTo).toHaveBeenCalledWith("source", "explorer://tab-adopted", { requestId: "request-1", targetWindow: "main" });
      expect(harness.adoptTab.mock.invocationCallOrder[0]).toBeLessThan(harness.emitTo.mock.invocationCallOrder[0]);
      await harness.listener!({ payload: { snapshot: { path: "/valid" }, handoff } });
      expect(harness.adoptTab).toHaveBeenCalledOnce();
      expect(harness.emitTo).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });
});

for (const duplicate of [false, true]) {
  it(`rejects ${duplicate ? "duplicate" : "new"} handoffs when close begins during visibility IPC`, async () => {
    const stop = initTabTransferListener();
    try {
      await vi.waitFor(() => expect(harness.listener).toBeTypeOf("function"));
      const event = { payload: { snapshot: { path: "/valid" }, handoff: { sourceWindow: "source", requestId: "race" } } };
      if (duplicate) await harness.listener!(event);
      harness.adoptTab.mockClear();
      harness.emitTo.mockClear();
      let visible!: () => void;
      harness.visibilityWait = new Promise<void>((resolve) => { visible = resolve; });
      const started = new Promise<void>((resolve) => { harness.visibilityStarted = resolve; });
      const delivery = harness.listener!(event);
      await started;
      harness.acceptsTransfers = false;
      visible();
      await delivery;
      expect(harness.adoptTab).not.toHaveBeenCalled();
      expect(harness.emitTo).not.toHaveBeenCalled();
    } finally { stop(); }
  });
}

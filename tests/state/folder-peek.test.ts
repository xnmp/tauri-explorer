import { afterEach, expect, it, vi } from "vitest";
import { toastStore } from "$lib/state/toast.svelte";
import { createFolderPeekState, showCaretlessDoubleClickNotice } from "$lib/state/folder-peek.svelte";
vi.mock("$lib/state/git-status.svelte", () => ({ gitStatusStore: { trackDirectory: () => () => {}, fetchForDirectory: vi.fn() } }));
const stores: ReturnType<typeof createFolderPeekState>[] = [];
const create = async () => { const state = createFolderPeekState(false); stores.push(state); await state.activate(); return state; };
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.dispose())); vi.useRealTimers(); });
it("keeps per-pane membership independent of reachable resources and releases stale identities", async () => {
  const a = await create(), b = await create();
  a.toggle("/r/a"); a.toggle("/r/a/n");
  a.reconcile(["/r/a"]);
  const first = a.target("/r/a")!;
  expect(b.expanded.size).toBe(0);
  a.reconcile([]);
  expect(first.current()).toBe(false);
  expect(a.expanded.size).toBe(2);
  a.reconcile(["/r/a"]);
  expect(a.target("/r/a")).not.toBe(first);
  expect(first.current()).toBe(false);
  expect(a.listing("/r/a")?.entries).toEqual([]);
});
it("delays loading, rejects retired responses, and clears delayed timers on dispose", async () => {
  vi.useFakeTimers();
  const state = await create(); state.toggle("/r/a"); state.reconcile(["/r/a"]);
  const target = state.target("/r/a")!;
  expect(state.listing("/r/a")?.showLoading).toBe(false);
  await vi.advanceTimersByTimeAsync(149);
  expect(state.listing("/r/a")?.showLoading).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.listing("/r/a")?.showLoading).toBe(true);
  state.reconcile([]); state.reconcile(["/r/a"]);
  target.fail("old response");
  expect(state.listing("/r/a")?.status).toBe("loading");
  state.target("/r/a")!.fail("permission denied");
  expect(state.listing("/r/a")?.error).toBe("permission denied");
  await state.dispose();
  expect(vi.getTimerCount()).toBe(0);
});


it("restores user expansion without sharing it with a fresh pane", async () => {
  const restored = createFolderPeekState(false, ["/r/a", "/r/a/n"]);
  stores.push(restored);
  await restored.activate();
  expect([...restored.expanded.keys()]).toEqual(["/r/a", "/r/a/n"]);
  expect((await create()).expanded.size).toBe(0);
});


it("limits advice to once per minute without replacing other notices or extending the cooldown", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01"));
  showCaretlessDoubleClickNotice("Enter");
  expect(toastStore.toasts[0].message).toContain("Use Enter");
  toastStore.show("Other advice");
  vi.advanceTimersByTime(59_999);
  showCaretlessDoubleClickNotice("Ctrl+O");
  expect(toastStore.toasts).toEqual([]);
  vi.advanceTimersByTime(1);
  showCaretlessDoubleClickNotice("Ctrl+O");
  expect(toastStore.toasts[0].message).toContain("Use Ctrl+O");
  toastStore.clear();
});


it.each(["collapse", "prune"])("honors %s while a restored session is still loading", async action => {
  const state = createFolderPeekState(false, ["/r/a", "/r/a/n"]);
  stores.push(state);
  if (action === "collapse") state.collapseAll(["/r"]);
  else state.prune("/r", []);
  expect([...state.expanded.keys()]).toEqual([]);
  await state.activate();
  expect([...state.expanded.keys()]).toEqual([]);
});

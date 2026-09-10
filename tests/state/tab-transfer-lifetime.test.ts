import { expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => void) | undefined,
  resolve: undefined as ((stop: () => void) => void) | undefined,
  adoptTab: vi.fn(),
}));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {
  windowLabel: "main", adoptTab: harness.adoptTab, removeTransferredTab: vi.fn(),
} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, listener: typeof harness.listener) => {
    harness.listener = listener;
    return new Promise<() => void>((resolve) => { harness.resolve = resolve; });
  }),
}));

import { initTabTransferListener } from "$lib/state/tab-transfer";

it("teardown releases a late subscription and ignores its queued transfer", async () => {
  const stop = initTabTransferListener();
  await vi.waitFor(() => expect(harness.resolve).toBeTypeOf("function"));
  stop();
  const unlisten = vi.fn();
  harness.resolve!(unlisten);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  harness.listener!({ payload: { snapshot: { path: "/late" }, handoff: { sourceWindow: "other", requestId: "late" } } });
  expect(harness.adoptTab).not.toHaveBeenCalled();
  stop();
  expect(unlisten).toHaveBeenCalledOnce();
});

import { afterEach, expect, it, vi } from "vitest";
import { navigateFromQuickOpen } from "$lib/state/quick-open-navigation";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

afterEach(() => { vi.restoreAllMocks(); dialogStore.closeQuickOpen(); });

function setup(active: string) {
  const navigateTo = vi.fn();
  vi.spyOn(windowTabsManager, "activePaneId", "get").mockImplementation(() => active);
  vi.spyOn(windowTabsManager, "getActiveExplorer").mockReturnValue({ navigateTo } as any);
  return navigateTo;
}

it("refuses navigation of a pane covered by a dialog, even though Quick Open itself was open", async () => {
  const navigateTo = setup("a");
  const release = modalOwnership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
  try {
    dialogStore.openQuickOpen();
    const close = vi.fn(() => dialogStore.closeQuickOpen());
    expect(await navigateFromQuickOpen(close, "/dest")).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
    expect(modalOwnership.hasPaneOpen("a")).toBe(true);
  } finally { release(); }
});

it("navigates an uncovered pane when a dialog covers a different pane", async () => {
  const navigateTo = setup("b");
  const release = modalOwnership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
  try {
    dialogStore.openQuickOpen();
    expect(await navigateFromQuickOpen(() => dialogStore.closeQuickOpen(), "/dest")).toBe(true);
    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/dest");
  } finally { release(); }
});

it("navigates as before when no dialog covers the pane", async () => {
  const navigateTo = setup("a");
  dialogStore.openQuickOpen();
  expect(await navigateFromQuickOpen(() => dialogStore.closeQuickOpen(), "/dest")).toBe(true);
  expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/dest");
});

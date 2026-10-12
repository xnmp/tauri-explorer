import { afterEach, expect, it, vi } from "vitest";
import { navigateFromSidebar } from "$lib/state/sidebar-navigation";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

afterEach(() => vi.restoreAllMocks());
it.each(["mouse", "Enter", "Space"])("sidebar %s navigation obeys the active pane's ownership", () => {
  let active = "a";
  const navigateTo = vi.fn();
  vi.spyOn(windowTabsManager, "activePaneId", "get").mockImplementation(() => active);
  vi.spyOn(windowTabsManager, "getActiveExplorer").mockReturnValue({ navigateTo } as any);
  const release = modalOwnership.register(() => {}, undefined, { scope: { paneId: "a", token: Symbol() } });
  try {
    expect(dialogStore.isPaneBlocked("a")).toBe(true);
    navigateFromSidebar("/destination"); expect(navigateTo).not.toHaveBeenCalled();
    active = "b"; navigateFromSidebar("/destination"); expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/destination");
    navigateTo.mockClear(); active = "a"; release(); navigateFromSidebar("/destination");
    expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/destination");
  } finally { release(); }
});

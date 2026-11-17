/** New tabs seed from the source pane's listing, not its presentation (#1729).
 * Runs against the browser mock backend, so the new tab's listing is real. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

const DIR = "/home/user/Documents";
let manager: ReturnType<typeof createWindowTabsManager>;

beforeEach(async () => {
  localStorage.clear();
  settingsStore.reset();
  manager = createWindowTabsManager();
  manager.init(DIR, true);
  await vi.waitFor(() => expect(manager.getActiveExplorer()?.awaitingFirstListing).toBe(false));
});

afterEach(async () => { await manager.dispose(); });

const selected = () => [...manager.getActiveExplorer()!.selectedPaths];

describe("Ctrl+T from a filtered pane", () => {
  it("selects the row the new tab's listing picks, so the selection never jumps", async () => {
    const source = manager.getActiveExplorer()!;
    const unfilteredFirst = source.displayEntries[0].path;
    source.setFilter("notes");
    expect(source.displayEntries.map((entry) => entry.name)).toEqual(["notes.md"]);

    manager.createTab();
    const tab = manager.getActiveExplorer()!;
    expect(tab).not.toBe(source);
    // The new tab drops the filter: it shows, and selects from, the whole folder at once.
    expect(tab.displayEntries[0].path).toBe(unfilteredFirst);
    const atCreation = selected();
    expect(atCreation).toEqual([unfilteredFirst]);

    await vi.waitFor(() => expect(tab.awaitingFirstListing).toBe(false));
    expect(selected()).toEqual(atCreation);
  });
});

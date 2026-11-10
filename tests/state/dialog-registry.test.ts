import { afterEach, describe, expect, it } from "vitest";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { OVERLAY_IDS, type OverlayId } from "$lib/domain/overlays";
import type { FileEntry } from "$lib/domain/file";

/** Typed as a full Record so a new registry id fails `bun run check` until wired. */
const openers: Record<OverlayId, () => void> = {
  quickOpen: () => dialogStore.openQuickOpen(),
  commandPalette: () => dialogStore.openCommandPalette(),
  settings: () => dialogStore.openSettings(),
  about: () => dialogStore.openAbout(),
  contentSearch: () => dialogStore.openContentSearch(),
  workspace: () => dialogStore.openWorkspace(),
  jobsPanel: () => dialogStore.openJobsPanel(),
  themePicker: () => dialogStore.openThemePicker(),
  shortcuts: () => dialogStore.openShortcuts(),
  keybindings: () => dialogStore.openKeybindings(),
  plugins: () => dialogStore.openPlugins(),
  userReport: () => dialogStore.openUserReport(),
  fileRecovery: () => dialogStore.openFileRecovery(),
};

const entry = { path: "/a/b.txt", name: "b.txt" } as FileEntry;

afterEach(() => dialogStore.closeAll());

describe("every overlay participates in modal blocking and close-all", () => {
  it.each(OVERLAY_IDS)("%s blocks input when open and is closed by closeAll", (id) => {
    expect(dialogStore.hasModalOpen).toBe(false);
    openers[id]();
    expect(dialogStore.hasModalOpen).toBe(true);
    expect(dialogStore.isPaneBlocked("pane-1")).toBe(true);
    dialogStore.closeAll();
    expect(dialogStore.hasModalOpen).toBe(false);
  });

  it.each(OVERLAY_IDS)("%s is closed by Escape fallthrough when nothing is mounted", (id) => {
    openers[id]();
    dialogStore.requestCloseTop();
    expect(dialogStore.hasModalOpen).toBe(false);
  });

  it("payload dialogs block input and close with closeAll", () => {
    const opens: Array<() => void> = [
      () => dialogStore.startRename(entry),
      () => dialogStore.startDelete([entry]),
      () => dialogStore.openPicker({ title: "t", options: [], onSelect: () => {} }),
      () => dialogStore.openImageEditor(entry),
    ];
    for (const open of opens) {
      open();
      expect(dialogStore.hasModalOpen).toBe(true);
      dialogStore.closeAll();
      expect(dialogStore.hasModalOpen).toBe(false);
    }
  });

  it("closeAll clears file-operation state", () => {
    dialogStore.startDelete([entry], true);
    dialogStore.closeAll();
    expect(dialogStore.activeDialog).toBeNull();
    expect(dialogStore.deletingEntries).toEqual([]);
    expect(dialogStore.isPermanentDelete).toBe(false);
    expect(dialogStore.fileOperationSession).toBeNull();
  });
});

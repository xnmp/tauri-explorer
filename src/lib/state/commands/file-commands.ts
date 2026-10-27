/**
 * File operation, clipboard, and selection commands.
 */

import type { Command } from "../commands.svelte";
import { writeTextFile } from "$lib/api/files";
import { dialogStore } from "../dialogs.svelte";
import { getActiveExplorer } from "./shared";
import { windowTabsManager } from "../window-tabs.svelte";
import { requestGraphUndo } from "../git-graph-undo";
import { activePaneIsGraph } from "./active-pane";
import { isCroppableImage } from "$lib/domain/file-types";
import { explainTrashedOpen } from "../trash-provider";

function selectedCropImage() {
  const selected = getActiveExplorer()?.getSelectedEntries() ?? [];
  return selected.length === 1 && isCroppableImage(selected[0]) ? selected[0] : null;
}

/** File operation commands */
export const fileCommands: Command[] = [
  {
    id: "file.cropImage",
    scope: "pane",
    label: "Crop Image…",
    category: "file",
    when: () => selectedCropImage() !== null,
    handler: () => {
      const image = selectedCropImage();
      if (image) dialogStore.openImageEditor(image);
    },
  },
  {
    id: "file.newFolder",
    scope: "pane",
    label: "New Folder",
    category: "file",
    shortcut: "Ctrl+Shift+N",
    handler: () => getActiveExplorer()?.startInlineNewFolder(),
    // Inline editors live in the built-in listing, not in plugin file views.
    when: () => !getActiveExplorer()?.showsPluginView,
  },
  {
    id: "file.newFile",
    scope: "pane",
    label: "New File",
    category: "file",
    shortcut: "Ctrl+Alt+N",
    handler: () => getActiveExplorer()?.startInlineNewFile(),
    when: () => !getActiveExplorer()?.showsPluginView,
  },
  {
    id: "file.rename",
    scope: "pane",
    label: "Rename",
    category: "file",
    shortcut: "F2",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) {
        explorer?.startRename(selected);
      }
    },
    when: () => !getActiveExplorer()?.showsPluginView && (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.bulkRename",
    scope: "pane",
    label: "Bulk Rename...",
    category: "file",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length >= 2) {
        dialogStore.openBulkRename(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) >= 2,
  },
  {
    id: "file.delete",
    scope: "pane",
    label: "Delete",
    category: "file",
    shortcut: "Delete",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries();
      if (selected && selected.length > 0) {
        explorer?.startDelete(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.permanentDelete",
    scope: "pane",
    label: "Permanently Delete",
    category: "file",
    shortcut: "Shift+Delete",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries();
      if (selected && selected.length > 0) {
        explorer?.startPermanentDelete(selected);
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.openSelected",
    scope: "pane",
    label: "Open",
    category: "file",
    shortcut: "Enter",
    handler: async () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      // A trashed item opens only after Restore (#863).
      if (selected?.trash) explainTrashedOpen(selected);
      else if (selected) {
        // Follow Windows .lnk shortcuts to their target (no-op otherwise).
        const { resolveActivation } = await import("$lib/api/activate");
        const target = await resolveActivation(selected);
        if (target.kind === "directory") {
          explorer?.navigateTo(target.path);
        } else {
          const { openFile } = await import("$lib/api/open");
          const result = await openFile(target.path);
          if (result.ok) {
            // Opening a file marks its folder as worked-in for Recent ranking.
            const { frecencyStore } = await import("$lib/state/frecency.svelte");
            frecencyStore.recordFileAction(target.path);
          }
        }
      }
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
];

/** Edit commands (clipboard operations) */
export const editCommands: Command[] = [
  {
    id: "edit.copy",
    scope: "pane",
    label: "Copy",
    category: "edit",
    shortcut: "Ctrl+C",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length > 0) explorer?.copyToClipboard(selected);
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "edit.cut",
    scope: "pane",
    label: "Cut",
    category: "edit",
    shortcut: "Ctrl+X",
    handler: () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries() ?? [];
      if (selected.length > 0) explorer?.cutToClipboard(selected);
    },
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "edit.paste",
    scope: "pane",
    label: "Paste",
    category: "edit",
    shortcut: "Ctrl+V",
    handler: async () => {
      await getActiveExplorer()?.paste();
    },
  },
  {
    id: "edit.undo",
    scope: "pane",
    label: "Undo",
    category: "edit",
    shortcut: "Ctrl+Z",
    handler: async () => {
      await getActiveExplorer()?.undo();
    },
    when: () => !activePaneIsGraph(),
  },
  {
    id: "gitGraph.undo",
    scope: "pane",
    label: "Git Graph: Undo Last Operation",
    category: "edit",
    shortcut: "Ctrl+Z",
    handler: () => {
      requestGraphUndo(windowTabsManager.activeTab?.activePaneId);
    },
    when: () => activePaneIsGraph(),
  },
  {
    id: "edit.redo",
    scope: "pane",
    label: "Redo",
    category: "edit",
    shortcut: "Ctrl+Y",
    handler: async () => {
      await getActiveExplorer()?.redo();
    },
    when: () => !activePaneIsGraph(),
  },
  {
    id: "edit.redo2",
    scope: "pane",
    label: "Redo (Alt)",
    category: "edit",
    shortcut: "Ctrl+Shift+Z",
    handler: async () => {
      await getActiveExplorer()?.redo();
    },
    when: () => !activePaneIsGraph(),
  },
  {
    id: "edit.pasteAsTextFile",
    scope: "pane",
    label: "Paste Clipboard as Text File",
    category: "edit",
    handler: async () => {
      const explorer = getActiveExplorer();
      if (!explorer) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const dir = explorer.currentPath;
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const path = `${dir}/pasted-${timestamp}.txt`;
        await writeTextFile(path, text);
        explorer.refresh({ silent: true });
      } catch {
        // Clipboard access denied or empty
      }
    },
  },
  {
    id: "edit.pasteImage",
    scope: "pane",
    label: "Paste Image from Clipboard",
    category: "edit",
    shortcut: "Ctrl+Shift+V",
    handler: async () => {
      await getActiveExplorer()?.pasteImage();
    },
  },
];

/** Selection commands */
export const selectionCommands: Command[] = [
  {
    id: "selection.selectAll",
    scope: "pane",
    label: "Select All",
    category: "selection",
    shortcut: "Ctrl+A",
    handler: () => getActiveExplorer()?.selectAll(),
  },
  {
    // Lineage peek: extend the selection to every edit made from it.
    id: "selection.selectWithEdits",
    scope: "pane",
    label: "Select with Edits",
    category: "selection",
    when: () => !!getActiveExplorer()?.canSelectWithEdits,
    handler: () => getActiveExplorer()?.selectWithEdits(),
  },
  {
    id: "selection.clearSelection",
    scope: "pane",
    label: "Clear Selection",
    category: "selection",
    shortcut: "Escape",
    handler: () => getActiveExplorer()?.escapeSelectionOrPeek(),
    when: () => (getActiveExplorer()?.state.selectedPaths.size ?? 0) > 0 || !!getActiveExplorer()?.canEscapePeek,
  },
];

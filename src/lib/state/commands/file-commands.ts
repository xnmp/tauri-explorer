/**
 * File operation, clipboard, and selection commands.
 */

import type { Command } from "../commands.svelte";
import { writeTextFile } from "$lib/api/files";
import { clipboardPasteImage } from "$lib/api/clipboard-image";
import { dialogStore } from "../dialogs.svelte";
import { getActiveExplorer } from "./shared";
import { windowTabsManager } from "../window-tabs.svelte";
import { requestGraphUndo } from "../git-graph-undo";
import { activePaneIsGraph } from "./active-pane";

/** File operation commands */
export const fileCommands: Command[] = [
  {
    id: "file.newFolder",
    label: "New Folder",
    category: "file",
    shortcut: "Ctrl+Shift+N",
    handler: () => getActiveExplorer()?.startInlineNewFolder(),
  },
  {
    id: "file.newFile",
    label: "New File",
    category: "file",
    shortcut: "Ctrl+Alt+N",
    handler: () => getActiveExplorer()?.startInlineNewFile(),
  },
  {
    id: "file.rename",
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
    when: () => (getActiveExplorer()?.getSelectedEntries().length ?? 0) > 0,
  },
  {
    id: "file.bulkRename",
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
    label: "Open",
    category: "file",
    shortcut: "Enter",
    handler: async () => {
      const explorer = getActiveExplorer();
      const selected = explorer?.getSelectedEntries()[0];
      if (selected) {
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
    label: "Paste",
    category: "edit",
    shortcut: "Ctrl+V",
    handler: async () => {
      await getActiveExplorer()?.paste();
    },
  },
  {
    id: "edit.undo",
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
    label: "Paste Image from Clipboard",
    category: "edit",
    shortcut: "Ctrl+Shift+V",
    handler: async () => {
      const explorer = getActiveExplorer();
      if (!explorer) return;
      const result = await clipboardPasteImage(explorer.currentPath);
      if (result.ok) {
        explorer.refresh({ silent: true });
      }
    },
  },
];

/** Selection commands */
export const selectionCommands: Command[] = [
  {
    id: "selection.selectAll",
    label: "Select All",
    category: "selection",
    shortcut: "Ctrl+A",
    handler: () => getActiveExplorer()?.selectAll(),
  },
  {
    id: "selection.clearSelection",
    label: "Clear Selection",
    category: "selection",
    shortcut: "Escape",
    handler: () => getActiveExplorer()?.clearSelection(),
    when: () => (getActiveExplorer()?.state.selectedPaths.size ?? 0) > 0,
  },
];

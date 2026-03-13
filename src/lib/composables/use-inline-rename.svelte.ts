/**
 * Composable for inline rename functionality.
 * Encapsulates rename state, focus management with extension-aware selection,
 * and keyboard/blur handlers.
 * Issue: tauri-explorer-9djf.2
 */

import { tick } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";

export interface InlineRenameState {
  editedName: string;
  renameError: string | null;
  submittingRename: boolean;
}

export function useInlineRename(getExplorer: () => ExplorerInstance) {
  let renameInputRef = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  let editedName = $state("");
  let renameError = $state<string | null>(null);
  let submittingRename = $state(false);

  function focusAndSelect(entry: FileEntry) {
    editedName = entry.name;
    renameError = null;
    tick().then(() => {
      renameInputRef?.focus();
      if (entry.kind === "file") {
        const lastDot = entry.name.lastIndexOf(".");
        if (lastDot > 0) {
          renameInputRef?.setSelectionRange(0, lastDot);
        } else {
          renameInputRef?.select();
        }
      } else {
        renameInputRef?.select();
      }
    });
  }

  async function confirmRename(currentName: string) {
    if (submittingRename) return;
    const trimmed = editedName.trim();
    if (!trimmed) {
      renameError = "Name cannot be empty";
      return;
    }
    if (trimmed === currentName) {
      getExplorer().cancelRename();
      return;
    }
    submittingRename = true;
    renameError = null;
    const result = await getExplorer().rename(trimmed);
    submittingRename = false;
    if (result) renameError = result;
  }

  function cancelRename() {
    editedName = "";
    renameError = null;
    getExplorer().cancelRename();
  }

  function handleRenameKeydown(event: KeyboardEvent, currentName: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirmRename(currentName);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  }

  function handleRenameBlur(currentName: string) {
    if (editedName.trim() && editedName.trim() !== currentName) {
      confirmRename(currentName);
    } else {
      cancelRename();
    }
  }

  return {
    get renameInputRef() { return renameInputRef; },
    set renameInputRef(v) { renameInputRef = v; },
    get editedName() { return editedName; },
    set editedName(v) { editedName = v; },
    get renameError() { return renameError; },
    get submittingRename() { return submittingRename; },
    focusAndSelect,
    confirmRename,
    cancelRename,
    handleRenameKeydown,
    handleRenameBlur,
  };
}

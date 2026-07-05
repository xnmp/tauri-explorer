/**
 * Composable for inline rename functionality.
 * Encapsulates rename state, focus management with extension-aware selection,
 * and keyboard/blur handlers.
 * Issue: tauri-explorer-9djf.2
 */

import { tick } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { renameSuggestionStore } from "$lib/state/rename-suggestion.svelte";
import { findNextWordBoundary, findPrevWordBoundary } from "$lib/domain/word-boundary";

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
    // Ask the (optional) AI provider for a Tab-autocomplete suggestion.
    // Best-effort and non-blocking; no-op when no provider is registered.
    renameSuggestionStore.fetch(entry);
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
      dialogStore.cancelRename();
      return;
    }
    submittingRename = true;
    renameError = null;
    const result = await getExplorer().rename(trimmed);
    submittingRename = false;
    if (result) renameError = result;
    else renameSuggestionStore.clear();
  }

  function cancelRename() {
    editedName = "";
    renameError = null;
    renameSuggestionStore.clear();
    dialogStore.cancelRename();
  }

  /** Fill the input with the AI suggestion (Tab / hint click). Returns the
   *  accepted name, or null when there is no suggestion for this entry. */
  function acceptSuggestion(entry: FileEntry): string | null {
    const suggested = renameSuggestionStore.suggestionFor(entry.path);
    if (!suggested || suggested === editedName) return null;
    editedName = suggested;
    tick().then(() => {
      renameInputRef?.focus();
      const end = suggested.length;
      renameInputRef?.setSelectionRange(end, end);
    });
    return suggested;
  }

  /** Handle a rename-box keydown. Returns true when the key filled in the
   *  autocomplete suggestion (caller may want to resize the box). */
  function handleRenameKeydown(event: KeyboardEvent, currentName: string, entry?: FileEntry): boolean {
    if (event.key === "Tab" && !event.shiftKey && entry) {
      const accepted = acceptSuggestion(entry);
      if (accepted !== null) {
        // Keep focus in the box: Tab autocompletes instead of blurring.
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      return false;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirmRename(currentName);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    } else if ((event.ctrlKey || event.metaKey) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const input = renameInputRef;
      if (!input) return false;
      const text = input.value;
      const movingRight = event.key === "ArrowRight";
      const caretPos = movingRight
        ? (input.selectionEnd ?? 0)
        : (input.selectionStart ?? 0);
      const newPos = movingRight
        ? findNextWordBoundary(text, caretPos)
        : findPrevWordBoundary(text, caretPos);
      if (event.shiftKey) {
        const anchor = input.selectionDirection === "backward" ? input.selectionEnd! : input.selectionStart!;
        const [start, end] = newPos < anchor ? [newPos, anchor] : [anchor, newPos];
        input.setSelectionRange(start, end, newPos < anchor ? "backward" : "forward");
      } else {
        input.setSelectionRange(newPos, newPos);
      }
    }
    return false;
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
    acceptSuggestion,
    handleRenameKeydown,
    handleRenameBlur,
  };
}

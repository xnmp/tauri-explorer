/**
 * Copy, cut and paste for one pane. Paste reads the internal clipboard, the
 * OS file clipboard, then the clipboard image. Extracted from explorer.svelte.ts; the pane supplies its listing,
 * selection and refresh through `deps`.
 */

import { basename } from "$lib/domain/path";
import { selectPasteSource } from "$lib/domain/paste-source";
import type { FileEntry } from "$lib/domain/file";
import { clipboardImageStatus, clipboardPasteImage } from "$lib/api/clipboard-image";
import { withClipboardImageProgress } from "$lib/state/clipboard-image-progress.svelte";
import { clipboardStore, CUT_ALREADY_PASTED } from "./clipboard.svelte";
import { pasteEntries, type PasteResult } from "./paste-operations";
import { broadcastFileChange } from "./file-events";
import { toastStore } from "./toast.svelte";
import { operationRoots } from "$lib/domain/file-operation-selection";
import { entriesLabel } from "$lib/domain/explorer-entries";
import { isWindows } from "$lib/domain/platform";

interface MutationOrigin { path: string; current(): boolean }

export interface ExplorerPasteDeps {
  captureMutation(): MutationOrigin;
  captureSelection(): () => boolean;
  refresh(options: { silent: true }): Promise<unknown>;
  displayEntries(): FileEntry[];
  entries(): readonly FileEntry[];
  publishEntries(next: FileEntry[]): void;
  /** Select the pasted paths, cursor and anchor on the first. */
  select(paths: ReadonlySet<string>): void;
}

export function createExplorerClipboard(deps: ExplorerPasteDeps) {
  const { captureMutation, captureSelection, refresh } = deps;
    async function copyToClipboard(entries: FileEntry[]) {
      const result = operationRoots(entries, isWindows, deps.displayEntries());
      if (!result.ok) { toastStore.error(result.error); return; }
      entries = result.entries;
      if (!await clipboardStore.copy(entries)) return;
      toastStore.clipboard(`Copied: ${entriesLabel(entries)}`, false);
    }

    async function cutToClipboard(entries: FileEntry[]) {
      const result = operationRoots(entries, isWindows, deps.displayEntries());
      if (!result.ok) { toastStore.error(result.error); return; }
      entries = result.entries;
      if (!await clipboardStore.cut(entries)) return;
      toastStore.clipboard(`Cut: ${entriesLabel(entries)}`, true);
    }

  // Paste result for UI feedback
  let pasteResult = $state<PasteResult | null>(null);

  function makePasteContext(origin: ReturnType<typeof captureMutation>) {
    let selectionCurrent = captureSelection();
    const pastedPaths = new Set<string>();
    return {
      destPath: origin.path,
      existingEntries: deps.entries(),
      onEntriesAdded: (entries: FileEntry[]) => {
        if (!origin.current()) return;
        const newPaths = new Set(entries.map((entry) => entry.path));
        deps.publishEntries([...deps.entries().filter((entry) => !newPaths.has(entry.path)), ...entries]);
        for (const path of newPaths) pastedPaths.add(path);
        if (entries.length > 0 && selectionCurrent()) {
          deps.select(pastedPaths);
          selectionCurrent = captureSelection();
        }
      },
      onRefresh: async () => {
        if (origin.current()) await refresh({ silent: true });
      },
    };
  }

  async function pasteImageAt(origin: ReturnType<typeof captureMutation>, probe: boolean): Promise<string | null | undefined> {
    return withClipboardImageProgress(origin.path, async () => {
      if (probe) {
        const status = await clipboardImageStatus();
        if (!status.ok) {
          toastStore.error(`Could not read clipboard image: ${status.error}`);
          return status.error;
        }
        if (!status.data) return undefined;
      }
      const result = await clipboardPasteImage(origin.path);
      if (!result.ok) {
        toastStore.error(`Could not paste clipboard image into ${basename(origin.path) || origin.path}: ${result.error}`);
        return result.error;
      }
      broadcastFileChange([origin.path]);
      if (origin.current()) await refresh({ silent: true });
      toastStore.success(`Clipboard image saved to ${basename(origin.path) || origin.path}`);
      return null;
    });
  }

  async function pasteImage(): Promise<string | null> {
    const origin = captureMutation();
    if (!origin.current()) return "Pane is closed";
    if (!origin.path) return "No current directory";
    return (await pasteImageAt(origin, false)) ?? null;
  }

  async function paste(): Promise<string | null> {
    const origin = captureMutation();
    if (!origin.current()) return "Pane is closed";
    if (!origin.path) return "No current directory";
    const context = makePasteContext(origin);

    // The native snapshot waits behind every accepted file clipboard job,
    // including jobs from other windows. Paste never bypasses this order.
    const { error: osReadError, snapshot } = await clipboardStore.readOsFiles();
    const source = selectPasteSource(snapshot, osReadError);

    if (source.kind === "internal") {
      const sources = source.entries.map((e) => ({ path: e.path, name: e.name, size: e.size, modified: e.modified }));
      let error: string | null;
      if (source.operation === "cut") {
        const outcome = await clipboardStore.withCutClaim(source.revision, async () => {
          let complete = false;
          const result = await pasteEntries(sources, true, context, () => { complete = true; });
          return { result, complete };
        });
        if (!outcome.claimed) {
          toastStore.show(CUT_ALREADY_PASTED, "info");
          return null;
        }
        error = outcome.result;
      } else {
        error = await pasteEntries(sources, false, context);
      }
      if (origin.current()) pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // OS clipboard (files copied from external apps like Explorer/Finder)
    if (source.kind === "external") {
      const error = await pasteEntries(
        source.paths.map((p) => ({ path: p, name: basename(p) })),
        false,
        context,
      );
      if (origin.current()) pasteResult = { error, timestamp: Date.now() };
      return error;
    }

    // Fall back to clipboard image
    const imageError = await pasteImageAt(origin, true);
    if (imageError !== undefined) return imageError;

    // Nothing pasted: only now is a clipboard read failure worth surfacing
    // (#401) — when another source (internal clipboard, image) satisfied the
    // paste, the failed file-list probe was inconsequential noise.
    const error = osReadError ? `Reading the system clipboard failed: ${osReadError}` : "Nothing in clipboard";
    toastStore.error(error);
    return error;
  }

  return {
    copy: copyToClipboard,
    cut: cutToClipboard,
    paste,
    pasteImage,
    get result() { return pasteResult; },
  };
}

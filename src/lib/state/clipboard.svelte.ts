/** Process-wide file clipboard state. The native worker owns order and Cut identity. */
import type { FileEntry } from "$lib/domain/file";
import { basename } from "$lib/domain/path";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  osClipboardCompareAndClear,
  osClipboardHasFiles,
  osClipboardPublish,
  osClipboardRekey,
  osClipboardSnapshot,
  type NativeClipboardSnapshot,
  errorMessage,
} from "$lib/api/os-clipboard";
import { toastStore } from "./toast.svelte";

export type ClipboardOperation = "copy" | "cut";
export interface ClipboardContent { entries: FileEntry[]; operation: ClipboardOperation }
export interface OsClipboardContent { paths: string[]; operation: "copy" }
const CLIPBOARD_EVENT = "app://clipboard-sync";

function createClipboardStore() {
  let content = $state<ClipboardContent | null>(null);
  let revision = $state(0);
  let unlisten: UnlistenFn | null = null;
  let pendingCopy: ClipboardContent | null = null;
  let latestLocalJob = 0;
  const pathSet = $derived(new Set(content?.entries.map((entry) => entry.path) ?? []));

  function apply(snapshot: NativeClipboardSnapshot): void {
    if (snapshot.revision < revision || pendingCopy) return;
    revision = snapshot.revision;
    content = snapshot.entries && snapshot.operation
      ? { entries: snapshot.entries, operation: snapshot.operation }
      : null;
  }

  async function reconcile(): Promise<NativeClipboardSnapshot | null> {
    try {
      const snapshot = await osClipboardSnapshot();
      apply(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }

  async function notify(revisionHint = revision): Promise<void> {
    try { await emit(CLIPBOARD_EVENT, { revision: revisionHint }); } catch { /* browser mode */ }
  }

  async function startListening(): Promise<void> {
    try {
      unlisten = await listen<{ revision: number }>(CLIPBOARD_EVENT, (event) => {
        if (event.payload.revision >= revision) void reconcile();
      });
      await reconcile();
    } catch { /* browser mode */ }
  }
  void startListening();

  async function publish(entries: FileEntry[], operation: ClipboardOperation): Promise<boolean> {
    if (entries.length === 0) return false;
    const optimistic = { entries, operation };
    const job = ++latestLocalJob;
    pendingCopy = operation === "copy" ? optimistic : null;
    if (operation === "copy") content = optimistic;
    try {
      const snapshot = await osClipboardPublish(entries, operation);
      if (job === latestLocalJob) {
        pendingCopy = null;
        apply(snapshot);
        await reconcile();
      }
      if (snapshot.mirrorError) toastStore.error(`Copy works in-app, but the system clipboard failed: ${snapshot.mirrorError}`);
      await notify(snapshot.revision);
      return true;
    } catch (error) {
      if (operation === "cut") {
        toastStore.error(`Cut failed: ${errorMessage(error)}`);
      } else {
        toastStore.error(`System clipboard failed: ${errorMessage(error)}`);
      }
      if (job === latestLocalJob) {
        pendingCopy = null;
        await reconcile();
      }
      return false;
    }
  }

  return {
    get content() { return content; },
    get revision() { return revision; },
    get isCut() { return content?.operation === "cut"; },
    get count() { return content?.entries.length ?? 0; },
    get hasPendingLocalCopy() { return pendingCopy !== null && content === pendingCopy; },
    get pathSet() { return pathSet; },
    copy(entries: FileEntry[]): Promise<boolean> { return publish(entries, "copy"); },
    cut(entries: FileEntry[]): Promise<boolean> { return publish(entries, "cut"); },
    async clear(): Promise<void> {
      const expected = revision;
      content = null;
      try {
        if (await osClipboardCompareAndClear(expected)) await notify();
        else await reconcile();
      } catch { await reconcile(); }
    },
    async take(): Promise<ClipboardContent | null> {
      const snapshot = await reconcile();
      if (!snapshot?.entries || !snapshot.operation) return null;
      const selected = { entries: snapshot.entries, operation: snapshot.operation };
      if (selected.operation === "cut") await this.clearIfRevision(snapshot.revision);
      return selected;
    },
    async clearIfRevision(expected: number): Promise<void> {
      try {
        if (await osClipboardCompareAndClear(expected)) {
          await reconcile();
          await notify();
        }
      } catch { await reconcile(); }
    },
    async rekeyPath(oldPath: string, newPath: string, snapshot: FileEntry | null = null): Promise<void> {
      const current = content;
      const existing = current?.entries.find((entry) => entry.path === oldPath);
      if (!existing) return;
      const entry = snapshot ?? { ...existing, path: newPath, name: basename(newPath) };
      try {
        const changed = await osClipboardRekey(revision, oldPath, entry);
        if (changed) { apply(changed); await notify(); }
        else await reconcile();
      } catch { await reconcile(); }
    },
    hasOsFiles(): Promise<boolean> { return osClipboardHasFiles(); },
    async readOsFiles(): Promise<{ content: OsClipboardContent | null; error: string | null; snapshot: NativeClipboardSnapshot | null }> {
      // The native snapshot waits for every accepted job across renderers.
      try {
        let snapshot = await osClipboardSnapshot();
        while (snapshot.revision < revision) snapshot = await osClipboardSnapshot();
        apply(snapshot);
        return {
          content: snapshot.paths.length ? { paths: snapshot.paths, operation: "copy" } : null,
          error: null,
          snapshot,
        };
      } catch (error) {
        return { content: null, error: String(error), snapshot: null };
      }
    },
    destroy(): void { unlisten?.(); },
  };
}

export const clipboardStore = createClipboardStore();

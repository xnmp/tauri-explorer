/**
 * Native E2E hooks for one page session. Loaded only through
 * `loadE2EHooks()` in `$lib/api/e2e-hooks`, so builds without
 * `VITE_E2E_HOOKS=1` contain none of this module graph (#884).
 *
 * Every handler, interceptor and readiness marker belongs to the page session:
 * aborting `signal` removes them, and nothing publishes afterwards.
 */
import { windowTabsManager } from "../lib/state/window-tabs.svelte";
import type { FileEntry } from "../lib/domain/file";
import type { ExplorerInstance } from "../lib/state/explorer.svelte";
import { createDomRpc } from "./dom-rpc";
import { startDirectoryListingProbe } from "./directory-listing-probe";
import { startExternalJobProbe } from "./external-job-probe";
import { startFileHistoryProbe } from "./file-history-probe";
import { startFileMutationProbe } from "./file-mutation-probe";
import { startFileRecoveryProbe } from "./file-recovery-probe";
import { childReadyKey, WARM_READY_PREFIX, windowOperationHandlers, type WindowOperationRequest } from "./window-operations";

export function startWindowSessionProbe(signal: AbortSignal, warmReady?: Promise<boolean>): void {
  if (signal.aborted) return;
  startFileHistoryProbe(signal);
  startFileRecoveryProbe(signal);
  startExternalJobProbe(signal);
  startDirectoryListingProbe(signal);
  startFileMutationProbe(signal);
  const listen = (name: string, handler: EventListener) => window.addEventListener(name, handler, { signal });
  const readyKey = childReadyKey(windowTabsManager.windowLabel);
  let capturedDelete: { token: string; explorer: ExplorerInstance; entries: FileEntry[] } | null = null;
  signal.addEventListener("abort", () => {
    capturedDelete = null;
    if (windowTabsManager.windowLabel !== "main") localStorage.removeItem(readyKey);
    for (const key of ["e2eHooksReady", "e2eWindowLabel", "e2eNavigationComplete", "e2eFileOperationResult"]) {
      delete document.documentElement.dataset[key];
    }
  }, { once: true });
  listen("e2e-navigate", ((
    e: CustomEvent<string | { path: string; token?: string }>,
  ) => {
    const path = typeof e.detail === "string" ? e.detail : e.detail.path;
    const token = typeof e.detail === "string" ? undefined : e.detail.token;
    const navigation = windowTabsManager.getActiveExplorer()?.navigateTo(path);
    if (navigation && token) {
      void navigation.then(() => {
        if (!signal.aborted) document.documentElement.dataset.e2eNavigationComplete = token;
      });
    }
  }) as EventListener);

  // Restore the active pane to its file listing by closing any open commit
  // graph. The per-pane `gitGraph` state persists to localStorage, which is
  // shared across every tauri-driver session (same http://localhost origin),
  // so a spec that leaves the graph open (git-graph-pull) would otherwise
  // relaunch every later spec into graph mode — no `.file-list` ever renders
  // (#447). Specs call this via navigateTo before waiting for the listing.
  listen("e2e-reset-view", (() => {
    for (const paneId of windowTabsManager.activePaneIds) {
      windowTabsManager.setPaneGitGraph(paneId, null);
    }
  }) as EventListener);

  listen("e2e-file-op", ((
    e: CustomEvent<{ op: string; name?: string; path?: string; paths?: string[]; token?: string; permanent?: boolean }>,
  ) => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer) return;
    const { op, name, path, paths, token, permanent } = e.detail;
    const entry = path
      ? explorer.displayEntries.find((en) => en.path === path)
      : undefined;
    let pending: Promise<string | null> | undefined;
    if (op === "capture-delete" && token && paths) {
      const targets = new Set(paths);
      const entries = explorer.displayEntries.filter((entry) => targets.has(entry.path));
      const error = entries.length === targets.size ? null : "Some requested entries are not listed";
      capturedDelete = error ? null : { token, explorer, entries };
      document.documentElement.dataset.e2eFileOperationResult = JSON.stringify({
        token, status: "captured", completedAt: Date.now(), error,
      });
      return;
    } else if (op === "confirm-captured-delete" && capturedDelete && capturedDelete.token === token) {
      const captured = capturedDelete;
      capturedDelete = null;
      pending = captured.explorer.confirmDelete(captured.entries, permanent === true);
    } else if (op === "undo" || op === "redo") {
      pending = explorer[op]();
    } else if (op === "cut" && (entry || paths)) {
      // A multi-path cut is the ordered-session case: one clipboard, one
      // native move session, one history entry (#685).
      const selected = paths
        ? explorer.displayEntries.filter((listed) => paths.includes(listed.path))
        : [entry!];
      pending = selected.length === (paths?.length ?? 1)
        ? explorer.cutToClipboard(selected).then(() => null)
        : Promise.resolve("Some requested entries are not listed");
    } else if (op === "paste") {
      pending = explorer.paste();
    } else if (op === "new-folder" && name) {
      pending = explorer.createFolder(name);
    } else if (op === "rename" && entry && name) {
      explorer.startRename(entry);
      pending = explorer.rename(name);
    } else if (op === "delete" && entry) {
      pending = explorer.confirmDelete([entry]);
    }
    if (pending && token) {
      const completed = (error: string | null) => {
        if (!signal.aborted) document.documentElement.dataset.e2eFileOperationResult = JSON.stringify({
          token, status: "completed", completedAt: Date.now(), error,
        });
      };
      void pending.then(completed, (error) => completed(String(error)));
    }
  }) as EventListener);

  createDomRpc<WindowOperationRequest>({
    event: "e2e-window-operation",
    resultKey: "e2eWindowResult",
    signal,
    handlers: windowOperationHandlers(signal),
  });
  document.documentElement.dataset.e2eWindowLabel = windowTabsManager.windowLabel;
  void warmReady?.then((ready) => {
    if (ready && !signal.aborted) localStorage.setItem(WARM_READY_PREFIX + windowTabsManager.windowLabel, "1");
  });

  // WebKitWebDriver can execute injected scripts before these listeners
  // exist. Publish readiness through the DOM (visible across WebKit's
  // isolated JS worlds) so the driver can dispatch each navigation once
  // and wait for its matching completion token. Repeated polling dispatches
  // queue duplicate real listings and contaminate watcher timing probes.
  document.documentElement.dataset.e2eHooksReady = "true";
  if (windowTabsManager.windowLabel !== "main") {
    // This test-only receipt is shared with the main page through app-origin
    // storage. Await the production native close handler, the initial listing,
    // and a paint before reporting child readiness.
    const readyPath = () => {
      const explorer = windowTabsManager.getActiveExplorer();
      return explorer && !explorer.loading && explorer.displayEntries.length > 0 &&
        document.querySelector(".file-list") ? explorer.currentPath : null;
    };
    const reportReady = () => {
      if (signal.aborted) return;
      const path = readyPath();
      if (!path) {
        requestAnimationFrame(reportReady);
        return;
      }
      requestAnimationFrame(() => {
        if (signal.aborted) return;
        if (readyPath() === path) localStorage.setItem(readyKey, path);
        else requestAnimationFrame(reportReady);
      });
    };
    void windowTabsManager.whenNativeCloseObserved().then((ready) => {
      if (ready && !signal.aborted) requestAnimationFrame(reportReady);
    });
  }
}

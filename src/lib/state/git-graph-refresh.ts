/**
 * Git-graph refresh bus (#432).
 *
 * F5 used to be a shadow keybinding inside GitGraphView's own
 * `<svelte:window onkeydown>` — invisible to the keybindings registry, so the
 * terminal key-ownership gate could never know the graph "owned" F5, and the
 * listener fired for every mounted graph tab whether active or not.
 *
 * Instead, `gitGraph.refresh` is now a real registered command (F5, gated on
 * the active pane showing a graph). GitGraphView registers its own
 * fetch+reload handler here keyed by pane id; the command dispatches to the
 * ACTIVE pane's handler only. No component-level global key listener.
 */

import { listen } from "@tauri-apps/api/event";
import {
  GIT_NETWORK_PHASE_DOM_EVENT,
  GIT_NETWORK_PHASE_EVENT,
  type GitNetworkPhaseEvent,
} from "$lib/domain/git-network-operation";

type RefreshFn = () => void;

export interface ReloaderContext {
  generation: number;
  isCurrent(): boolean;
}

export interface Reloader {
  readonly generation: number;
  reload(): Promise<void>;
}

/**
 * Serializes graph reloads without dropping a request made during an active
 * fetch. Consumers use `isCurrent` before applying asynchronous results and
 * use `generation` to reject a page appended by an older graph query.
 */
export function createReloader(fetchFn: (context: ReloaderContext) => Promise<void>): Reloader {
  let generation = 0;
  let reloading = false;
  let reloadDirty = false;

  const reload = async (): Promise<void> => {
    if (reloading) {
      reloadDirty = true;
      return;
    }

    reloading = true;
    reloadDirty = false;
    const currentGeneration = ++generation;
    try {
      await fetchFn({
        generation: currentGeneration,
        isCurrent: () => currentGeneration === generation,
      });
    } finally {
      reloading = false;
      if (reloadDirty) void reload();
    }
  };

  return {
    get generation() {
      return generation;
    },
    reload,
  };
}

/** A graph action reloads itself, so it ignores its matching local event. */
export function shouldReloadGraphForChange(change: { source: "watcher" | "local" }): boolean {
  return change.source !== "local";
}

export interface GitNetworkOperation {
  taskId: number;
  repoPath: string;
  label: string;
  cancellable: boolean;
  cancelling: boolean;
}

type GitNetworkOperationListener = (operation: GitNetworkOperation | null) => void;
const networkOperationListeners = new Set<GitNetworkOperationListener>();
let activeNetworkOperation: GitNetworkOperation | null = null;
let phaseListenerReady: Promise<void> | null = null;
let domPhaseListenerAttached = false;

function applyNetworkPhase(phase: GitNetworkPhaseEvent): void {
  const operation = activeNetworkOperation;
  if (!operation || operation.taskId !== phase.taskId) return;
  activeNetworkOperation = {
    ...operation,
    cancellable: phase.cancellable,
    cancelling: phase.cancellable ? operation.cancelling : false,
  };
  publishNetworkOperation();
}

async function ensureNetworkPhaseListener(): Promise<void> {
  if (!domPhaseListenerAttached && typeof window !== "undefined") {
    domPhaseListenerAttached = true;
    window.addEventListener(GIT_NETWORK_PHASE_DOM_EVENT, (event) => {
      applyNetworkPhase((event as CustomEvent<GitNetworkPhaseEvent>).detail);
    });
  }
  phaseListenerReady ??= listen<GitNetworkPhaseEvent>(GIT_NETWORK_PHASE_EVENT, (event) => {
    applyNetworkPhase(event.payload);
  })
    .then(() => undefined)
    .catch(() => undefined);
  await phaseListenerReady;
}

function publishNetworkOperation(): void {
  const snapshot = activeNetworkOperation ? { ...activeNetworkOperation } : null;
  for (const listener of networkOperationListeners) listener(snapshot);
}

/** Observe the single process-wide graph network operation. */
export function subscribeGitNetworkOperation(listener: GitNetworkOperationListener): () => void {
  networkOperationListeners.add(listener);
  listener(activeNetworkOperation ? { ...activeNetworkOperation } : null);
  return () => networkOperationListeners.delete(listener);
}

/** Run one fetch/pull/push with a client-generated cancellation id. */
export async function runGitNetworkOperation<T>(
  repoPath: string,
  label: string,
  invoke: (taskId: number) => Promise<T>,
): Promise<T> {
  await ensureNetworkPhaseListener();
  if (activeNetworkOperation) {
    throw new Error(`Git ${activeNetworkOperation.label} is already running`);
  }
  const taskId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  activeNetworkOperation = { taskId, repoPath, label, cancellable: true, cancelling: false };
  publishNetworkOperation();
  try {
    return await invoke(taskId);
  } finally {
    if (activeNetworkOperation?.taskId === taskId) {
      activeNetworkOperation = null;
      publishNetworkOperation();
    }
  }
}

/** Mark the active UI state immediately, then relay cancellation to Rust. */
export async function cancelActiveGitNetworkOperation(
  cancel: (taskId: number) => Promise<void>,
): Promise<void> {
  const operation = activeNetworkOperation;
  if (!operation || !operation.cancellable || operation.cancelling) return;
  activeNetworkOperation = { ...operation, cancelling: true };
  publishNetworkOperation();
  await cancel(operation.taskId);
}

/** Stash rows are woven into the graph but are not git-walk pagination steps. */
export function countGraphWalkCommits<T extends { stash?: unknown }>(
  commits: ReadonlyArray<T>,
): number {
  return commits.filter((commit) => !commit.stash).length;
}

const refreshers = new Map<string, RefreshFn>();

/** Register a pane's graph refresh handler. Returns an unregister fn; call it
 *  on unmount. Idempotent per pane — a remount replaces the prior handler. */
export function registerGraphRefresher(paneId: string, fn: RefreshFn): () => void {
  refreshers.set(paneId, fn);
  return () => {
    if (refreshers.get(paneId) === fn) refreshers.delete(paneId);
  };
}

/** Trigger the refresh handler for one pane (the active graph pane). No-op
 *  when the pane has no registered graph. */
export function refreshGraphPane(paneId: string | undefined | null): boolean {
  if (!paneId) return false;
  const fn = refreshers.get(paneId);
  if (!fn) return false;
  fn();
  return true;
}

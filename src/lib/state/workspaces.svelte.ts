/**
 * Workspaces state management using Svelte 5 runes.
 * Issue: tauri-explorer-6iax
 *
 * A workspace is a named snapshot of the current tab layout
 * (tabs, pane paths, active pane, dual-pane state, split ratios).
 * Workspaces are persisted to localStorage and can be restored.
 */

import type { PersistedTabState } from "./window-tabs.svelte";
import { loadPersisted, savePersisted } from "./persisted";

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  state: PersistedTabState;
}

const STORAGE_KEY = "explorer-workspaces";
const MAX_WORKSPACES = 20;

function generateId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadWorkspaces(): Workspace[] {
  return loadPersisted(STORAGE_KEY, []);
}

function saveWorkspaces(ws: Workspace[]): void {
  savePersisted(STORAGE_KEY, ws);
}

function createWorkspacesStore() {
  let workspaces = $state<Workspace[]>(loadWorkspaces());

  // Change listeners (e.g. the palette's dynamic "Workspaces: Open …"
  // commands re-sync on every mutation). Kept as plain callbacks so the
  // non-reactive command registry can subscribe without a rune context.
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function save(name: string, tabState: PersistedTabState): Workspace {
    const existing = workspaces.find((w) => w.name === name);
    const now = Date.now();

    if (existing) {
      // Update existing workspace
      const updated: Workspace = { ...existing, updatedAt: now, state: tabState };
      workspaces = workspaces.map((w) => (w.id === existing.id ? updated : w));
      saveWorkspaces(workspaces);
      notify();
      return updated;
    }

    // Create new workspace
    const workspace: Workspace = {
      id: generateId(),
      name,
      createdAt: now,
      updatedAt: now,
      state: tabState,
    };

    workspaces = [workspace, ...workspaces].slice(0, MAX_WORKSPACES);
    saveWorkspaces(workspaces);
    notify();
    return workspace;
  }

  function remove(id: string): void {
    workspaces = workspaces.filter((w) => w.id !== id);
    saveWorkspaces(workspaces);
    notify();
  }

  function rename(id: string, newName: string): void {
    workspaces = workspaces.map((w) =>
      w.id === id ? { ...w, name: newName, updatedAt: Date.now() } : w
    );
    saveWorkspaces(workspaces);
    notify();
  }

  /** Subscribe to workspace list changes; returns an unsubscribe. */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function get(id: string): Workspace | undefined {
    return workspaces.find((w) => w.id === id);
  }

  return {
    get list() {
      return workspaces;
    },
    get count() {
      return workspaces.length;
    },
    save,
    remove,
    rename,
    get,
    subscribe,
  };
}

export const workspacesStore = createWorkspacesStore();

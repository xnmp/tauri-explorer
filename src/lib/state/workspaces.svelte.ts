/**
 * Workspaces state management using Svelte 5 runes.
 * Issue: tauri-explorer-6iax
 *
 * A workspace is a named snapshot of the current tab layout
 * (tabs, pane paths, active pane, dual-pane state, split ratios).
 * Workspaces are persisted to localStorage and can be restored.
 */

import type { PersistedTabState } from "./window-tabs.svelte";

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
  if (typeof localStorage === "undefined") return [];
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: Workspace[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
}

function createWorkspacesStore() {
  let workspaces = $state<Workspace[]>(loadWorkspaces());

  function save(name: string, tabState: PersistedTabState): Workspace {
    const existing = workspaces.find((w) => w.name === name);
    const now = Date.now();

    if (existing) {
      // Update existing workspace
      const updated: Workspace = { ...existing, updatedAt: now, state: tabState };
      workspaces = workspaces.map((w) => (w.id === existing.id ? updated : w));
      saveWorkspaces(workspaces);
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
    return workspace;
  }

  function remove(id: string): void {
    workspaces = workspaces.filter((w) => w.id !== id);
    saveWorkspaces(workspaces);
  }

  function rename(id: string, newName: string): void {
    workspaces = workspaces.map((w) =>
      w.id === id ? { ...w, name: newName, updatedAt: Date.now() } : w
    );
    saveWorkspaces(workspaces);
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
  };
}

export const workspacesStore = createWorkspacesStore();

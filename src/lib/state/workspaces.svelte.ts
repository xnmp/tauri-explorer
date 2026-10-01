/**
 * Workspaces state management using Svelte 5 runes.
 * Issue: tauri-explorer-6iax
 *
 * A workspace is a named snapshot of the current tab layout
 * (tabs, pane paths, active pane, dual-pane state, split ratios).
 * Workspaces are persisted to localStorage and can be restored.
 */

import type { PersistedTabState } from "./window-tabs.svelte";
import { normalizePersistedState, persistedStateAllocation, MAX_TOTAL_LAYOUT_NODES } from "./window-tabs-persistence";
import { loadPersisted, savePersisted } from "./persisted";
import { isRecord, WINDOW_SEED_MAX_CHARS } from "$lib/domain/window-input";

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  state: PersistedTabState;
}

const STORAGE_KEY = "explorer-workspaces";
const MAX_WORKSPACES = 20;
/** Validate persisted workspace metadata and delegate tab/layout validation to
 * the canonical window-tabs normalizer. Input is bounded before normalization. */
export function normalizeWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const workspaces: Workspace[] = [];
  let remainingNodes = MAX_TOTAL_LAYOUT_NODES;
  for (const candidate of value.slice(0, MAX_WORKSPACES)) {
    if (!isRecord(candidate)) continue;
    const { id, name, createdAt, updatedAt, state } = candidate;
    if (
      typeof id !== "string" || id.length === 0 || ids.has(id) ||
      typeof name !== "string" || name.length === 0 ||
      typeof createdAt !== "number" || !Number.isFinite(createdAt) ||
      typeof updatedAt !== "number" || !Number.isFinite(updatedAt) ||
      !isRecord(state)
    ) continue;
    const allocation = persistedStateAllocation(state, remainingNodes);
    if (allocation === null) continue;
    const normalizedState = normalizePersistedState(state);
    // A malformed tab/layout is filtered by the canonical normalizer. Do not
    // retain the containing workspace as an apparently valid empty snapshot.
    if (!normalizedState || normalizedState.tabs.length === 0) continue;
    ids.add(id);
    remainingNodes -= allocation;
    workspaces.push({ id, name, createdAt, updatedAt, state: normalizedState });
  }
  return workspaces;
}

function generateId(): string {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadWorkspaces(): Workspace[] {
  return normalizeWorkspaces(loadPersisted<unknown>(STORAGE_KEY, [], WINDOW_SEED_MAX_CHARS));
}

function saveWorkspaces(ws: Workspace[]): void {
  savePersisted(STORAGE_KEY, ws);
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

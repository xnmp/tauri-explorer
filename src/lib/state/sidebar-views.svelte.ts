/**
 * Sidebar view registry (#52).
 *
 * An entry here adds a pluggable view to the activity-bar sidebar. Each view
 * is kept mounted (toggled via `hidden`) so scroll/selection survive switches.
 *
 * This module owns only the plain descriptors (id/label), the active-view
 * selection, and its persistence. The id -> {icon, component} mapping is a
 * presentation concern and lives in the components layer (see
 * `src/lib/components/sidebar-view-registry.ts`) so this state module has no
 * dependency on Svelte components.
 */

import { loadPersistedRaw, savePersistedRaw } from "$lib/state/persisted";

export interface SidebarViewDescriptor {
  id: string;
  label: string;
}

export const ALL_SIDEBAR_VIEWS: SidebarViewDescriptor[] = [
  { id: "files", label: "Explorer" },
];

// Stored as a raw view id (not JSON) — predates persisted.ts's JSON
// convention, kept as-is so existing users' saved values still load.
const STORAGE_KEY = "explorer-sidebar-active-view";

function loadInitial(): string {
  const saved = loadPersistedRaw(STORAGE_KEY);
  if (saved && ALL_SIDEBAR_VIEWS.some((v) => v.id === saved)) return saved;
  return ALL_SIDEBAR_VIEWS[0].id;
}

function createSidebarViewStore() {
  let activeId = $state(loadInitial());

  const visibleViews = ALL_SIDEBAR_VIEWS;

  const effectiveActiveId = $derived(
    visibleViews.some((v) => v.id === activeId) ? activeId : "files"
  );

  return {
    get activeId() { return effectiveActiveId; },
    get views() { return visibleViews; },
    setActive(id: string) {
      if (!ALL_SIDEBAR_VIEWS.some((v) => v.id === id)) return;
      activeId = id;
      savePersistedRaw(STORAGE_KEY, id);
    },
  };
}

export const sidebarViewsStore = createSidebarViewStore();

/**
 * Sidebar view registry (#52).
 *
 * An entry here adds a pluggable view to the activity-bar sidebar. Each view
 * is kept mounted (toggled via `hidden`) so scroll/selection survive switches.
 */

import type { Component } from "svelte";
import FilesSidebarView from "$lib/components/FilesSidebarView.svelte";
import ScmSidebarView from "$lib/components/ScmSidebarView.svelte";
import { settingsStore } from "./settings.svelte";

export interface SidebarView {
  id: string;
  label: string;
  icon: Component;
  component: Component;
}

import FilesIcon from "$lib/components/icons/FilesIcon.svelte";
import ScmIcon from "$lib/components/icons/ScmIcon.svelte";

export const ALL_SIDEBAR_VIEWS: SidebarView[] = [
  { id: "files", label: "Explorer", icon: FilesIcon, component: FilesSidebarView },
  { id: "scm", label: "Source Control", icon: ScmIcon, component: ScmSidebarView },
];

const STORAGE_KEY = "explorer-sidebar-active-view";

function loadInitial(): string {
  if (typeof localStorage === "undefined") return ALL_SIDEBAR_VIEWS[0].id;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && ALL_SIDEBAR_VIEWS.some((v) => v.id === saved)) return saved;
  return ALL_SIDEBAR_VIEWS[0].id;
}

function createSidebarViewStore() {
  let activeId = $state(loadInitial());

  const visibleViews = $derived(
    settingsStore.showGitStatus
      ? ALL_SIDEBAR_VIEWS
      : ALL_SIDEBAR_VIEWS.filter((v) => v.id !== "scm")
  );

  const effectiveActiveId = $derived(
    visibleViews.some((v) => v.id === activeId) ? activeId : "files"
  );

  return {
    get activeId() { return effectiveActiveId; },
    get views() { return visibleViews; },
    setActive(id: string) {
      if (!ALL_SIDEBAR_VIEWS.some((v) => v.id === id)) return;
      activeId = id;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, id);
      }
    },
  };
}

export const sidebarViewsStore = createSidebarViewStore();

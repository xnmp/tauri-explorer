/**
 * Presentation mapping for sidebar views (#52).
 *
 * `state/sidebar-views.svelte.ts` owns the plain {id, label} descriptors and
 * the active-view selection/persistence. This module maps each descriptor's
 * id to its icon and component — a components-layer concern kept out of
 * state so that layer stays free of Svelte component imports.
 */

import type { Component } from "svelte";
import FilesSidebarView from "$lib/components/FilesSidebarView.svelte";
import FilesIcon from "$lib/components/icons/FilesIcon.svelte";

export interface SidebarViewPresentation {
  icon: Component;
  component: Component;
}

export const SIDEBAR_VIEW_PRESENTATION: Record<string, SidebarViewPresentation> = {
  files: { icon: FilesIcon, component: FilesSidebarView },
};

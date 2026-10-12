/** Mounted plugin views expose their existing pane handle to host reveal actions. */
import type { FileViewPane } from "$lib/plugins/file-view-registry.svelte";
const panes = new Map<string, { viewId: string; pane: FileViewPane }>();
export function registerFileViewPane(viewId: string, pane: FileViewPane): () => void {
  const registration = { viewId, pane };
  panes.set(pane.paneId, registration);
  return () => { if (panes.get(pane.paneId) === registration) panes.delete(pane.paneId); };
}
export function mountedFileViewPane(paneId: string, viewId: string): FileViewPane | undefined {
  const mounted = panes.get(paneId);
  return mounted?.viewId === viewId ? mounted.pane : undefined;
}

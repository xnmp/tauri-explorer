/**
 * An entry's Git status presentation (#1852), shared by the status chip
 * (`GitStatusBadge`) and the tinted name (`EntryName`/`EntryNameLabel`).
 *
 * Statuses are keyed per directory: the entry's explicit directory (a peek
 * row's parent) or else the owning pane's current path, so dual panes showing
 * different directories don't bleed statuses into each other. One derived per
 * caller; no effects. Call during component initialisation (pane context).
 */
import { gitStatusPresentation, type GitStatusPresentation } from "$lib/domain/git-status-presentation";
import { settingsStore } from "$lib/state/settings.svelte";
import { gitStatusStore } from "$lib/state/git-status.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { getPaneIdContext } from "$lib/state/pane-context";

export function useEntryGitStatus(
  entryName: () => string,
  directory: () => string | undefined,
): { readonly presentation: GitStatusPresentation | null } {
  const paneId = getPaneIdContext();
  const presentation = $derived.by(() => {
    if (!settingsStore.showGitStatus) return null;
    const dir = directory() ?? (paneId ? windowTabsManager.getExplorer(paneId)?.currentPath : undefined);
    return dir ? gitStatusPresentation(gitStatusStore.getStatus(dir, entryName())) : null;
  });
  return { get presentation() { return presentation; } };
}

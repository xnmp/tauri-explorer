/** Window-owned reveal effects. Policy and cancellation live in the domain layer. */
import { tick } from "svelte";
import { latestPluginJobReveal } from "$lib/api/native-plugin-jobs";
import { createJobRevealController, routeJobReveal, selectWorkspaceFile, type RevealDependencies } from "$lib/domain/job-reveal";
import { nativeParentDir, sameNativeDirectory } from "$lib/domain/path";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";
import { mountedFileViewPane } from "./file-view-panes";
import { windowTabsManager } from "./window-tabs.svelte";
import { toastStore } from "./toast.svelte";
import type { Job } from "./jobs.svelte";

export const jobRevealController = createJobRevealController<Job>({
  latest: async job => job.jobKey ? latestPluginJobReveal(job.jobKey) : undefined,
  route: async (reveal, signal) => {
    let explorer = windowTabsManager.getActiveExplorer();
    let paneId = windowTabsManager.activePaneId;
    const directory = reveal.kind === "file" ? nativeParentDir(reveal.path) : reveal.directory;
    let opened = false;
    let superseded = false;
    const current = () => !signal.aborted && !!explorer && windowTabsManager.getActiveExplorer() === explorer && (!opened || sameNativeDirectory(explorer.currentPath, directory));
    const deps: RevealDependencies = {
      panes: () => windowTabsManager.tabs.flatMap(tab => tab.kind === "explorer" ? Object.entries(tab.panes).map(([id, pane]) => {
        const live = windowTabsManager.getExplorer(id);
        return { tabId: tab.id, paneId: id, directory: live?.currentPath || pane.path, viewId: live ? live.fileView : pane.fileView };
      }) : []),
      open: async (directory, existing) => {
        if (existing) { windowTabsManager.setActiveTab(existing.tabId); windowTabsManager.setActivePane(existing.paneId); }
        else if (!windowTabsManager.getActiveExplorer()) windowTabsManager.createTab(directory);
        explorer = windowTabsManager.getActiveExplorer(); paneId = windowTabsManager.activePaneId;
        if (!explorer) throw new Error("No file pane is available");
        windowTabsManager.setPaneGitGraph(paneId, null);
        const previousDirectory = explorer.currentPath;
        if (!sameNativeDirectory(previousDirectory, directory) || explorer.state.loading || explorer.error !== null) {
          const navigation = explorer.navigateTo(directory, { autoEnterSingleSubdir: false });
          const navigationOwner = explorer.captureMutation();
          if (!await navigation) {
            superseded = !current() || !navigationOwner.current();
            return false;
          }
        }
        opened = true;
        if (!current()) return false;
        // Activation can remount the listing; selection must see its scroll seam.
        await tick();
      },
      fallback: () => { if (current()) windowTabsManager.setPaneFileView(paneId, null); },
      file: async (path, signal) => {
        if (!explorer) return "aborted";
        const selectedExplorer = explorer;
        await tick();
        return selectWorkspaceFile(path, {
          currentDirectory: () => selectedExplorer.currentPath, current,
          navigate: directory => selectedExplorer.navigateTo(directory, { autoEnterSingleSubdir: false }),
          refresh: () => selectedExplorer.refresh({ silent: true }),
          select: path => selectedExplorer.revealEntry(path),
          capture: () => { const lease = selectedExplorer.captureMutation(); return () => lease.current() && lease.selectionCurrent(); },
        }, signal);
      },
      view: async (viewId, targetId, signal) => {
        if (!current() || !explorer) return false;
        const view = fileViewRegistry.resolve(viewId, explorer.currentPath);
        if (!view) return false;
        windowTabsManager.setPaneFileView(paneId, viewId);
        await tick();
        if (!current()) return false;
        const pane = mountedFileViewPane(paneId, viewId);
        if (!view.reveal || !pane) return false;
        await view.reveal(targetId, pane, signal);
        return true;
      },
      notify: message => { if (!superseded && current()) toastStore.show(message, "info"); },
    };
    await routeJobReveal(reveal, deps, signal);
  },
  error: () => toastStore.show("The image could not be shown", "info"),
});

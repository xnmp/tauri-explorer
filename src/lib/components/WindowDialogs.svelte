<script lang="ts">
  import type { PickerInfo } from "./FilePicker.svelte";
  import { useLazyDialog } from "$lib/composables/use-lazy-dialog.svelte";
  import { createDialogCrashHandler } from "$lib/domain/lazy-dialog";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
  import { conflictResolver } from "$lib/state/conflict-resolver.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import ShortcutCheatsheet from "./ShortcutCheatsheet.svelte";
  import ProgressDialog from "./ProgressDialog.svelte";
  import ToastOverlay from "./ToastOverlay.svelte";

  let { pickerInfo = null, onFilesChanged }: {
    pickerInfo?: PickerInfo | null;
    onFilesChanged: () => void;
  } = $props();

  const notifyError = (message: string) => { toastStore.error(message); };
  const dialogCrash = (label: string, rollback?: () => void) =>
    createDialogCrashHandler(label, rollback, notifyError);

  // Each dialog tracks its own demand. Constructors stay mounted after loading
  // to retain local state and close transitions; imports stay out of startup.
  const ThemePicker = useLazyDialog({
    label: "Theme Picker", isOpen: () => !pickerInfo && dialogStore.isThemePickerOpen,
    load: () => import("$lib/components/ThemePicker.svelte"),
    onFailure: () => dialogStore.closeThemePicker(),
  }, notifyError);
  const SettingsDialog = useLazyDialog({
    label: "Settings", isOpen: () => !pickerInfo && dialogStore.isSettingsOpen,
    load: () => import("$lib/components/SettingsDialog.svelte"),
    onFailure: () => dialogStore.closeSettings(),
  }, notifyError);
  const WorkspaceDialog = useLazyDialog({
    label: "Workspaces", isOpen: () => !pickerInfo && dialogStore.isWorkspaceOpen,
    load: () => import("$lib/components/WorkspaceDialog.svelte"),
    onFailure: () => dialogStore.closeWorkspace(),
  }, notifyError);
  const BulkRenameDialog = useLazyDialog({
    label: "Bulk Rename", isOpen: () => !pickerInfo && dialogStore.isBulkRenameOpen,
    load: () => import("$lib/components/BulkRenameDialog.svelte"),
    onFailure: () => dialogStore.closeBulkRename(),
  }, notifyError);
  const QuickOpen = useLazyDialog({
    label: "Quick Open", isOpen: () => !pickerInfo && dialogStore.isQuickOpenOpen,
    load: () => import("$lib/components/QuickOpen.svelte"),
    onFailure: () => dialogStore.closeQuickOpen(),
  }, notifyError);
  const CommandPalette = useLazyDialog({
    label: "Command Palette", isOpen: () => !pickerInfo && dialogStore.isCommandPaletteOpen,
    load: () => import("$lib/components/CommandPalette.svelte"),
    onFailure: () => dialogStore.closeCommandPalette(),
  }, notifyError);
  const ContentSearchDialog = useLazyDialog({
    label: "Content Search", isOpen: () => !pickerInfo && dialogStore.isContentSearchOpen,
    load: () => import("$lib/components/ContentSearchDialog.svelte"),
    onFailure: () => dialogStore.closeContentSearch(),
  }, notifyError);
  const FilePicker = useLazyDialog({
    label: "File Picker", isOpen: () => pickerInfo !== null,
    load: () => import("$lib/components/FilePicker.svelte"),
  }, notifyError);
  const ConflictDialog = useLazyDialog({
    label: "Conflict dialog", isOpen: () => !pickerInfo && conflictResolver.isActive,
    load: () => import("$lib/components/ConflictDialog.svelte"),
    onFailure: () => conflictResolver.resolve("cancel", true),
  }, notifyError);
  const JobsPanel = useLazyDialog({
    label: "Jobs Panel", isOpen: () => !pickerInfo && dialogStore.isJobsPanelOpen,
    load: () => import("$lib/components/JobsPanel.svelte"),
    onFailure: () => dialogStore.closeJobsPanel(),
  }, notifyError);
  const OptionPicker = useLazyDialog({
    label: "Option Picker", isOpen: () => !pickerInfo && dialogStore.isPickerOpen,
    load: () => import("$lib/components/OptionPicker.svelte"),
    onFailure: () => dialogStore.closePicker(),
  }, notifyError);
  const UserReportDialog = useLazyDialog({
    label: "Report dialog", isOpen: () => !pickerInfo && dialogStore.isUserReportOpen,
    load: () => import("$lib/components/UserReportDialog.svelte"),
    onFailure: () => dialogStore.closeUserReport(),
  }, notifyError);
</script>

{#if pickerInfo}
  {#if FilePicker.component}
    <svelte:boundary onerror={dialogCrash("File Picker")}>
      <FilePicker.component info={pickerInfo} />
    </svelte:boundary>
  {/if}
{:else}
<ShortcutCheatsheet open={dialogStore.isShortcutsOpen} onClose={() => dialogStore.closeShortcuts()} />
{#if QuickOpen.component}
  <svelte:boundary onerror={dialogCrash("Quick Open", () => dialogStore.closeQuickOpen())}>
    <QuickOpen.component open={dialogStore.isQuickOpenOpen} onClose={() => dialogStore.closeQuickOpen()} />
  </svelte:boundary>
{/if}
{#if CommandPalette.component}
  <svelte:boundary onerror={dialogCrash("Command Palette", () => dialogStore.closeCommandPalette())}>
    <CommandPalette.component open={dialogStore.isCommandPaletteOpen} onClose={() => dialogStore.closeCommandPalette()} />
  </svelte:boundary>
{/if}
{#if ThemePicker.component}
  <svelte:boundary onerror={dialogCrash("Theme Picker", () => dialogStore.closeThemePicker())}>
    <ThemePicker.component open={dialogStore.isThemePickerOpen} onClose={() => dialogStore.closeThemePicker()} />
  </svelte:boundary>
{/if}
{#if OptionPicker.component}
  <svelte:boundary onerror={dialogCrash("Option Picker", () => dialogStore.closePicker())}>
    <OptionPicker.component />
  </svelte:boundary>
{/if}
{#if UserReportDialog.component}
  <svelte:boundary onerror={dialogCrash("Report dialog", () => dialogStore.closeUserReport())}>
    <UserReportDialog.component
      open={dialogStore.isUserReportOpen}
      onClose={() => dialogStore.closeUserReport()}
    />
  </svelte:boundary>
{/if}
{#if ContentSearchDialog.component}
  <svelte:boundary onerror={dialogCrash("Content Search", () => dialogStore.closeContentSearch())}>
    <ContentSearchDialog.component open={dialogStore.isContentSearchOpen} onClose={() => dialogStore.closeContentSearch()} />
  </svelte:boundary>
{/if}
{#if SettingsDialog.component}
  <svelte:boundary onerror={dialogCrash("Settings", () => dialogStore.closeSettings())}>
    <SettingsDialog.component open={dialogStore.isSettingsOpen} onClose={() => dialogStore.closeSettings()} />
  </svelte:boundary>
{/if}
{#if WorkspaceDialog.component}
  <svelte:boundary onerror={dialogCrash("Workspaces", () => dialogStore.closeWorkspace())}>
    <WorkspaceDialog.component open={dialogStore.isWorkspaceOpen} onClose={() => dialogStore.closeWorkspace()} />
  </svelte:boundary>
{/if}
{#if BulkRenameDialog.component}
  <svelte:boundary onerror={dialogCrash("Bulk Rename", () => dialogStore.closeBulkRename())}>
    <BulkRenameDialog.component
      open={dialogStore.isBulkRenameOpen}
      entries={dialogStore.bulkRenameEntries}
      onClose={() => dialogStore.closeBulkRename()}
      onComplete={onFilesChanged}
    />
  </svelte:boundary>
{/if}
{#each dialogRegistry.openDialogs as d (d.id)}
  {@const DialogComponent = d.component}
  <svelte:boundary onerror={dialogCrash(d.id, () => dialogRegistry.close(d.id))}>
    <DialogComponent open={true} {...d.props} onClose={() => dialogRegistry.close(d.id)} />
  </svelte:boundary>
{/each}
{#if JobsPanel.component}
  <svelte:boundary onerror={dialogCrash("Jobs Panel", () => dialogStore.closeJobsPanel())}>
    <JobsPanel.component
      open={dialogStore.isJobsPanelOpen}
      onClose={() => dialogStore.closeJobsPanel()}
    />
  </svelte:boundary>
{/if}
<ProgressDialog />
{#if ConflictDialog.component}
  <svelte:boundary onerror={dialogCrash("Conflict dialog", () => conflictResolver.resolve("cancel", true))}>
    <ConflictDialog.component />
  </svelte:boundary>
{/if}
{/if}

<!-- One window-level feedback surface, including failed portal imports. -->
<ToastOverlay />

<!--
  NavigationBar component - Pane-specific navigation + breadcrumbs
  Contains back/forward/up/refresh buttons and breadcrumbs for each pane.
  Issue: tauri-u00y, tauri-nxfi
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { tick, onMount } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import { getDropSourcePaths, handleFileDropMany } from "$lib/state/drop-operations";
  import { truncateBreadcrumbs } from "$lib/domain/breadcrumb-truncation";
  import { isWslDistroRoot, isWslHome } from "$lib/domain/wsl";
  import { directoryKey, isDriveRoot } from "$lib/domain/path";
  import { drivesStore } from "$lib/state/drives.svelte";
  import BreadcrumbAutocomplete from "./BreadcrumbAutocomplete.svelte";
  import CaretPicker from "./CaretPicker.svelte";
  import NavigationHistoryMenu from "./NavigationHistoryMenu.svelte";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  // Home directory detection for breadcrumb collapsing
  let homeDir = $state<string | null>(null);

  onMount(async () => {
    const result = await getHomeDirectory();
    if (result.ok) homeDir = result.data;
  });

  const homeParts = $derived(homeDir ? homeDir.split(/[/\\]/).filter(Boolean) : []);

  // On Windows the filesystem root is a drive letter (e.g. "C:\"), not "/".
  // Fall back to the first breadcrumb when it looks like a drive root so the
  // "Root" button and caret picker don't try to navigate to a POSIX "/".
  const rootPath = $derived.by(() => {
    const first = explorer.breadcrumbs[0]?.path;
    return first && /^[a-zA-Z]:[\\/]?$/.test(first) ? first : "/";
  });

  const isUnderHome = $derived.by(() => {
    const crumbs = explorer.breadcrumbs;
    if (!homeDir || crumbs.length === 0) return false;
    return crumbs.length >= homeParts.length &&
      crumbs[homeParts.length - 1]?.path === homeDir;
  });

  // The breadcrumb's leading icon. A WSL distro root (\\wsl.localhost\Distro)
  // collapses into a Tux icon, and a user's home inside it (…\home\<user>)
  // collapses into the home-with-Tux icon — mirroring how the normal home icon
  // replaces the home path prefix. `slice` is how many leading crumbs the icon
  // stands in for.
  const wslHomeIndex = $derived(explorer.breadcrumbs.findIndex((c) => isWslHome(c.path)));
  const wslDistroRoot = $derived(
    explorer.breadcrumbs[0] && isWslDistroRoot(explorer.breadcrumbs[0].path)
      ? explorer.breadcrumbs[0].path
      : null
  );

  // The breadcrumb crumb (if any) that exactly maps to a known removable or
  // Google Drive mount, so that mount collapses into a dedicated anchor icon
  // (USB-with-letter / Google mark) instead of a bare folder + drive-letter
  // crumb. On Windows the mount is the drive-letter root (index 0); on
  // Linux/macOS it's a deeper crumb (e.g. /media/<user>/GoogleDrive). Null when
  // no crumb is a recognised drive (or the drives list isn't populated, e.g.
  // sidebar hidden) — the anchor then falls back to home/root as before.
  const driveAnchor = $derived.by(() => {
    const crumbs = explorer.breadcrumbs;
    for (let i = 0; i < crumbs.length; i++) {
      const key = directoryKey(crumbs[i].path);
      const drive = drivesStore.list.find((d) => directoryKey(d.path) === key);
      if (!drive) continue;
      if (drive.provider === "googledrive") {
        // Google Drive File Stream always nests personal files under a top-level
        // "My Drive" folder, so fold that crumb into the Google anchor too — the
        // path reads "<G> › subfolder" instead of "<G> › My Drive › subfolder".
        const end = crumbs[i + 1]?.name === "My Drive" ? i + 1 : i;
        return { kind: "googledrive" as const, index: i, end, drive };
      }
      if (drive.kind === "removable" || drive.kind === "unknown")
        return { kind: "removable" as const, index: i, end: i, drive };
    }
    return null;
  });
  // The bare drive letter (e.g. "E") shown inside the USB anchor icon. Taken
  // from the drive-letter root path (Windows) or, failing that, the drive's
  // dimmed detail label (e.g. "E:"). Empty when the mount has no letter.
  const driveAnchorLetter = $derived.by(() => {
    if (!driveAnchor) return "";
    const fromPath = explorer.breadcrumbs[driveAnchor.index]?.path.match(/^([a-zA-Z]):/)?.[1];
    const fromDetail = driveAnchor.drive.detail?.match(/^([a-zA-Z]):?$/)?.[1];
    return (fromPath ?? fromDetail ?? "").toUpperCase();
  });

  type AnchorKind = "home" | "wsl-home" | "wsl-root" | "googledrive" | "removable" | "root";
  const anchor = $derived.by<{ kind: AnchorKind; path: string; slice: number }>(() => {
    if (wslHomeIndex >= 0)
      return { kind: "wsl-home", path: explorer.breadcrumbs[wslHomeIndex].path, slice: wslHomeIndex + 1 };
    if (wslDistroRoot) return { kind: "wsl-root", path: wslDistroRoot, slice: 1 };
    // Drive-mount anchors absorb the crumbs up to and including the mount so the
    // path reads "<drive icon> › subfolder" rather than "<folder> › E › subfolder".
    if (driveAnchor) {
      const { path } = explorer.breadcrumbs[driveAnchor.end];
      return { kind: driveAnchor.kind, path, slice: driveAnchor.end + 1 };
    }
    if (isUnderHome && homeDir) return { kind: "home", path: homeDir, slice: homeParts.length };
    return { kind: "root", path: rootPath, slice: 0 };
  });

  const visibleBreadcrumbs = $derived(explorer.breadcrumbs.slice(anchor.slice));

  // Measurement-based breadcrumb truncation using pretext for text width calculation
  let breadcrumbsEl: HTMLElement | undefined = $state();
  let containerWidth = $state(0);

  $effect(() => {
    if (!breadcrumbsEl) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidth = entry.contentRect.width;
      }
    });
    ro.observe(breadcrumbsEl);
    return () => ro.disconnect();
  });

  const displayBreadcrumbs = $derived(truncateBreadcrumbs(visibleBreadcrumbs, containerWidth));

  // Path editing toggle
  let editingPath = $state(false);

  function startPathEdit() {
    editingPath = true;
  }

  function cancelPathEdit() {
    editingPath = false;
  }

  function handleNavigate(path: string) {
    editingPath = false;
    explorer.navigateTo(path);
  }

  /** Resolve the directory the caret before crumb `index` should list.
   * When the preceding crumb is the truncation ellipsis (path === null) the
   * real parent is hidden, so derive it from the crumb's own path — breadcrumb
   * paths are accumulated prefixes (Windows separators tolerated). */
  function resolveCaretParent(index: number): { path: string; name: string | null } {
    const fallback = { path: anchor.path, name: null };
    const prev = displayBreadcrumbs[index - 1];
    if (!prev) return fallback;
    if (prev.path !== null) return { path: prev.path, name: prev.name };
    const own = displayBreadcrumbs[index].path!;
    const sepIdx = Math.max(own.lastIndexOf("/"), own.lastIndexOf("\\"));
    if (sepIdx <= 0) return fallback;
    const parent = own.substring(0, sepIdx);
    return { path: isDriveRoot(parent) ? `${parent}\\` : parent, name: null };
  }

  // Caret picker state
  let caretPickerPath = $state<string | null>(null);
  let caretPickerEl = $state<HTMLElement | null>(null);

  function openCaretPicker(parentPath: string, el: HTMLElement) {
    if (caretPickerPath === parentPath) {
      closeCaretPicker();
      return;
    }
    caretPickerPath = parentPath;
    caretPickerEl = el;
  }

  function closeCaretPicker() {
    caretPickerPath = null;
    caretPickerEl = null;
  }

  function navigateFromCaret(path: string) {
    closeCaretPicker();
    // Breadcrumb-area navigation: don't auto-descend single subfolders.
    explorer.navigateTo(path, { autoEnterSingleSubdir: false });
  }

  // Filter input
  let filterInputRef = $state<HTMLInputElement | null>(null);
  let localFilter = $state("");

  $effect(() => {
    if (explorer.showFilter && filterInputRef) {
      localFilter = explorer.filterQuery;
      tick().then(() => filterInputRef?.focus());
    }
  });

  function handleFilterInput() {
    explorer.setFilter(localFilter);
  }

  function handleFilterKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      localFilter = "";
      explorer.closeFilter();
    }
  }

  // Navigation history popup (right-click on back/forward)
  let historyMenuAnchor = $state<HTMLElement | null>(null);

  function openHistoryMenu(event: MouseEvent): void {
    event.preventDefault();
    if (explorer.history.length === 0) return;
    historyMenuAnchor = event.currentTarget as HTMLElement;
  }

  function closeHistoryMenu(): void {
    historyMenuAnchor = null;
  }

  // Breadcrumb drop target state
  let dropTargetCrumb = $state<string | null>(null);

  function handleCrumbDragOver(event: DragEvent, path: string): void {
    if (!event.dataTransfer?.types.includes("application/x-explorer-path")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dropTargetCrumb = path;
  }

  function handleCrumbDragLeave(): void {
    dropTargetCrumb = null;
  }

  async function handleCrumbDrop(event: DragEvent, targetPath: string): Promise<void> {
    event.preventDefault();
    dropTargetCrumb = null;
    if (!event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer).filter(
      (sourcePath) => sourcePath !== targetPath && !targetPath.startsWith(sourcePath + "/"),
    );
    await handleFileDropMany(sourcePaths, targetPath, false, {
      onRefresh: () => windowTabsManager.refreshAllPanes(),
    });
  }

</script>

{#if settingsStore.showAddressBar || explorer.showFilter}
<div class="navigation-bar" class:address-bar-hidden={!settingsStore.showAddressBar}>
  {#if settingsStore.showAddressBar}
  <!-- Navigation controls next to address bar -->
  <div class="nav-controls">
    {#if settingsStore.navBarButtons.back}
      <!-- Not the `disabled` attribute: disabled buttons swallow contextmenu,
           which would block the right-click history popup at the start of the
           history. goBack() already no-ops when there's nowhere to go back to. -->
      <button
        class="nav-btn"
        class:disabled={!explorer.canGoBack}
        title="Back (Alt+Left) — right-click for history"
        aria-disabled={!explorer.canGoBack}
        onclick={() => explorer.goBack()}
        oncontextmenu={openHistoryMenu}
        aria-label="Go back"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M10 13L5 8L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.forward}
      <button
        class="nav-btn"
        class:disabled={!explorer.canGoForward}
        title="Forward (Alt+Right) — right-click for history"
        aria-disabled={!explorer.canGoForward}
        onclick={() => explorer.goForward()}
        oncontextmenu={openHistoryMenu}
        aria-label="Go forward"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.up}
      <button
        class="nav-btn"
        onclick={() => explorer.goUp()}
        title="Up (Alt+Up)"
        aria-label="Go up one level"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 13V4M8 4L4 8M8 4L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}

    {#if settingsStore.navBarButtons.refresh}
      <button
        class="nav-btn"
        onclick={() => explorer.refresh()}
        title="Refresh (F5)"
        aria-label="Refresh"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M13.5 8C13.5 10.7614 11.2614 13 8.5 13C5.73858 13 3.5 10.7614 3.5 8C3.5 5.23858 5.73858 3 8.5 3C10.5 3 12.2 4.2 13 5.8M13 3V5.8M13 5.8H10.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    {/if}
  </div>
  {/if}

  {#if historyMenuAnchor}
    <NavigationHistoryMenu {explorer} anchorEl={historyMenuAnchor} onClose={closeHistoryMenu} />
  {/if}

  {#if settingsStore.showAddressBar}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="breadcrumbs-container" class:editing={editingPath} onclick={editingPath ? undefined : startPathEdit} bind:this={breadcrumbsEl}>
    {#if editingPath}
      <BreadcrumbAutocomplete
        currentPath={explorer.currentPath}
        {homeDir}
        onNavigate={handleNavigate}
        onCancel={cancelPathEdit}
      />
    {:else}
      <!-- Breadcrumb view: leading anchor icon (home / root / WSL Tux) -->
      <button
        class="crumb root"
        onclick={(e) => { e.stopPropagation(); explorer.navigateTo(anchor.path, { autoEnterSingleSubdir: false }); }}
        aria-label={anchor.kind === "wsl-home" ? "WSL home folder" : anchor.kind === "wsl-root" ? "WSL distribution root" : anchor.kind === "home" ? "Home folder" : anchor.kind === "googledrive" ? "Google Drive" : anchor.kind === "removable" ? `Removable drive ${driveAnchorLetter}` : "Root"}
      >
        {#if anchor.kind === "home"}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H10V10C10 9.72386 9.77614 9.5 9.5 9.5H6.5C6.22386 9.5 6 9.72386 6 10V14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linejoin="round"
            />
          </svg>
        {:else if anchor.kind === "wsl-root"}
          <!-- Tux: the WSL distro mascot (static/tux.svg) -->
          <img src="/tux.svg" alt="" class="anchor-tux" width="16" height="16" />
        {:else if anchor.kind === "wsl-home"}
          <!-- Home outline with Tux tucked inside -->
          <span class="anchor-wsl-home">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z"
                stroke="currentColor"
                stroke-width="1.1"
                stroke-linejoin="round"
              />
            </svg>
            <img src="/tux.svg" alt="" class="anchor-wsl-home-tux" />
          </span>
        {:else if anchor.kind === "googledrive"}
          <!-- Google "G" multi-colour mark (matches the sidebar Cloud icon). -->
          <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
            <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
            <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/>
            <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
          </svg>
        {:else if anchor.kind === "removable"}
          <!-- Lucide "usb" icon followed by the drive letter (#159). -->
          <span class="anchor-usb">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="10" cy="7" r="1" />
              <circle cx="4" cy="20" r="1" />
              <path d="M4.7 19.3 19 5" />
              <path d="m21 3-3 1 2 2Z" />
              <path d="M9.26 7.68 5 12l2 5" />
              <path d="m10 14 5 2 3.5-3.5" />
              <path d="m18 12 1-1 1 1-1 1Z" />
            </svg>
            <span class="anchor-usb-letter">{driveAnchorLetter}</span>
          </span>
        {:else}
          <!-- Root folder icon -->
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
          </svg>
        {/if}
      </button>

      {#each displayBreadcrumbs as segment, i (segment.path ?? "ellipsis")}
        {#if segment.path === null}
          <span class="separator">
            <svg class="chevron-icon" width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M3 2L6 5L3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="crumb ellipsis">{segment.name}</span>
        {:else}
          {@const caretParent = resolveCaretParent(i)}
          <button
            class="separator caret-btn"
            class:caret-active={caretPickerPath === caretParent.path}
            aria-label="Show folders in {caretParent.name ?? 'parent'}"
            onclick={(e) => { e.stopPropagation(); openCaretPicker(caretParent.path, e.currentTarget as HTMLElement); }}
          >
            <svg class="chevron-icon" width="12" height="12" viewBox="0 0 10 10" fill="none">
              <path d="M3 2L6 5L3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button
            class="crumb"
            class:current={i === displayBreadcrumbs.length - 1}
            class:drop-target={dropTargetCrumb === segment.path}
            data-path={segment.path}
            onclick={(e) => { e.stopPropagation(); explorer.navigateTo(segment.path!, { autoEnterSingleSubdir: false }); }}
            ondragover={(e) => handleCrumbDragOver(e, segment.path!)}
            ondragleave={handleCrumbDragLeave}
            ondrop={(e) => handleCrumbDrop(e, segment.path!)}
          >
            {segment.name}
          </button>
        {/if}
      {/each}

      {#if caretPickerPath && caretPickerEl}
        <CaretPicker
          parentPath={caretPickerPath}
          anchorEl={caretPickerEl}
          onNavigate={navigateFromCaret}
          onClose={closeCaretPicker}
        />
      {/if}

    {/if}
  </div>
  {/if}

  {#if explorer.showFilter}
    <div class="filter-bar">
      <svg class="filter-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <input
        type="text"
        class="filter-input"
        bind:value={localFilter}
        bind:this={filterInputRef}
        oninput={handleFilterInput}
        onkeydown={handleFilterKeydown}
        placeholder="Filter..."
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
        name="filter-nofill"
      />
      {#if localFilter}
        <button class="filter-clear" onclick={() => { localFilter = ""; explorer.closeFilter(); }} aria-label="Clear filter">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .navigation-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--background-card-secondary);
    border-bottom: var(--navbar-border-bottom, 1px solid var(--divider));
    height: 40px;
    container-type: inline-size;
  }

  /* When the address bar is hidden the filter bar is the only child left,
     so anchor it to the right edge to mimic "top-right" instead of
     left-aligning. */
  .navigation-bar.address-bar-hidden {
    justify-content: flex-end;
  }

  .nav-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  /* Hide navigation buttons when address bar space is limited */
  @container (max-width: 400px) {
    .nav-controls {
      display: none;
    }
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .nav-btn:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
    transform: scale(0.96);
  }

  .nav-btn:disabled,
  .nav-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Suppress the normal hover/active feedback on the styled-disabled buttons,
     but keep them able to receive the right-click history popup. */
  .nav-btn.disabled:hover,
  .nav-btn.disabled:active {
    background: transparent;
    transform: none;
  }

  .nav-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .breadcrumbs-container {
    display: flex;
    align-items: center;
    gap: var(--breadcrumb-gap, 0px);
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    background: var(--address-bar-bg, rgba(255, 255, 255, 0.12));
    border: 1px solid var(--address-bar-stroke, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-pill);
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 1px 0 var(--address-bar-highlight, rgba(255, 255, 255, 0.04));
  }

  .breadcrumbs-container.editing {
    overflow: visible;
  }

  .breadcrumbs-container:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .breadcrumbs-container:not(.editing) {
    cursor: text;
  }

  .breadcrumbs-container:not(.editing):hover {
    background: var(--address-bar-bg-hover, rgba(255, 255, 255, 0.16));
    border-color: var(--address-bar-stroke-hover, rgba(255, 255, 255, 0.24));
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: var(--breadcrumb-bg, var(--breadcrumb-segment-bg, transparent));
    border: none;
    border-radius: var(--breadcrumb-radius, var(--radius-sm));
    font-family: inherit;
    font-size: 13px;
    font-weight: var(--font-weight-medium);
    color: var(--breadcrumb-text, var(--text-primary));
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .crumb.root {
    padding: 3px 4px;
    color: var(--text-tertiary);
  }

  /* WSL distro root: Tux mascot (216×256, so `contain` keeps it un-squished). */
  .anchor-tux {
    display: block;
    object-fit: contain;
  }

  /* WSL home: home outline with Tux tucked inside it. */
  .anchor-wsl-home {
    position: relative;
    display: inline-flex;
    width: 16px;
    height: 16px;
    color: var(--text-tertiary);
  }
  .anchor-wsl-home-tux {
    position: absolute;
    width: 9px;
    height: 9px;
    left: 50%;
    bottom: 11%;
    transform: translateX(-50%);
    object-fit: contain;
  }

  /* Removable drive: USB-stick outline (green, matching the sidebar) followed
     by the drive letter — icon and letter sit side by side (#159). */
  .anchor-usb {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: #10b981;
  }
  .anchor-usb svg {
    flex-shrink: 0;
  }
  .anchor-usb-letter {
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: var(--text-secondary);
  }

  .crumb.ellipsis {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  .crumb:hover {
    background: var(--breadcrumb-hover-bg, var(--breadcrumb-segment-bg-hover, var(--subtle-fill-secondary)));
  }

  .crumb:active {
    background: var(--subtle-fill-tertiary);
  }

  .crumb.drop-target {
    background: rgba(0, 120, 212, 0.2);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .crumb.current {
    font-weight: var(--font-weight-semibold);
    color: var(--accent);
    background: var(--breadcrumb-active-bg, var(--breadcrumb-bg, transparent));
  }

  /* Separator / caret button */
  .separator {
    display: flex;
    align-items: center;
    color: var(--breadcrumb-separator-color, var(--text-tertiary));
    flex-shrink: 0;
  }

  .caret-btn {
    padding: 4px 2px;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .caret-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .caret-btn.caret-active {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  /* Default: show chevron, hide powerline */
  .separator .chevron-icon {
    display: var(--breadcrumb-chevron-display, flex);
  }

  .separator .powerline-icon {
    display: var(--breadcrumb-powerline-display, none);
    height: 20px;
    width: 8px;
  }

  /* Filter bar — styled to match the address bar (.breadcrumbs-container).
     Fixed width so it does not grow when the clear button appears on type. */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    box-sizing: border-box;
    width: 220px;
    height: 30px;
    padding: 0 10px;
    background: var(--address-bar-bg, rgba(255, 255, 255, 0.12));
    border: 1px solid var(--address-bar-stroke, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-pill);
    box-shadow: inset 0 1px 0 var(--address-bar-highlight, rgba(255, 255, 255, 0.04));
    animation: filterIn 150ms cubic-bezier(0, 0, 0, 1);
  }

  .filter-bar:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  @keyframes filterIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .filter-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .filter-input {
    flex: 1;
    min-width: 0;
    padding: 2px 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
  }

  .filter-input::placeholder {
    color: var(--text-tertiary);
  }

  .filter-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .filter-clear:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  /* Vibrancy: transparent inside island */
  :global([data-vibrancy]) .navigation-bar {
    background: transparent;
    border-bottom-color: var(--vibrancy-island-stroke);
  }
</style>

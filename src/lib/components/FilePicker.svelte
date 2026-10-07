<!--
  FilePicker - lightweight system file-picker window (portal mode).

  Rendered instead of the full app when the URL carries ?picker=...
  (window spawned by the xdg-desktop-portal FileChooser backend in
  src-tauri/src/portal.rs). Just an address bar + miller columns +
  Select/Cancel — no tabs, sidebar, watchers or heavy state.
-->
<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { flushSharedHistory } from "$lib/state/shared-history";
  import { toastStore } from "$lib/state/toast.svelte";
  import { fetchDirectory, verifyPathsExist } from "$lib/api/files";
  import { getHomeDirectory } from "$lib/api/environment";
  import { pickerRespond } from "$lib/api/system";
  import type { FileEntry } from "$lib/domain/file";
  import FileIcon from "./FileIcon.svelte";
  import PickerQuickOpen from "./PickerQuickOpen.svelte";
  import { basename, joinPath, parentDir } from "$lib/domain/path";
  import { parseBreadcrumbs } from "$lib/state/navigation";
  import type { SearchResult } from "$lib/api/search";
  import { useTypeAhead } from "$lib/composables/use-type-ahead.svelte";
  import { recentFilesStore } from "$lib/state/recent-files.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { matchesPickerExtensions } from "$lib/domain/file-picker";

  export interface PickerInfo {
    mode: "open" | "save";
    token: string;
    multiple: boolean;
    directory: boolean;
    folder: string | null;
    name: string;
    title: string;
    extensions?: readonly string[];
  }

  interface Props {
    info: PickerInfo;
  }

  let { info }: Props = $props();

  /** Directory chain rendered as miller columns: chain[0] is the shallowest. */
  let chain = $state.raw<string[]>([]);
  let entriesByPath = $state<Record<string, FileEntry[]>>({});
  let selectedFiles = $state<Set<string>>(new Set());
  // info comes from the window URL and never changes — initial capture is fine.
  // svelte-ignore state_referenced_locally
  let saveName = $state(info.name);
  let addressInput = $state("");
  let columnsRef = $state<HTMLElement | null>(null);
  let quickOpenOpen = $state(false);
  let intentRevision = 0;
  /** Root the quick-open searches under: the picker's starting folder. */
  let searchRoot = $state("/");

  let activeColumn = $state("");
  let cursorPath = $state("");
  let filterOpen = $state(false);
  let filterQuery = $state("");
  let filterRef = $state<HTMLInputElement | null>(null);
  const activeEntries = $derived(visibleEntries(activeColumn));

  function visibleEntries(path: string): FileEntry[] {
    const entries = entriesByPath[path] ?? [];
    const query = filterQuery.trim().toLowerCase();
    return path === activeColumn && query
      ? entries.filter(entry => entry.name.toLowerCase().includes(query))
      : entries;
  }

  function activateColumn(path: string): void {
    if (path === activeColumn) return;
    activeColumn = path;
    cursorPath = "";
    filterQuery = "";
    typeAhead.reset();
  }

  async function selectCursor(entry: FileEntry): Promise<void> {
    intentRevision++;
    const column = activeColumn;
    cursorPath = entry.path;
    if (entry.kind !== "directory") {
      if (info.mode === "save") saveName = entry.name;
      else selectedFiles = new Set([entry.path]);
    } else selectedFiles = new Set();
    await tick();
    if (column !== activeColumn || cursorPath !== entry.path || quickOpenOpen) return;
    const row = columnsRef?.querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(entry.path)}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  const typeAhead = useTypeAhead(() => activeEntries, entry => { void selectCursor(entry); });
  onDestroy(() => { intentRevision++; typeAhead.reset(); });

  const currentDir = $derived(chain[chain.length - 1] ?? "/");

  const heading = $derived(
    info.title ||
      (info.directory ? "Select Folder" : info.mode === "save" ? "Save File" : "Select File"),
  );

  const canConfirm = $derived(
    info.directory
      ? chain.length > 0
      : info.mode === "save"
        ? saveName.trim().length > 0 && matchesPickerExtensions({ name: saveName.trim(), kind: "file" }, info.extensions)
        : selectedFiles.size > 0,
  );

  function ancestors(path: string): string[] {
    const paths = parseBreadcrumbs(path).map((breadcrumb) => breadcrumb.path);
    const first = paths[0] ?? "";
    const windowsAbsolute = /^[a-zA-Z]:\\$/.test(first) || first.startsWith("\\\\");
    if (windowsAbsolute) return paths;
    if (path.startsWith("/")) return ["/", ...paths];
    return [];
  }

  async function loadDir(path: string): Promise<void> {
    if (entriesByPath[path]) return;
    const result = await fetchDirectory(path);
    if (!result.ok) {
      entriesByPath = { ...entriesByPath, [path]: [] };
      return;
    }
    const visible = result.data.entries
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => !info.directory || e.kind === "directory")
      .filter((e) => matchesPickerExtensions(e, info.extensions))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    entriesByPath = { ...entriesByPath, [path]: visible };
  }

  async function setChain(dirs: string[]): Promise<void> {
    intentRevision++;
    chain = dirs;
    activeColumn = dirs.at(-1) ?? "/";
    cursorPath = "";
    filterQuery = "";
    typeAhead.reset();
    addressInput = dirs[dirs.length - 1] ?? "/";
    selectedFiles = new Set();
    await Promise.all(dirs.map(loadDir));
    // Newest column should be visible.
    requestAnimationFrame(() => {
      if (chain !== dirs) return;
      columnsRef?.scrollTo({ left: columnsRef.scrollWidth, behavior: "smooth" });
    });
  }

  function handleEntryClick(columnIndex: number, entry: FileEntry): void {
    intentRevision++;
    activateColumn(chain[columnIndex]);
    cursorPath = entry.path;
    typeAhead.reset();
    if (entry.kind === "directory") {
      void setChain([...chain.slice(0, columnIndex + 1), entry.path]);
      return;
    }
    if (info.mode === "save") {
      saveName = entry.name;
      return;
    }
    if (info.directory) return;
    selectedFiles = new Set([entry.path]);
  }

  function handleEntryCtrlClick(columnIndex: number, entry: FileEntry, event: MouseEvent): void {
    intentRevision++;
    if (info.multiple && entry.kind !== "directory" && (event.ctrlKey || event.metaKey)) {
      const next = new Set(selectedFiles);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
      }
      selectedFiles = next;
      return;
    }
    handleEntryClick(columnIndex, entry);
  }

  function handleEntryDblClick(entry: FileEntry): void {
    if (entry.kind !== "directory" && info.mode === "open" && !info.directory) {
      void respond([entry.path]);
    }
  }

  function navigateAddress(): void {
    const trimmed = addressInput.trim();
    const dirs = ancestors(trimmed);
    if (dirs.length === 0) return;
    void setChain(dirs);
  }

  async function respond(paths: string[]): Promise<void> {
    const revision = ++intentRevision;
    if (!info.directory && paths.some((path) => !matchesPickerExtensions({ name: basename(path), kind: "file" }, info.extensions))) return;
    if (info.mode === "open") {
      const validation = await verifyPathsExist(paths, info.directory ? "directory" : "file");
      if (revision !== intentRevision) return;
      if (!validation.ok || !validation.data) {
        toastStore.error(validation.ok ? "The selected file or folder no longer exists or has changed type." : "Could not verify the selected file or folder.");
        return;
      }
    }
    // Persist before the terminal IPC reply: the native backend closes this window.
    for (const path of paths) {
      recentFilesStore.add(path, basename(path), info.directory ? "directory" : "file");
      if (info.directory) frecencyStore.recordAccess(path);
      else frecencyStore.recordFileAction(path);
    }
    await flushSharedHistory();
    if (revision !== intentRevision) return;
    await pickerRespond(info.token, paths, false);
  }

  async function confirm(): Promise<void> {
    if (!canConfirm) return;
    if (info.directory) {
      await respond([currentDir]);
    } else if (info.mode === "save") {
      await respond([joinPath(currentDir, saveName.trim())]);
    } else {
      await respond([...selectedFiles]);
    }
  }

  async function cancel(): Promise<void> {
    intentRevision++;
    await pickerRespond(info.token, [], true);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || quickOpenOpen) return;
    const target = event.target as HTMLElement;
    const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (modifier && event.key.toLowerCase() === "p") {
      intentRevision++;
      event.preventDefault();
      typeAhead.reset();
      quickOpenOpen = true;
      return;
    }
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      filterOpen = true;
      typeAhead.reset();
      void tick().then(() => { filterRef?.focus(); filterRef?.select(); });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (filterOpen) {
        filterOpen = false;
        filterQuery = "";
        columnsRef?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activeColumn)}"]`)?.focus();
      } else void cancel();
      return;
    }
    if (target?.closest("input, textarea, select, [contenteditable=true]")) {
      if (event.key === "Enter" && target.matches(".name-input") && canConfirm) { event.preventDefault(); void confirm(); }
      if (event.key === "Enter" && target === filterRef) {
        event.preventDefault();
        if (activeEntries[0]) void selectCursor(activeEntries[0]);
      }
      return;
    }
    // Footer buttons retain their native Enter/Space activation.
    if (target?.closest(".actions")) return;
    if (typeAhead.handleKeydown(event)) { event.preventDefault(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      typeAhead.reset();
      const index = activeEntries.findIndex(entry => entry.path === cursorPath);
      const next = index < 0 ? 0 : Math.max(0, Math.min(activeEntries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (activeEntries[next]) void selectCursor(activeEntries[next]);
    } else if (event.key === "Enter" || event.key === "ArrowRight") {
      const entry = activeEntries.find(entry => entry.path === cursorPath);
      if (entry?.kind === "directory") {
        event.preventDefault();
        const index = chain.indexOf(activeColumn);
        void setChain([...chain.slice(0, index + 1), entry.path]).then(async () => {
          await tick();
          if (activeColumn !== entry.path || cursorPath !== "" || quickOpenOpen) return;
          columnsRef?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activeColumn)}"]`)?.focus();
        });
      } else if (event.key === "Enter" && canConfirm) {
        event.preventDefault();
        void confirm();
      }
    }
  }

  /** Quick-open pick: files confirm (open) or prefill (save); dirs navigate. */
  async function handleQuickOpenPick(result: SearchResult): Promise<void> {
    const revision = ++intentRevision;
    if (result.kind === "directory") {
      const validation = await verifyPathsExist([result.path], "directory");
      if (revision !== intentRevision) return;
      if (!validation.ok || !validation.data) { toastStore.error(validation.ok ? "This folder no longer exists or has changed type." : "Could not verify this folder."); return; }
      await setChain(ancestors(result.path));
      await tick();
      if (currentDir === result.path && !quickOpenOpen) {
        columnsRef?.querySelector<HTMLElement>(`[data-path="${CSS.escape(result.path)}"]`)?.focus();
      }
      return;
    }
    if (info.mode === "save") {
      await setChain(ancestors(parentDir(result.path)));
      saveName = result.name;
      return;
    }
    await respond([result.path]);
  }

  async function startWindowDrag(event: MouseEvent): Promise<void> {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("input, button")) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch {
      // Browser mode
    }
  }

  // Initial load: requested folder, or home. onMount, NOT $effect — the
  // chain-building reads reactive state (entriesByPath in loadDir), which
  // would make navigation re-trigger the initializer and reset the chain.
  onMount(() => {
    void (async () => {
      let base = info.folder;
      if (!base) {
        const home = await getHomeDirectory();
        base = home.ok ? home.data : "/";
      }
      searchRoot = base;
      await setChain(ancestors(base));
    })();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="picker">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header class="picker-header" onmousedown={startWindowDrag}>
    <span class="picker-title">{heading}</span>
    <input
      class="address-input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      bind:value={addressInput}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          navigateAddress();
        }
      }}
    />
  </header>

  {#if filterOpen}
    <input class="filter-input" aria-label="Filter current folder" placeholder="Filter current folder…" bind:this={filterRef} bind:value={filterQuery} oninput={() => { intentRevision++; cursorPath = ""; selectedFiles = new Set(); typeAhead.reset(); }} />
  {/if}
  <div class="columns" bind:this={columnsRef}>
    {#each chain as dirPath, columnIndex (dirPath)}
      <div class="column" data-path={dirPath} role="listbox" aria-label={dirPath} aria-multiselectable={info.multiple} tabindex="0" onfocusin={() => activateColumn(dirPath)}>
        {#each visibleEntries(dirPath) as entry (entry.path)}
          <button
            type="button"
            role="option"
            aria-selected={cursorPath === entry.path || selectedFiles.has(entry.path)}
            class="entry"
            data-entry-path={entry.path}
            tabindex={cursorPath === entry.path ? 0 : -1}
            class:cursor={cursorPath === entry.path}
            class:on-path={chain.includes(entry.path)}
            class:selected={selectedFiles.has(entry.path)}
            onclick={(e) => handleEntryCtrlClick(columnIndex, entry, e)}
            ondblclick={() => handleEntryDblClick(entry)}
            title={entry.name}
          >
            <span class="entry-icon"><FileIcon {entry} size="small" /></span>
            <span class="entry-label">{entry.name}</span>
            {#if entry.kind === "directory"}
              <span class="chevron">›</span>
            {/if}
          </button>
        {/each}
        {#if visibleEntries(dirPath).length === 0}
          <div class="empty-column">{filterQuery && dirPath === activeColumn ? "No matches" : "Empty"}</div>
        {/if}
      </div>
    {/each}
  </div>

  <footer class="picker-footer">
    {#if info.mode === "save"}
      <input
        class="name-input"
        type="text"
        placeholder="File name"
        spellcheck="false"
        autocomplete="off"
        bind:value={saveName}
      />
    {:else if info.directory}
      <span class="selection-hint">{currentDir}</span>
    {:else}
      <span class="selection-hint">
        {selectedFiles.size > 0
          ? [...selectedFiles].map(basename).join(", ")
          : "No file selected"}
      </span>
    {/if}
    <div class="actions">
      <button class="btn-cancel" onclick={cancel}>Cancel</button>
      <button class="btn-select" onclick={confirm} disabled={!canConfirm}>
        {info.mode === "save" ? "Save" : "Select"}
      </button>
    </div>
  </footer>
</div>

<PickerQuickOpen
  open={quickOpenOpen}
  onClose={() => (quickOpenOpen = false)}
  root={searchRoot}
  directoriesOnly={info.directory}
  extensions={info.extensions}
  onPick={handleQuickOpenPick}
/>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--background-solid, #1e1e1e);
    color: var(--text-primary, #eee);
    font-size: 13px;
    overflow: hidden;
  }

  .picker-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--divider, rgba(128, 128, 128, 0.3));
    user-select: none;
    flex-shrink: 0;
  }

  .picker-title {
    font-weight: 600;
    white-space: nowrap;
  }

  .address-input,
  .name-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--control-fill, rgba(128, 128, 128, 0.1));
    border: 1px solid var(--control-stroke, rgba(128, 128, 128, 0.3));
    border-radius: var(--radius-sm, 4px);
    color: inherit;
    font: inherit;
    outline: none;
  }

  .address-input:focus,
  .name-input:focus {
    border-color: var(--accent, #0078d4);
  }

  .columns {
    flex: 1;
    display: flex;
    overflow-x: auto;
    min-height: 0;
  }

  .column {
    min-width: 220px;
    max-width: 260px;
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--divider, rgba(128, 128, 128, 0.2));
    padding: 4px;
  }

  .filter-input {
    margin: 8px 12px;
    padding: 6px 10px;
    border: 1px solid var(--control-stroke);
    background: var(--control-fill);
    color: var(--text-primary);
    border-radius: var(--radius-sm, 4px);
  }

  .entry {
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: var(--radius-sm, 4px);
    cursor: pointer;
    white-space: nowrap;
  }

  .entry:hover {
    background: var(--subtle-fill-secondary, rgba(128, 128, 128, 0.15));
  }

  .entry.on-path {
    background: var(--subtle-fill-tertiary, rgba(128, 128, 128, 0.25));
  }

  .entry.selected, .entry.cursor {
    background: var(--accent, #0078d4);
    color: var(--text-on-accent, #fff);
  }

  .entry-icon {
    flex-shrink: 0;
    display: inline-flex;
  }

  .entry-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chevron {
    color: var(--text-tertiary, #888);
    flex-shrink: 0;
  }

  .empty-column {
    padding: 12px;
    color: var(--text-tertiary, #888);
    font-style: italic;
  }

  .picker-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-top: 1px solid var(--divider, rgba(128, 128, 128, 0.3));
    flex-shrink: 0;
  }

  .selection-hint {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary, #bbb);
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .actions button {
    padding: 6px 18px;
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--control-stroke, rgba(128, 128, 128, 0.3));
    background: var(--control-fill, rgba(128, 128, 128, 0.1));
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .btn-select {
    background: var(--accent, #0078d4) !important;
    color: var(--text-on-accent, #fff) !important;
    border-color: transparent !important;
  }

  .btn-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

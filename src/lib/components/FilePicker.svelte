<!--
  FilePicker - lightweight system file-picker window (portal mode).

  Rendered instead of the full app when the URL carries ?picker=...
  (window spawned by the xdg-desktop-portal FileChooser backend in
  src-tauri/src/portal.rs). Just an address bar + miller columns +
  Select/Cancel — no tabs, sidebar, watchers or heavy state.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { fetchDirectory, getHomeDirectory, pickerRespond } from "$lib/api/files";
  import type { FileEntry } from "$lib/domain/file";
  import FileIcon from "./FileIcon.svelte";
  import PickerQuickOpen from "./PickerQuickOpen.svelte";
  import { parentDir } from "$lib/domain/path";
  import type { SearchResult } from "$lib/api/files";

  export interface PickerInfo {
    mode: "open" | "save";
    token: string;
    multiple: boolean;
    directory: boolean;
    folder: string | null;
    name: string;
    title: string;
  }

  interface Props {
    info: PickerInfo;
  }

  let { info }: Props = $props();

  /** Directory chain rendered as miller columns: chain[0] is the shallowest. */
  let chain = $state<string[]>([]);
  let entriesByPath = $state<Record<string, FileEntry[]>>({});
  let selectedFiles = $state<Set<string>>(new Set());
  // info comes from the window URL and never changes — initial capture is fine.
  // svelte-ignore state_referenced_locally
  let saveName = $state(info.name);
  let addressInput = $state("");
  let columnsRef = $state<HTMLElement | null>(null);
  let quickOpenOpen = $state(false);
  /** Root the quick-open searches under: the picker's starting folder. */
  let searchRoot = $state("/");

  const currentDir = $derived(chain[chain.length - 1] ?? "/");

  const heading = $derived(
    info.title ||
      (info.directory ? "Select Folder" : info.mode === "save" ? "Save File" : "Select File"),
  );

  const canConfirm = $derived(
    info.directory
      ? chain.length > 0
      : info.mode === "save"
        ? saveName.trim().length > 0
        : selectedFiles.size > 0,
  );

  function ancestors(path: string): string[] {
    const parts = path.split("/").filter(Boolean);
    const result = ["/"];
    let acc = "";
    for (const part of parts) {
      acc += "/" + part;
      result.push(acc);
    }
    return result;
  }

  function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
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
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    entriesByPath = { ...entriesByPath, [path]: visible };
  }

  async function setChain(dirs: string[]): Promise<void> {
    chain = dirs;
    addressInput = dirs[dirs.length - 1] ?? "/";
    selectedFiles = new Set();
    await Promise.all(dirs.map(loadDir));
    // Newest column should be visible.
    requestAnimationFrame(() => {
      columnsRef?.scrollTo({ left: columnsRef.scrollWidth, behavior: "smooth" });
    });
  }

  function handleEntryClick(columnIndex: number, entry: FileEntry): void {
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
    if (!trimmed.startsWith("/")) return;
    void setChain(ancestors(trimmed.replace(/\/+$/, "") || "/"));
  }

  async function respond(paths: string[]): Promise<void> {
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
    await pickerRespond(info.token, [], true);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      quickOpenOpen = true;
      return;
    }
    if (event.key === "Escape") {
      if (quickOpenOpen) return; // the overlay's Modal handles its own Escape
      event.preventDefault();
      void cancel();
    } else if (event.key === "Enter" && !(event.target as HTMLElement)?.closest(".address-input")) {
      if (canConfirm) {
        event.preventDefault();
        void confirm();
      }
    }
  }

  /** Quick-open pick: files confirm (open) or prefill (save); dirs navigate. */
  async function handleQuickOpenPick(result: SearchResult): Promise<void> {
    if (result.kind === "directory") {
      await setChain(ancestors(result.path));
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

  <div class="columns" bind:this={columnsRef}>
    {#each chain as dirPath, columnIndex (dirPath)}
      <div class="column" data-path={dirPath}>
        {#each entriesByPath[dirPath] ?? [] as entry (entry.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="entry"
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
          </div>
        {/each}
        {#if (entriesByPath[dirPath] ?? []).length === 0}
          <div class="empty-column">Empty</div>
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
          ? [...selectedFiles].map((p) => p.split("/").pop()).join(", ")
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

  .entry {
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

  .entry.selected {
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

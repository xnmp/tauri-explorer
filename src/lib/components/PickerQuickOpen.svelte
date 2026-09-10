<!--
  Quick open for the portal file picker (#190).

  A deliberately small cousin of QuickOpen: debounced fuzzy search under the
  picker's current root, arrow-key navigation, Enter to pick. No frecency,
  recent files, tabs or window state — the picker window has none of that.
-->
<script lang="ts">
  import { fuzzySearch, type SearchResult } from "$lib/api/search";
  import FileIcon from "./FileIcon.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Search root — the picker's starting folder (falls back to home). */
    root: string;
    /** Only directories are pickable (folder-select mode). */
    directoriesOnly: boolean;
    onPick: (result: SearchResult) => void;
  }

  let { open, onClose, root, directoriesOnly, onPick }: Props = $props();

  let query = $state("");
  let results = $state<SearchResult[]>([]);
  let activeIndex = $state(0);
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function reset(): void {
    query = "";
    results = [];
    activeIndex = 0;
  }

  function close(): void {
    reset();
    onClose();
  }

  function runSearch(q: string): void {
    const seq = ++searchSeq;
    if (!q.trim()) {
      results = [];
      return;
    }
    void fuzzySearch(q, root, 30).then((r) => {
      if (seq !== searchSeq) return; // stale response
      if (!r.ok) return;
      results = directoriesOnly ? r.data.filter((e) => e.kind === "directory") : r.data;
      activeIndex = 0;
    });
  }

  function handleInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(query), 120);
  }

  function pick(result: SearchResult): void {
    onPick(result);
    close();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, results.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[activeIndex];
      if (chosen) pick(chosen);
    }
  }
</script>

<Modal {open} onClose={close} align="top" label="Quick Open" onkeydown={handleKeydown}>
  <div class="modal-card picker-quick-open" data-testid="picker-quick-open">
    <input
      type="text"
      placeholder={directoriesOnly ? "Search folders…" : "Search files…"}
      bind:value={query}
      oninput={handleInput}
      data-autofocus
    />
    <ul class="pqo-results">
      {#each results as result, i (result.path)}
        <li>
          <button
            class="pqo-result"
            class:active={i === activeIndex}
            onclick={() => pick(result)}
            onmouseenter={() => (activeIndex = i)}
          >
            <FileIcon
              entry={{ name: result.name, path: result.path, kind: result.kind, size: 0, modified: "" }}
              size="small"
            />
            <span class="pqo-name">{result.name}</span>
            <span class="pqo-path">{result.relativePath}</span>
          </button>
        </li>
      {/each}
      {#if query.trim() && results.length === 0}
        <li class="pqo-empty">No matches</li>
      {/if}
    </ul>
  </div>
</Modal>

<style>
  .picker-quick-open {
    width: min(560px, calc(100vw - 48px));
    padding: 8px;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--control-stroke);
    background: var(--control-fill);
    color: var(--text-primary);
    font-size: 14px;
    outline: none;
  }

  .pqo-results {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
  }

  .pqo-result {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary, #222);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .pqo-result.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .pqo-result.active .pqo-path {
    color: inherit;
  }

  .pqo-name {
    flex-shrink: 0;
  }

  .pqo-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary, #888);
    font-size: 12px;
  }

  .pqo-empty {
    padding: 10px;
    color: var(--text-secondary, #888);
    font-size: 13px;
  }
</style>

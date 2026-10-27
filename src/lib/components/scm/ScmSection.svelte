<!--
  ScmSection — one Source Control section (Merge / Staged / Changes /
  Untracked): a collapsible header with its count, then the section's files
  as a flat list or a folder tree (#283), each row with hover actions.
-->
<script lang="ts">
  import type { GitFileEntry } from "$lib/api/git";
  import { basename } from "$lib/domain/path";
  import { buildTree, collectPaths, type ScmTreeNode } from "$lib/domain/scm-tree";
  import { splitScmPath as splitPath, statusClass, statusLetter, type ScmSectionKind } from "$lib/domain/scm-sidebar";
  import type { ScmStore } from "$lib/state/scm.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";

  interface Props {
    id: string;
    label: string;
    count: number;
    expanded: boolean;
    onToggle: () => void;
    rows: GitFileEntry[];
    kind: ScmSectionKind;
    scmStore: ScmStore;
    /** Collapsed tree folders (always empty while a filter is active). */
    collapsedFolders: ReadonlySet<string>;
    filterActive: boolean;
    onToggleFolder: (dir: string) => void;
    onShowFileHistory: (path: string) => void;
    onRequestDiscard: (paths: string[], isUntracked: boolean) => void;
    onArchive: (paths: string[]) => void;
    onTrash: (paths: string[]) => void;
    onIgnore: (path: string) => void;
  }

  const {
    id, label, count, expanded, onToggle, rows, kind, scmStore, collapsedFolders, filterActive,
    onToggleFolder, onShowFileHistory, onRequestDiscard, onArchive, onTrash, onIgnore,
  }: Props = $props();
</script>

<div class="section" data-section={id}>
  <button
    type="button"
    class="section-header"
    onclick={onToggle}
    aria-expanded={expanded}
  >
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={expanded}>
      <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="section-label">{label}</span>
    <span class="count-badge">{count}</span>
  </button>

  {#if expanded}
    {#if settingsStore.scmTreeView}
      {@const tree = buildTree(rows)}
      {@render treeNode(tree, 0, kind)}
    {:else}
    <ul class="row-list" role="listbox" aria-label="{kind} files">
      {#each rows as row (row.path)}
        {@const parts = splitPath(row.path)}
        <li
          class="row"
          class:selected={scmStore.selectedPath === row.path}
          class:active-diff={scmStore.activeDiff?.path === row.path}
          data-path={row.path}
          data-section-kind={kind}
          tabindex="0"
          onclick={() => { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); }}
          onkeydown={(e) => { if (e.key === 'Enter') { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); } }}
          role="option"
          aria-selected={scmStore.selectedPath === row.path}
          title={row.path}
        >
          <span class="file-name">{parts.name}</span>
          {#if parts.dir}
            <span class="file-dir">{parts.dir}</span>
          {/if}
          <span class="row-actions">{@render fileActions(row)}</span>
          <span class="status-letter {statusClass(row.status)}" aria-label={row.status}>
            {statusLetter(row.status)}
          </span>
        </li>
      {/each}
    </ul>
    {/if}
  {/if}
</div>

{#snippet fileActions(row: GitFileEntry)}
  {#if kind !== "untracked"}
    <button type="button" class="row-btn" title="Show history for this file" aria-label="Show history for {row.path}"
      onclick={(e) => { e.stopPropagation(); onShowFileHistory(row.path); }}>{@render actionIcon("history")}</button>
  {/if}
  {#if kind === "staged"}
    <button type="button" class="row-btn" title="Unstage" aria-label="Unstage {row.path}"
      onclick={(e) => { e.stopPropagation(); scmStore.unstage([row.path]); }}>{@render actionIcon("unstage")}</button>
  {:else if kind === "merge"}
    <button type="button" class="row-btn" title="Stage" aria-label="Stage {row.path}"
      onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}>{@render actionIcon("stage")}</button>
  {:else}
    <button type="button" class="row-btn destructive"
      title={kind === "untracked" ? "Remove file" : "Discard changes"}
      aria-label={kind === "untracked" ? `Remove ${row.path}` : `Discard ${row.path}`}
      onclick={(e) => { e.stopPropagation(); onRequestDiscard([row.path], kind === "untracked"); }}>{@render actionIcon("discard")}</button>
    {#if kind === "untracked"}
      <button type="button" class="row-btn" title="Archive to .archive" aria-label="Archive {row.path} to .archive"
        onclick={(e) => { e.stopPropagation(); onArchive([row.path]); }}>{@render actionIcon("archive")}</button>
      <button type="button" class="row-btn" title="Move to Trash" aria-label="Move {row.path} to Trash"
        onclick={(e) => { e.stopPropagation(); onTrash([row.path]); }}>{@render actionIcon("trash")}</button>
      <button type="button" class="row-btn" title="Add to .gitignore" aria-label="Ignore {row.path}"
        onclick={(e) => { e.stopPropagation(); onIgnore(row.path); }}>{@render actionIcon("ignore")}</button>
    {/if}
    <button type="button" class="row-btn" title="Stage" aria-label="Stage {row.path}"
      onclick={(e) => { e.stopPropagation(); scmStore.stage([row.path]); }}>{@render actionIcon("stage")}</button>
  {/if}
{/snippet}

<!-- Row action icons as SVGs: the previous text glyphs (− + ↺ ⊘) rendered at
     inconsistent sizes because their font metrics differ wildly at the same
     font-size — ↺ in particular drew visibly larger than the rest (#270). -->
{#snippet actionIcon(kind: "stage" | "unstage" | "discard" | "ignore" | "archive" | "trash" | "history")}
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if kind === "stage"}
      <path d="M8 3.5v9M3.5 8h9" />
    {:else if kind === "unstage"}
      <path d="M3.5 8h9" />
    {:else if kind === "discard"}
      <path d="M6.5 3.5L3.5 6l3 2.5" />
      <path d="M3.5 6h5a3.25 3.25 0 0 1 0 6.5H6.5" />
    {:else if kind === "archive"}
      <path d="M2.5 5.5h11v7h-11zM4 3.5h8v2H4z" />
      <path d="M6.25 8.5h3.5" />
    {:else if kind === "trash"}
      <path d="M3.5 5h9M6 5V3.5h4V5M5 5l.5 8h5l.5-8M7 7.5v3M9 7.5v3" />
    {:else if kind === "history"}
      <circle cx="8" cy="8" r="5" />
      <path d="M8 5v3l2 1.5" />
    {:else}
      <circle cx="8" cy="8" r="5" />
      <path d="M4.7 4.7l6.6 6.6" />
    {/if}
  </svg>
{/snippet}

{#snippet treeNode(node: ScmTreeNode, depth: number, kind: "staged" | "changes" | "untracked" | "merge")}
  <ul class="row-list tree-list" role={depth === 0 ? "tree" : "group"} style="padding-left: {depth === 0 ? 4 : 0}px">
    {#each Array.from(node.children.values()) as child (child.fullDir)}
      {@const collapsed = collapsedFolders.has(child.fullDir)}
      {@const folderPaths = collectPaths(child)}
      <li
        class="row tree-folder"
        style="padding-left: {depth * 12 + 4}px"
        tabindex="0"
        onclick={() => onToggleFolder(child.fullDir)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleFolder(child.fullDir); } }}
        role="treeitem"
        aria-expanded={!collapsed}
        aria-selected="false"
        aria-disabled={filterActive}
      >
        {#each { length: depth } as _, i}
          <span class="depth-guide" style="left: {i * 12 + 10}px"></span>
        {/each}
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={!collapsed}>
          <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="folder-name">{child.name}</span>
        <span class="row-actions folder-actions">
          {#if kind === "staged"}
            <button type="button" class="row-btn" title="Unstage folder" aria-label="Unstage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.unstage(folderPaths); }}>{@render actionIcon("unstage")}</button>
          {:else if kind === "merge"}
            <button type="button" class="row-btn" title="Stage folder" aria-label="Stage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage(folderPaths); }}>{@render actionIcon("stage")}</button>
          {:else}
            <button type="button" class="row-btn destructive"
              title={kind === "untracked" ? "Remove folder" : "Discard folder changes"}
              aria-label={kind === "untracked" ? `Remove ${child.name}` : `Discard ${child.name}`}
              onclick={(e) => { e.stopPropagation(); onRequestDiscard(folderPaths, kind === "untracked"); }}>{@render actionIcon("discard")}</button>
            {#if kind === "untracked"}
              <button type="button" class="row-btn" title="Archive to .archive" aria-label="Archive {child.name} to .archive"
                onclick={(e) => { e.stopPropagation(); onArchive(folderPaths); }}>{@render actionIcon("archive")}</button>
              <button type="button" class="row-btn" title="Move to Trash" aria-label="Move {child.name} to Trash"
                onclick={(e) => { e.stopPropagation(); onTrash(folderPaths); }}>{@render actionIcon("trash")}</button>
              <button type="button" class="row-btn" title="Add folder to .gitignore" aria-label="Ignore {child.name}"
                onclick={(e) => { e.stopPropagation(); onIgnore(child.fullDir); }}>{@render actionIcon("ignore")}</button>
            {/if}
            <button type="button" class="row-btn" title="Stage folder" aria-label="Stage {child.name}"
              onclick={(e) => { e.stopPropagation(); scmStore.stage(folderPaths); }}>{@render actionIcon("stage")}</button>
          {/if}
        </span>
      </li>
      {#if !collapsed}
        {@render treeNode(child, depth + 1, kind)}
      {/if}
    {/each}
    {#each node.files as row (row.path)}
      {@const fileName = basename(row.path)}
      <li
        class="row tree-file"
        class:selected={scmStore.selectedPath === row.path}
        class:active-diff={scmStore.activeDiff?.path === row.path}
        data-path={row.path}
        data-section-kind={kind}
        style="padding-left: {depth * 12 + 4}px"
        tabindex="0"
        onclick={() => { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); }}
        onkeydown={(e) => { if (e.key === 'Enter') { scmStore.setSelected(row.path); scmStore.openDiff(row.path, kind === 'staged'); settingsStore.openPreviewPane(); } }}
        role="treeitem"
        aria-selected={scmStore.selectedPath === row.path}
        title={row.path}
      >
        {#each { length: depth } as _, i}
          <span class="depth-guide" style="left: {i * 12 + 10}px"></span>
        {/each}
        <span class="file-name">{fileName}</span>
        <span class="row-actions">{@render fileActions(row)}</span>
        <span class="status-letter {statusClass(row.status)}" aria-label={row.status}>
          {statusLetter(row.status)}
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

<style>
  /* Collapsing is disabled while filtering (every folder renders expanded),
     so the row should not advertise a click that does nothing. */
  .row.tree-folder[aria-disabled="true"] {
    cursor: default;
  }

  .tree-list {
    padding: 0 4px;
    gap: 0;
  }

  .row.tree-folder {
    gap: 4px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    height: 22px;
    min-height: 22px;
    position: relative;
  }

  .row.tree-folder .folder-actions {
    opacity: 0;
  }

  .row.tree-folder:hover .folder-actions {
    opacity: 1;
  }

  .folder-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.tree-file {
    position: relative;
  }

  .depth-guide {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--divider);
    pointer-events: none;
  }

  .section {
    display: flex;
    flex-direction: column;
    padding: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: none;
    font-family: inherit;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--letter-spacing-wide);
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background var(--transition-fast);
  }

  .section-header:hover {
    background: var(--subtle-fill-secondary);
  }

  .chevron {
    flex-shrink: 0;
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .section-label {
    flex: 1;
  }

  .count-badge {
    background: var(--subtle-fill-secondary);
    color: var(--text-secondary);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 10px;
    font-weight: var(--font-weight-medium);
    letter-spacing: 0;
    text-transform: none;
  }

  .row-list {
    list-style: none;
    margin: 0;
    padding: 0 4px 4px;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
    font-size: 13px;
    height: 22px;
    min-height: 22px;
    position: relative;
  }

  .row:hover {
    background: var(--subtle-fill-secondary);
  }

  .row.selected {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .row.active-diff {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    font-weight: var(--font-weight-medium);
  }

  .row:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .status-letter {
    flex-shrink: 0;
    width: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: var(--font-weight-bold);
    font-size: 11px;
    text-align: center;
    line-height: 1;
    margin-left: auto;
  }

  /* Status letter colors: themeable via --scm-* vars, mixed with the theme's
     text color so they stay legible on both dark and light backgrounds. */
  .s-modified { color: var(--scm-modified, color-mix(in srgb, #d7ba7d 75%, var(--text-primary) 25%)); }
  .s-added { color: var(--scm-added, color-mix(in srgb, #73c991 75%, var(--text-primary) 25%)); }
  .s-deleted { color: var(--scm-deleted, color-mix(in srgb, #f14c4c 75%, var(--text-primary) 25%)); }
  .s-renamed { color: var(--scm-renamed, color-mix(in srgb, #6cb6ff 75%, var(--text-primary) 25%)); }
  .s-conflict { color: var(--scm-conflict, color-mix(in srgb, #e4676b 75%, var(--text-primary) 25%)); }
  .s-ignored { color: var(--text-tertiary); }
  .s-type { color: var(--scm-typechange, color-mix(in srgb, #eab308 75%, var(--text-primary) 25%)); }

  .file-name {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-dir {
    flex-shrink: 1;
    color: var(--text-tertiary);
    font-size: 90%;
    margin-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    min-width: 0;
  }

  .row-actions {
    display: none;
    gap: 2px;
    position: absolute;
    right: 16px;
    top: 0;
    bottom: 0;
    align-items: center;
    padding: 0 4px 0 16px;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: linear-gradient(to right, transparent 0%, var(--subtle-fill-secondary) 30%);
  }

  .folder-actions {
    right: 0;
  }

  .row:hover .row-actions,
  .row:focus-within .row-actions,
  .row.selected .row-actions {
    display: flex;
  }

  .row:hover .file-dir,
  .row:focus-within .file-dir,
  .row.selected .file-dir {
    display: none;
  }

  .row-btn {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition:
      color var(--transition-fast),
      background-color var(--transition-fast);
  }

  /* A color-only hover read as barely-there (#270): give the hovered button
     a visible pill so it's obvious which action the cursor is on. */
  .row-btn:hover {
    color: var(--text-primary);
    background: var(--control-fill-secondary, rgba(128, 128, 128, 0.22));
  }

  .row-btn:active {
    background: var(--control-fill-tertiary, rgba(128, 128, 128, 0.32));
  }

  .row-btn.destructive:hover {
    color: var(--system-critical-text, var(--system-critical));
    background: color-mix(in srgb, var(--system-critical) 15%, transparent);
  }
</style>

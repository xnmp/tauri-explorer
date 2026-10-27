<!--
  GitGraphColumnMenu — the graph header's right-click menu (#372): column
  visibility, author avatars and Gravatar consent (#514), detail metadata
  (#402), merge muting (#458, #527) and branch tracing. Every toggle is a
  persisted layout preference (state/git-graph-view-prefs).
-->
<script lang="ts">
  import type { GitGraphViewPrefs, GraphColumnId } from "$lib/state/git-graph-view-prefs.svelte";

  interface Props {
    x: number;
    y: number;
    prefs: GitGraphViewPrefs;
    onClose: () => void;
  }

  const { x, y, prefs, onClose }: Props = $props();

  const COLUMN_ITEMS: readonly (readonly [GraphColumnId, string])[] = [
    ["author", "Author"], ["date", "Date"], ["commit", "Commit"], ["parent", "Parent"],
  ];
</script>

<button
  class="menu-backdrop"
  aria-label="Close column menu"
  onclick={onClose}
  oncontextmenu={(e) => { e.preventDefault(); onClose(); }}
></button>
<div
  class="commit-menu"
  data-testid="git-graph-column-menu"
  role="menu"
  tabindex="-1"
  style="left: {x}px; top: {y}px;"
>
  {#each COLUMN_ITEMS as [id, label] (id)}
    <button
      class="menu-item"
      role="menuitemcheckbox"
      aria-checked={prefs.columns[id]}
      onclick={() => prefs.toggleColumn(id)}
    >
      <span class="col-check">{prefs.columns[id] ? "✓" : ""}</span>
      {label}
    </button>
  {/each}
  <div class="menu-sep"></div>
  <button class="menu-item" role="menuitemcheckbox" aria-checked={prefs.avatars.visible}
    onclick={prefs.toggleAvatars} data-testid="toggle-author-avatars">
    <span class="col-check">{prefs.avatars.visible ? "✓" : ""}</span>
    Avatars
  </button>
  <button class="menu-item gravatar-option" role="menuitemcheckbox"
    aria-checked={prefs.avatars.gravatarEnabled} onclick={prefs.toggleGravatar} data-testid="toggle-gravatar">
    <span class="col-check">{prefs.avatars.gravatarEnabled ? "✓" : ""}</span>
    <span><span>Use Gravatar</span><small>Sends hashed author emails, including private repositories, to Gravatar.</small></span>
  </button>
  <div class="menu-sep"></div>
  <!-- Hash/parents/author/date inside the commit detail block (#402):
       hidden by default, toggleable here. -->
  <button
    class="menu-item"
    role="menuitemcheckbox"
    aria-checked={prefs.showDetailMeta}
    onclick={prefs.toggleDetailMeta}
    data-testid="toggle-detail-meta"
  >
    <span class="col-check">{prefs.showDetailMeta ? "✓" : ""}</span>
    Details metadata
  </button>
  <!-- Dim merge-commit rows to cut history noise (#458). -->
  <button
    class="menu-item"
    role="menuitemcheckbox"
    aria-checked={prefs.muteMerges}
    onclick={prefs.toggleMuteMerges}
    data-testid="toggle-mute-merges"
  >
    <span class="col-check">{prefs.muteMerges ? "✓" : ""}</span>
    Mute merge commits
  </button>
  <button
    class="menu-item"
    role="menuitemcheckbox"
    aria-checked={prefs.muteBaseUpdateMerges}
    onclick={prefs.toggleMuteBaseUpdateMerges}
    data-testid="toggle-mute-base-update-merges"
  >
    <span class="col-check">{prefs.muteBaseUpdateMerges ? "✓" : ""}</span>
    Mute base-update merges
  </button>
  <button
    class="menu-item"
    role="menuitemcheckbox"
    aria-checked={prefs.branchTracing}
    onclick={prefs.toggleBranchTracing}
    data-testid="toggle-branch-tracing"
  >
    <span class="col-check">{prefs.branchTracing ? "✓" : ""}</span>
    Trace branches
  </button>
</div>

<style>
  .gravatar-option { align-items: flex-start; }
  .gravatar-option small {
    display: block;
    max-width: 290px;
    margin-top: 2px;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    line-height: 1.3;
    white-space: normal;
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }

  .commit-menu {
    position: fixed;
    z-index: 41;
    min-width: 232px;
    padding: 4px;
    /* --background-card is translucent in every theme — composite it over
       the solid background so the menu is opaque (#263, same as #243). */
    background: linear-gradient(var(--background-card, #1e1e1e), var(--background-card, #1e1e1e)), var(--background-solid, #1e1e1e);
    border: 1px solid var(--divider);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    font-size: var(--font-size-body);
    display: flex;
    flex-direction: column;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 10px;
    background: none;
    border: none;
    border-radius: 5px;
    color: var(--text-primary);
    font-size: var(--font-size-body);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--divider);
  }

  /* Fixed-width tick gutter so column labels stay aligned (#372). */
  .col-check {
    display: inline-block;
    width: 12px;
    color: var(--accent-text, var(--accent));
  }
</style>

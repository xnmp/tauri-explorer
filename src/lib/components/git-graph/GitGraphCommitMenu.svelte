<!--
  GitGraphCommitMenu — the commit context menu (VSCode "Git Graph"-parity
  actions) and the row's "all references" disclosure (#1082). Opened from a
  branch/remote/tag chip it is scoped to that ref (#405, #432). The anchor
  (position, trigger and captured scroller position) and viewport clamp live
  in composables/use-git-graph-menu; actions run through GitGraphActions.
-->
<script lang="ts">
  import type { GraphCommit as CommitInfo } from "$lib/state/git-graph-cache";
  import type { RefChips, RemoteRefChip } from "$lib/domain/git-graph";
  import type { GraphMenu } from "$lib/composables/use-git-graph-menu.svelte";
  import type { PrSnapshot } from "$lib/state/git-pr-session.svelte";
  import type { GitGraphActions } from "$lib/state/git-graph-actions.svelte";

  interface Props {
    menu: GraphMenu;
    menuEl?: HTMLElement | null;
    chips: RefChips;
    actions: GitGraphActions;
    prForHead: (name: string) => PrSnapshot | undefined;
    prForRemote: (chip: RemoteRefChip) => PrSnapshot | undefined;
    onOpenMenu: (
      event: MouseEvent,
      commit: CommitInfo,
      scopedBranch?: string | null,
      remote?: RemoteRefChip | null,
      scopedTag?: string | null,
    ) => void;
    onTogglePr: (event: MouseEvent, commit: CommitInfo, pr: PrSnapshot) => void;
    onBackdropContextMenu: (event: MouseEvent) => void;
  }

  let {
    menu: m, menuEl = $bindable(null), chips: menuChips, actions, prForHead, prForRemote,
    onOpenMenu, onTogglePr, onBackdropContextMenu,
  }: Props = $props();

  // Badge-scoped menu (#405): opened from a branch chip, only that branch's
  // delete entry shows; opened from the row, all of them do.
  const deletableHeads = $derived(menuChips.heads.filter(
    (h) => !h.active && (m.kind === "actions" && (m.scopedBranch === null || h.name === m.scopedBranch)),
  ));
</script>

<!-- Backdrop closes the menu on any outside interaction. -->
<button
  class="menu-backdrop"
  aria-label="Close menu"
  onclick={actions.closeMenu}
  oncontextmenu={onBackdropContextMenu}
></button>
<div
  class="commit-menu" class:references-menu={m.kind === "references"}
  data-testid="git-graph-menu"
  role="menu"
  tabindex="-1"
  bind:this={menuEl}
  style="left: {m.x}px; top: {m.y}px;"
>
  {#if m.kind === "references"}
    {@const rowPrNumbers = new Set(menuChips.heads.map((head) => prForHead(head.name)?.number))}
    {#if m.commit.stash}
      <button class="menu-item" role="menuitem" onclick={(event) => onOpenMenu(event, m.commit)}>
        Stash: {m.commit.stash}
      </button>
    {/if}
    {#each menuChips.heads as head (head.name)}
      <button class="menu-item" role="menuitem" onclick={(event) => onOpenMenu(event, m.commit, head.name)}>
        Branch: {head.name}{head.remotes.length ? ` (${head.remotes.map(remote => `${remote}/${head.name}`).join(", ")})` : ""}
      </button>
      {#if prForHead(head.name)}
        {@const pr = prForHead(head.name)!}
        <button class="menu-item" role="menuitem" onclick={(event) => { onTogglePr(event, m.commit, pr); actions.closeMenu(); }}>
          PR #{pr.number}: {pr.title}
        </button>
      {/if}
    {/each}
    {#each menuChips.remotes as remote (remote.name)}
      <button class="menu-item" role="menuitem" onclick={(event) => onOpenMenu(event, m.commit, null, remote)}>
        Remote: {remote.name}
      </button>
      {#if prForRemote(remote) && !rowPrNumbers.has(prForRemote(remote)!.number)}
        {@const pr = prForRemote(remote)!}
        <button class="menu-item" role="menuitem" onclick={(event) => { onTogglePr(event, m.commit, pr); actions.closeMenu(); }}>
          PR #{pr.number}: {pr.title}
        </button>
      {/if}
    {/each}
    {#each menuChips.tags as tag (tag)}
      <button class="menu-item" role="menuitem" onclick={(event) => onOpenMenu(event, m.commit, null, null, tag)}>
        Tag: {tag}
      </button>
    {/each}
  {:else}
    {@const am = m}
    <button class="menu-item" role="menuitem" onclick={() => actions.startPrompt("branch", am.commit.oid)}>
      Create Branch…
    </button>
    <button class="menu-item" role="menuitem" onclick={() => actions.startPrompt("tag", am.commit.oid)}>
      Create Tag…
    </button>
    <div class="menu-sep"></div>
    {#if am.remote}
      <!-- Tracking checkout of a remote-only branch (#432): create/switch to
           a local branch tracking <remote>/<branch>. -->
      <button
        class="menu-item"
        role="menuitem"
        data-testid="git-graph-checkout-tracking"
        onclick={() => actions.checkoutTracking(am.remote!)}
      >
        Checkout {am.remote.branch} (tracking {am.remote.name})
      </button>
    {/if}
    <button class="menu-item" role="menuitem" onclick={() => actions.checkout(am.checkoutBranch, am.commit.oid)}>
      Checkout{am.checkoutBranch ? ` ${am.checkoutBranch}` : " (detached)"}
    </button>
    <button class="menu-item" role="menuitem" onclick={() => void actions.cherryPick(am.commit.oid)}>
      Cherry-pick
    </button>
    <button class="menu-item" role="menuitem" onclick={() => void actions.revert(am.commit.oid)}>
      Revert
    </button>
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onclick={() => void actions.merge(am.checkoutBranch ?? am.commit.oid)}>
      Merge into current branch
    </button>
    <button class="menu-item" role="menuitem" onclick={() => void actions.rebase(am.commit.oid)}>
      Rebase current branch on this Commit
    </button>
    <!-- Suboptions open a modal, not a cascading submenu (#406). -->
    <button
      class="menu-item"
      role="menuitem"
      onclick={() => actions.openActionModal({ kind: "reset", oid: am.commit.oid, summary: am.commit.summary })}
    >
      Reset current branch to this Commit…
    </button>
    {#if am.scopedBranch}
      <button class="menu-item" role="menuitem" onclick={() => actions.startRenameBranch(am.scopedBranch!)}>
        Rename Branch '{am.scopedBranch}'…
      </button>
    {/if}
    {#if deletableHeads.length > 0 || menuChips.remotes.length > 0 || am.scopedTag}
      <div class="menu-sep"></div>
      {#each deletableHeads as head (head.name)}
        <button
          class="menu-item"
          role="menuitem"
          onclick={() => actions.openActionModal({ kind: "deleteBranch", name: head.name, remotes: head.remotes })}
        >
          Delete Branch '{head.name}'…
        </button>
      {/each}
      {#each menuChips.remotes as remoteChip (remoteChip.name)}
        <button class="menu-item" role="menuitem" onclick={() => void actions.deleteRemoteChip(remoteChip)}>
          Delete Remote Branch '{remoteChip.name}'
        </button>
      {/each}
      {#if am.scopedTag}
        <button
          class="menu-item"
          role="menuitem"
          onclick={() => actions.openActionModal({ kind: "deleteTag", name: am.scopedTag! })}
        >
          Delete Tag '{am.scopedTag}'…
        </button>
      {/if}
    {/if}
    <div class="menu-sep"></div>
    <button class="menu-item" role="menuitem" onclick={() => actions.copyToClipboard(am.commit.oid, "commit hash")}>
      Copy Commit Hash
    </button>
    <button class="menu-item" role="menuitem" onclick={() => actions.copyToClipboard(am.commit.summary, "commit subject")}>
      Copy Commit Subject
    </button>
  {/if}
</div>

<style>
  .references-menu {
    max-width: min(420px, calc(100vw - 16px));
    max-height: min(400px, calc(100vh - 16px));
    overflow: auto;
  }

  .references-menu .menu-item {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  /* ----- Commit context menu ----- */

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
</style>

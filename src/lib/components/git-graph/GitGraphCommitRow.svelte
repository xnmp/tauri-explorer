<!--
  GitGraphCommitRow — one windowed commit row of the git graph (#256): ref
  decoration chips, PR and branch-status badges, summary, avatar and the
  optional author/date/commit/parent columns. Absolutely positioned at its
  grid offset by the parent, which owns selection, menus and expansions.
-->
<script lang="ts">
  import type { GraphCommit as CommitInfo } from "$lib/state/git-graph-cache";
  import type { PrSnapshot } from "$lib/state/git-pr-session.svelte";
  import type { GraphAvatarPrefs, GraphColumns } from "$lib/state/git-graph-view-prefs.svelte";
  import { prBadgePresentation, type RefChips, type RemoteRefChip } from "$lib/domain/git-graph";
  import type { BranchStatusBadge } from "$lib/domain/git-branch-status";
  import GitAuthorAvatar from "../GitAuthorAvatar.svelte";

  interface Props {
    commit: CommitInfo;
    chips: RefChips;
    /** The synthetic uncommitted-changes row. */
    synthetic: boolean;
    selected: boolean;
    muted: boolean;
    baseUpdateMuted: boolean;
    leftPadding: number;
    top: number;
    trace: "lit" | "dim" | undefined;
    avatars: GraphAvatarPrefs;
    columns: GraphColumns;
    authorWidth: number;
    dateWidth: number;
    referencesOpen: boolean;
    formatDate: (unixSeconds: number) => string;
    prForHead: (name: string) => PrSnapshot | undefined;
    prForRemote: (chip: RemoteRefChip) => PrSnapshot | undefined;
    isPrDetailOpen: (commit: CommitInfo, pr: PrSnapshot) => boolean;
    statusBadge: (name: string) => BranchStatusBadge | null;
    onSelect: (commit: CommitInfo) => void;
    onHoverChange: (commit: CommitInfo, hovered: boolean) => void;
    onOpenMenu: (
      event: MouseEvent,
      commit: CommitInfo,
      scopedBranch?: string | null,
      remote?: RemoteRefChip | null,
      scopedTag?: string | null,
    ) => void;
    onTogglePr: (event: MouseEvent, commit: CommitInfo, pr: PrSnapshot) => void;
    onOpenReferences: (event: MouseEvent, commit: CommitInfo) => void;
  }

  const {
    commit, chips, synthetic, selected, muted, baseUpdateMuted, leftPadding, top, trace,
    avatars, columns, authorWidth, dateWidth, referencesOpen, formatDate, prForHead,
    prForRemote, isPrDetailOpen, statusBadge, onSelect, onHoverChange, onOpenMenu,
    onTogglePr, onOpenReferences,
  }: Props = $props();
</script>

<!-- PR badge (#448/#459): CI-colored, glyph-decorated, and a toggle for
     the in-app details dropdown. Shared by both the local-branch and
     remote-only chip render sites. -->
{#snippet prBadge(pr: PrSnapshot)}
  {@const p = prBadgePresentation(pr)}
  <button
    type="button"
    class="ref ref-pr"
    class:draft={pr.draft}
    class:ci-success={p.ciClass === "ci-success"}
    class:ci-failure={p.ciClass === "ci-failure"}
    class:ci-pending={p.ciClass === "ci-pending"}
    class:open={isPrDetailOpen(commit, pr)}
    title={pr.title}
    aria-expanded={isPrDetailOpen(commit, pr)}
    onclick={(e) => onTogglePr(e, commit, pr)}
  >
    ⇄ #{pr.number}
    {#if p.reviewGlyph}<span class="pr-review" aria-hidden="true">{p.reviewGlyph}</span>{/if}
    {#if p.commentCount !== null}<span class="pr-comments" title="{p.commentCount} comments">🗨 {p.commentCount}</span>{/if}
  </button>
{/snippet}

<!-- Branch-status badge (#1081): merged / squashed / stale, keyed by the
     chip's branch shorthand. Never affects row muting. -->
{#snippet branchStatus(name: string)}
  {@const badge = statusBadge(name)}
  {#if badge}
    <span class="ref ref-status status-{badge.status}" data-branch-status={badge.status} title={badge.title}>{badge.label}</span>
  {/if}
{/snippet}

<div
  class="commit-row"
  class:selected
  class:is-head={chips.isHead}
  class:is-merge={muted}
  class:is-base-update-merge={baseUpdateMuted}
  class:uncommitted={synthetic}
  style:padding-left="{leftPadding}px"
  style:top="{top}px"
  data-oid={commit.short_oid}
  data-trace={trace}
  role="button"
  tabindex="0"
  onclick={() => onSelect(commit)}
  onpointerenter={() => onHoverChange(commit, true)}
  onpointerleave={() => onHoverChange(commit, false)}
  onkeydown={(e) => {
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      onSelect(commit);
    }
  }}
  oncontextmenu={(e) => { if (!synthetic) onOpenMenu(e, commit); else e.preventDefault(); }}
>
  {#if synthetic}
    <span class="summary uncommitted-label">{commit.summary}</span>
  {:else}
    <!-- PR numbers already badged by a local-branch chip this row, so the
         remote-only loop below can skip them (#448) — a branch with an
         in-sync remote never needs the same PR badged twice. -->
    {@const rowPrNumbers = new Set(
      chips.heads.map((h) => prForHead(h.name)?.number).filter((n) => n !== undefined),
    )}
    <span class="message-cell">
      <span class="message-content">
        {#if commit.stash}
          <span class="ref ref-stash">{commit.stash}</span>
        {/if}
        {#each chips.heads as head (head.name)}
          <!-- svelte-ignore a11y_no_static_element_interactions -- right-click scopes the row context menu to this badge (#405); the row itself stays the keyboard target -->
          <span
            class="ref ref-branch"
            class:ref-active={head.active}
            oncontextmenu={(e) => { e.stopPropagation(); onOpenMenu(e, commit, head.name); }}
          >
            {head.name}
            {#each head.remotes as remote (remote)}
              <span class="ref-remote-sub" title="{remote}/{head.name} is at this commit">{remote}</span>
            {/each}
          </span>
          {@render branchStatus(head.name)}
          {#if prForHead(head.name)}
            {@render prBadge(prForHead(head.name)!)}
          {/if}
        {/each}
        {#each chips.remotes as remote (remote.name)}
          <!-- svelte-ignore a11y_no_static_element_interactions -- right-click scopes the row context menu to this remote branch for a tracking checkout (#432); the row itself stays the keyboard target -->
          <span
            class="ref ref-remote"
            title="Remote-only branch — no local branch tracks {remote.name}. Right-click to checkout."
            oncontextmenu={(e) => { e.stopPropagation(); onOpenMenu(e, commit, null, remote); }}
          >
            <svg class="remote-cloud" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4.5 12.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.8-.9 2.9 2.9 0 0 1-.5 5.9z" />
            </svg>{remote.name}
          </span>
          {@render branchStatus(remote.name)}
          {#if prForRemote(remote) && !rowPrNumbers.has(prForRemote(remote)!.number)}
            {@render prBadge(prForRemote(remote)!)}
          {/if}
        {/each}
        {#each chips.tags as tag (tag)}
          <!-- svelte-ignore a11y_no_static_element_interactions -- right-click scopes tag actions to this ref -->
          <span
            class="ref ref-tag"
            oncontextmenu={(e) => { e.stopPropagation(); onOpenMenu(e, commit, null, null, tag); }}
          >{tag}</span>
        {/each}
        <span class="summary" title={commit.summary}>{commit.summary}</span>
      </span>
      {#if commit.stash || chips.heads.length || chips.remotes.length || chips.tags.length}
        <button type="button" class="references-button"
          title="Show all references" aria-label="Show all references for {commit.short_oid}"
          aria-haspopup="menu" aria-expanded={referencesOpen}
          onclick={(event) => onOpenReferences(event, commit)}>···</button>
      {/if}
    </span>
    {#if avatars.visible}
      <GitAuthorAvatar name={commit.author_name} email={commit.author_email} gravatarEnabled={avatars.gravatarEnabled} />
    {/if}
    {#if columns.author}<span class="author" style:width="{authorWidth}px">{commit.author_name}</span>{/if}
    {#if columns.date}<span class="date" style:width="{dateWidth}px">{formatDate(commit.author_time)}</span>{/if}
    {#if columns.commit}<span class="oid">{commit.short_oid}</span>{/if}
    {#if columns.parent}<span class="oid parent-col">{commit.parents.map((p) => p.slice(0, 7)).join(" ") || "—"}</span>{/if}
  {/if}
</div>

<style>
  .commit-row {
    /* Windowed rendering (#256): rows sit at their absolute grid offset so
       the visible slice needs no sibling flow. */
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 14px 0 10px;
    font-size: var(--font-size-body);
    overflow: hidden;
  }

  .commit-row:hover {
    background: var(--subtle-fill-secondary);
  }

  .commit-row {
    cursor: pointer;
    transition: opacity 100ms ease;
  }

  .commit-row[data-trace="dim"] {
    opacity: 0.2;
  }

  .commit-row.selected {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  /* Subtle tint marking the row the current HEAD points at, à la Git Graph. */
  .commit-row.is-head {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }
  .commit-row.is-head.selected {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  /* Merge commits are muted (#458): dim only the text spans so the graph
     vertex and lanes (a separate SVG) stay at full strength. Opacity keeps
     this theme-agnostic. */
  .commit-row.is-merge .summary,
  .commit-row.is-merge .author,
  .commit-row.is-merge .date,
  .commit-row.is-merge .oid {
    opacity: 0.5;
  }

  /* Base-branch sync merges are housekeeping, not the PR's own work (#527).
     When generic merge muting is off, keep their dedicated treatment visibly
     quieter without hiding their graph topology. */
  .commit-row.is-base-update-merge .summary,
  .commit-row.is-base-update-merge .author,
  .commit-row.is-base-update-merge .date,
  .commit-row.is-base-update-merge .oid {
    opacity: 0.32;
  }

  .oid {
    flex-shrink: 0;
    width: 60px;
    margin-left: 8px;
    text-align: right;
  }

  /* Parent column (#402): wider — merges list two short OIDs. */
  .parent-col {
    width: 120px;
  }

  .uncommitted-label {
    color: var(--text-tertiary);
    font-style: italic;
  }

  .ref-active {
    outline: 1px solid var(--accent);
  }

  .ref-remote-sub {
    margin-left: 4px;
    padding: 0 4px;
    border-radius: 6px;
    background: color-mix(in srgb, #3b82f6 18%, transparent);
    color: #3b82f6;
    font-size: var(--font-size-caption);
  }

  .ref-stash {
    background: color-mix(in srgb, #64748b 18%, transparent);
    color: #64748b;
    border-color: color-mix(in srgb, #64748b 40%, transparent);
    font-family: var(--font-mono, monospace);
  }

  .oid {
    font-family: var(--font-mono, monospace);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
  }

  .ref {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 8px;
    font-size: var(--font-size-caption);
    font-weight: 600;
    line-height: 1.5;
    border: 1px solid transparent;
  }

  .ref-head {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent-text, var(--accent));
    border-color: var(--accent);
  }

  .ref-branch {
    background: color-mix(in srgb, #10b981 15%, transparent);
    color: #10b981;
    border-color: color-mix(in srgb, #10b981 40%, transparent);
  }

  /* Remote-only branch (no local branch tracks it, #381): dashed outline +
     cloud glyph distinguish it from a local branch chip at a glance. */
  .ref-remote {
    background: color-mix(in srgb, #3b82f6 15%, transparent);
    color: #3b82f6;
    border-color: color-mix(in srgb, #3b82f6 40%, transparent);
    border-style: dashed;
  }

  .remote-cloud {
    margin-right: 3px;
    vertical-align: -1px;
  }

  .ref-tag {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #d97706;
    border-color: color-mix(in srgb, #f59e0b 40%, transparent);
  }

  /* Branch-status badges (#1081): small outlined pills beside the chip. */
  .ref-status {
    font-weight: 500;
    background: transparent;
  }

  .ref-status.status-merged {
    color: #a371f7;
    border-color: color-mix(in srgb, #a371f7 45%, transparent);
  }

  .ref-status.status-squash_merged {
    color: #8957e5;
    border-color: color-mix(in srgb, #8957e5 45%, transparent);
    border-style: dashed;
  }

  .ref-status.status-stale {
    color: var(--text-secondary, #8b949e);
    border-color: color-mix(in srgb, #8b949e 45%, transparent);
  }

  /* Open GitHub PR badge (#448): GitHub's PR purple. A <button>, not a
     <span> like its neighbours — reset its chrome so it still reads as a
     pill chip. */
  .ref-pr {
    font: inherit;
    cursor: pointer;
    background: color-mix(in srgb, #a371f7 15%, transparent);
    color: #a371f7;
    border-color: color-mix(in srgb, #a371f7 30%, transparent);
  }

  .ref-pr:hover {
    background: color-mix(in srgb, #a371f7 25%, transparent);
  }

  /* Draft PR: desaturated grey, mirroring .ref-remote's dashed-outline
     "not fully real yet" treatment. */
  .ref-pr.draft {
    background: color-mix(in srgb, #8b949e 15%, transparent);
    color: #8b949e;
    border-color: color-mix(in srgb, #8b949e 30%, transparent);
  }

  .ref-pr.draft:hover {
    background: color-mix(in srgb, #8b949e 25%, transparent);
  }

  /* CI-status badge colors (#459): the badge text/tint reflects the head
     commit's check rollup. Draft styling (grey) always wins — a draft never
     gets a ci-* class (see prBadgePresentation). Colors come from the theme's
     system tokens so every theme stays coherent. */
  .ref-pr.ci-success {
    color: var(--system-success-text, var(--system-success));
    background: color-mix(in srgb, var(--system-success) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-success) 32%, transparent);
  }
  .ref-pr.ci-success:hover {
    background: color-mix(in srgb, var(--system-success) 24%, transparent);
  }
  .ref-pr.ci-failure {
    color: var(--system-critical-text, var(--system-critical));
    background: color-mix(in srgb, var(--system-critical) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-critical) 32%, transparent);
  }
  .ref-pr.ci-failure:hover {
    background: color-mix(in srgb, var(--system-critical) 24%, transparent);
  }
  .ref-pr.ci-pending {
    color: var(--system-caution-text, var(--system-caution));
    background: color-mix(in srgb, var(--system-caution) 14%, transparent);
    border-color: color-mix(in srgb, var(--system-caution) 32%, transparent);
  }
  .ref-pr.ci-pending:hover {
    background: color-mix(in srgb, var(--system-caution) 24%, transparent);
  }

  /* Open dropdown: a subtle ring so the toggled badge reads as active. */
  .ref-pr.open {
    outline: 1px solid currentColor;
    outline-offset: 1px;
  }

  /* Review / comment glyphs appended inside the badge — inherit the badge's
     CI color (currentColor) so the whole chip stays one visual unit. */
  .pr-review,
  .pr-comments {
    margin-left: 3px;
    font-weight: 700;
  }

  .message-cell,
  .message-content {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .references-button {
    flex-shrink: 0;
    padding: 0 3px;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    background: none;
    font: inherit;
    cursor: pointer;
  }

  .references-button:hover,
  .references-button[aria-expanded="true"] {
    color: var(--text-primary);
    background: var(--subtle-fill-secondary);
  }

  .summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .author {
    margin-left: auto;
    flex-shrink: 0;
    width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    color: var(--text-tertiary);
  }

  .date {
    flex-shrink: 0;
    width: 84px;
    text-align: right;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }
</style>

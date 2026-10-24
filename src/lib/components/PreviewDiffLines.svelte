<!--
  PreviewDiffLines — the rendered lines of a preview diff: old/new gutters,
  sigils, highlighted content, and per-hunk stage / unstage / discard
  actions for a working-tree diff (a commit diff has none, #366).
-->
<script lang="ts">
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import type { DiffLine, ParsedDiff } from "$lib/domain/diff";
  import type { HunkAction } from "$lib/state/preview-diff-actions";

  interface Props {
    lines: DiffLine[];
    parsed: ParsedDiff | null;
    /** Repo-relative path, for syntax highlighting. */
    path: string;
    /** The open working-tree diff; null for a commit diff (no hunk actions). */
    activeDiff: { staged: boolean } | null;
    blocked: boolean;
    onApplyHunk: (patch: string, action: HunkAction) => void;
  }

  const { lines, parsed, path, activeDiff, blocked, onApplyHunk }: Props = $props();
</script>

<div class="diff-lines">
  {#each lines as line (line.index)}
    <div class="diff-line {line.kind}" data-line-kind={line.kind}>
      <span class="diff-gutter old">{line.oldLine ?? ""}</span>
      <span class="diff-gutter new">{line.newLine ?? ""}</span>
      <span class="diff-sigil">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "hunk" ? "@" : " "}</span>
      {#if line.kind === "hunk"}
        {@const hunk = parsed?.hunks.find((candidate) => candidate.lineIndex === line.index)}
        <span class="diff-content hunk-content">
          <span class="hunk-range">{line.text}</span>
          {#if activeDiff && hunk}
            <span class="hunk-actions">
              {#if activeDiff.staged}
                <button type="button" class="hunk-action" disabled={blocked} onclick={() => onApplyHunk(hunk.patch, "unstage")}>Unstage hunk</button>
              {:else}
                <button type="button" class="hunk-action" disabled={blocked} onclick={() => onApplyHunk(hunk.patch, "stage")}>Stage hunk</button>
                {#if !parsed?.added}
                  <button type="button" class="hunk-action danger" disabled={blocked} onclick={() => onApplyHunk(hunk.patch, "discard")}>Discard hunk</button>
                {/if}
              {/if}
            </span>
          {/if}
        </span>
      {:else if line.kind === "meta" || line.kind === "header"}
        <span class="diff-content">{line.text}</span>
      {:else}
        <!-- highlightDiffLine output is hljs-generated/escaped HTML — safe sink (#227). -->
        <span class="diff-content">{@html highlightDiffLine(line.text, path)}</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .diff-lines {
    flex: 1;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 18px;
  }

  .diff-line {
    display: grid;
    grid-template-columns: 36px 36px 14px 1fr;
    min-height: 18px;
    white-space: pre;
    padding-right: 8px;
  }

  .diff-line.context { background: transparent; }
  .diff-line.add { background: color-mix(in srgb, #22c55e 12%, transparent); }
  .diff-line.remove { background: color-mix(in srgb, #ef4444 14%, transparent); }
  .diff-line.hunk { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text-tertiary); }
  .diff-line.binary { color: var(--text-tertiary); font-style: italic; }

  .diff-gutter {
    padding-right: 4px;
    text-align: right;
    color: var(--text-tertiary);
    user-select: none;
    border-right: 1px solid color-mix(in srgb, var(--divider) 50%, transparent);
  }

  .diff-sigil {
    text-align: center;
    color: var(--text-tertiary);
    user-select: none;
  }

  .diff-line.add .diff-sigil { color: #16a34a; }
  .diff-line.remove .diff-sigil { color: #dc2626; }

  .diff-content {
    padding-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }

  .hunk-content, .hunk-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* In a narrow pane a hunk's actions wrap below its range, the range
     ellipsizes, and each action's label wraps, so no action is ever clipped
     out of reach (#792). */
  .hunk-content {
    flex-wrap: wrap;
    row-gap: 2px;
  }

  .hunk-range {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hunk-actions {
    flex: 1 0 100%;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
  }

  .hunk-action {
    min-width: 0;
    max-width: 100%;
    padding: 1px 3px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .hunk-action.danger { color: var(--system-critical-text, var(--system-critical, #dc2626)); }
</style>

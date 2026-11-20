<!--
  EntryNameLabel - The displayed entry name for each view mode, without any
  explorer state. EntryName wraps it with inline rename; surfaces that have no
  ExplorerInstance (the plugin SDK's file tiles) render it directly, so every
  name looks the same.
-->
<script lang="ts">
  import { displayName } from "$lib/domain/wire-name";
  import type { GitStatusPresentation } from "$lib/domain/git-status-presentation";

  interface Props {
    name: string;
    variant: "details" | "list" | "tiles";
    bold?: boolean;
    /** Invisible copy that holds a tile's height open under the rename box. */
    placeholder?: boolean;
    /** Shown in place of the name (a lineage child's prompt, #1449); the name stays in `tooltip`. */
    text?: string | null;
    tooltip?: string;
    /** Git status (#1852): tints the name in its status colour; ignored dims it. */
    git?: GitStatusPresentation | null;
  }

  let { name, variant, placeholder = false, bold = false, text, tooltip, git = null }: Props = $props();
  // `name` is the wire identity; bytes that are not UTF-8 show as U+FFFD (#1592).
  const shown = $derived(displayName(name));
</script>

{#if placeholder}
  <span class="name-tiles rename-placeholder" data-region="entry-name" aria-hidden="true">{shown}</span>
{:else}
  <span
    class="entry-name"
    data-region="entry-name"
    style:font-weight={bold ? 600 : undefined}
    class:name-details={variant === "details"}
    class:name-list={variant === "list"}
    class:name-tiles={variant === "tiles"}
    class:git-tinted={!!git}
    data-git-tone={git?.tone}
    style:--git-color={git?.color}
    title={tooltip ?? (variant === "tiles" ? shown : undefined)}
  >{text || shown}</span>
{/if}

<style>
  /* Invisible copy of the name that holds the tile's natural height open while
     the absolutely-positioned rename box floats over it — so renaming never
     shifts neighbouring tiles, regardless of how many lines the box grows to. */
  .rename-placeholder {
    visibility: hidden;
    pointer-events: none;
  }

  /* Git status tint (#1852). Selected rows keep it: their accent wash is a
     light 8% tint, so the theme's --git-* shades stay readable on it. */
  .git-tinted {
    color: var(--git-color);
  }

  .name-details {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .name-list {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name-tiles {
    width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    text-overflow: ellipsis;
    white-space: normal;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    padding-top: 1px;
  }
</style>

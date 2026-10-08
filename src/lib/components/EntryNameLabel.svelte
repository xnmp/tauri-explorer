<!--
  EntryNameLabel - The displayed entry name for each view mode, without any
  explorer state. EntryName wraps it with inline rename; surfaces that have no
  ExplorerInstance (the plugin SDK's file tiles) render it directly, so every
  name looks the same.
-->
<script lang="ts">
  interface Props {
    name: string;
    variant: "details" | "list" | "tiles";
    /** Invisible copy that holds a tile's height open under the rename box. */
    placeholder?: boolean;
  }

  let { name, variant, placeholder = false }: Props = $props();
</script>

{#if placeholder}
  <span class="name-tiles rename-placeholder" aria-hidden="true">{name}</span>
{:else}
  <span
    class="entry-name"
    class:name-details={variant === "details"}
    class:name-list={variant === "list"}
    class:name-tiles={variant === "tiles"}
    title={variant === "tiles" ? name : undefined}
  >{name}</span>
{/if}

<style>
  /* Invisible copy of the name that holds the tile's natural height open while
     the absolutely-positioned rename box floats over it — so renaming never
     shifts neighbouring tiles, regardless of how many lines the box grows to. */
  .rename-placeholder {
    visibility: hidden;
    pointer-events: none;
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

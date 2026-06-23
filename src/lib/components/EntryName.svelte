<!--
  EntryName - Shared inline rename input/display for all view modes.
  Consolidates useInlineRename composable wiring, dialogStore.renamingEntry
  derivation, focus $effect, and rename-or-display template.
  Issue: #108
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { useInlineRename } from "$lib/composables/use-inline-rename.svelte";

  interface Props {
    entry: FileEntry;
    explorer: ExplorerInstance;
    variant: "details" | "list" | "tiles";
  }

  let { entry, explorer, variant }: Props = $props();

  const rename = useInlineRename(() => explorer);

  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  // Focus and select the rename input when rename mode starts.
  // Keyed on the rename session (the renaming entry's path), NOT on `entry`
  // identity: silent refreshes mid-rename replace the entry object, and
  // re-running focusAndSelect would wipe the user's typed name.
  let focusedRenamePath: string | null = null;

  $effect(() => {
    const renamingPath = dialogStore.renamingEntry?.path ?? null;
    const input = rename.renameInputRef;
    untrack(() => {
      if (!renamingPath) {
        focusedRenamePath = null;
        return;
      }
      if (renamingPath !== entry.path || !input) return;
      if (focusedRenamePath === renamingPath) return;
      focusedRenamePath = renamingPath;
      rename.focusAndSelect(entry);
      tick().then(autoSizeRename);
    });
  });

  // Commit the rename when the user points at anything outside the box (e.g.
  // clicks another file). We can't rely on the input's native blur: on
  // Windows/macOS the file items call preventDefault() on mousedown for pointer
  // drag, which keeps focus on the input so blur never fires. A capture-phase
  // pointerdown listener runs before those handlers and commits explicitly.
  $effect(() => {
    if (!isRenaming) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = rename.renameInputRef;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      rename.handleRenameBlur(entry.name);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  });

  // Shared off-DOM canvas for measuring text width in the input's own font.
  let measureCtx: CanvasRenderingContext2D | null = null;
  function measureTextWidth(text: string, font: string): number {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return text.length * 8; // crude fallback
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }

  /**
   * Size the rename box to its content so it's never shorter than the filename
   * and never gratuitously wide.
   *
   * - Tiles: a centered floating box that grows in WIDTH to fit the name (up to
   *   a cap), then wraps and grows in height beyond the cap.
   * - Details/List: a single-line box that fills at least its cell and grows
   *   wider to fit a long name (up to a cap), overflowing neighbouring columns.
   */
  function autoSizeRename(): void {
    const el = rename.renameInputRef;
    if (!el) return;
    const cs = getComputedStyle(el);
    const chrome =
      parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
      parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    const textW = measureTextWidth(el.value || " ", cs.font);

    if (variant === "tiles") {
      const MIN = 64;
      const MAX = 320;
      const w = Math.min(MAX, Math.max(MIN, Math.ceil(textW + chrome + 8)));
      el.style.width = `${w}px`;
      // Grow height only when the (capped-width) text has to wrap.
      el.style.height = "auto";
      el.style.height = `${(el as HTMLTextAreaElement).scrollHeight + 2}px`;
    } else {
      // Fill at least the cell, expand to fit the name, capped so a huge name
      // doesn't blanket the whole pane.
      const cell =
        el.closest<HTMLElement>(".name-cell") ?? el.closest<HTMLElement>(".list-item");
      const minW = cell?.clientWidth ?? 0;
      // Fill at least the cell, then grow to fit the name but only up to a
      // modest cap — a very long name scrolls inside the box rather than
      // blanketing the pane.
      const MAX = 340;
      const w = Math.max(minW, Math.min(MAX, Math.ceil(textW + chrome + 10)));
      el.style.width = `${w}px`;
    }
  }
</script>

{#if isRenaming}
  {#if variant === "tiles"}
    <!-- The name stays in flow (invisible) so the tile keeps EXACTLY its
         pre-rename height — the rename box floats above it absolutely and
         therefore never shifts neighbouring tiles, however many lines it grows
         to. -->
    <div class="tile-rename-anchor">
      <span class="name-tiles rename-placeholder" aria-hidden="true">{entry.name}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="rename-input tile-rename"
        class:error={!!rename.renameError}
        bind:value={rename.editedName}
        bind:this={rename.renameInputRef}
        oninput={autoSizeRename}
        onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
        onblur={() => rename.handleRenameBlur(entry.name)}
        onclick={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        disabled={rename.submittingRename}
        rows="1"
        autofocus
      ></textarea>
    </div>
  {:else}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      class="rename-input rename-row"
      class:error={!!rename.renameError}
      bind:value={rename.editedName}
      bind:this={rename.renameInputRef}
      oninput={autoSizeRename}
      onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
      onblur={() => rename.handleRenameBlur(entry.name)}
      onclick={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
      disabled={rename.submittingRename}
      autofocus
    />
  {/if}
{:else}
  <span
    class="entry-name"
    class:name-details={variant === "details"}
    class:name-list={variant === "list"}
    class:name-tiles={variant === "tiles"}
    title={variant === "tiles" ? entry.name : undefined}
  >{entry.name}</span>
{/if}

<style>
  /* Rename input — shared across all variants */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    margin: -3px 0;
    background: var(--control-fill);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    box-shadow: 0 0 0 1px var(--accent);
  }

  .rename-input:focus {
    background: var(--control-fill-secondary);
  }

  .rename-input:disabled {
    opacity: 0.6;
  }

  .rename-input.error {
    border-color: var(--system-critical);
    box-shadow: 0 0 0 1px var(--system-critical);
  }

  /* Details / List single-line box. Width is set to fit the name by
     autoSizeRename; it overflows its cell to the right (ancestors lift their
     overflow while renaming), so it must paint opaque and above siblings. */
  .rename-input.rename-row {
    position: relative;
    z-index: 5;
    flex: 0 0 auto;
    /* Pull the box left by its own border (1px) + padding (6px) so the editable
       text sits exactly where the displayed name text was — no sideways jump
       when rename mode opens. */
    margin-left: -7px;
    background: var(--background-solid);
    box-shadow: 0 0 0 1px var(--accent), 0 4px 12px rgba(0, 0, 0, 0.18);
  }

  .rename-input.rename-row:focus {
    background: var(--background-solid);
  }

  .tile-rename-anchor {
    position: relative;
    width: 100%;
  }

  /* Invisible copy of the name that holds the tile's natural height open while
     the absolutely-positioned rename box floats over it — so renaming never
     shifts neighbouring tiles, regardless of how many lines the box grows to. */
  .rename-placeholder {
    visibility: hidden;
    pointer-events: none;
  }

  .rename-input.tile-rename {
    position: absolute;
    top: -2px;
    left: 50%;
    transform: translateX(-50%);
    /* Width set to fit content by autoSizeRename; cap as a safety net. */
    max-width: 320px;
    margin: 0;
    text-align: center;
    resize: none;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    font-size: 13px;
    /* Height is grown to fit content by autoSizeRename — never scroll. */
    overflow: hidden;
    z-index: 10;
    /* Opaque: the box floats over tile borders and neighbouring names. */
    background: var(--background-solid);
    box-shadow: 0 0 0 1px var(--accent), 0 8px 24px rgba(0, 0, 0, 0.25);
  }

  .rename-input.tile-rename:focus {
    background: var(--background-solid);
  }

  /* Name display — variant-specific styles */
  .name-details {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .name-list {
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

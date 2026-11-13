<!--
  SidebarSectionMenu - backdrop + fixed popup shared by sidebar section-header
  context menus (Bookmarks: restore folders; Recent: item count, #1661).
  Children render `.section-menu-item` buttons, styled here.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let { position, onclose, label, children }: {
    position: { x: number; y: number };
    onclose: () => void;
    label?: string;
    children: Snippet;
  } = $props();
</script>

<div
  class="section-menu-backdrop"
  onclick={onclose}
  oncontextmenu={(e) => { e.preventDefault(); onclose(); }}
  onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
  role="presentation"
></div>
<div class="section-menu" style="left: {position.x}px; top: {position.y}px;" role="menu" aria-label={label}>
  {@render children()}
</div>

<style>
  .section-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }
  .section-menu {
    position: fixed;
    z-index: 100;
    min-width: 180px;
    padding: 4px;
    background: var(--background-card, var(--background-solid));
    border: 1px solid var(--divider);
    border-radius: var(--radius-md, 6px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .section-menu :global(.section-menu-item) {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
  }
  .section-menu :global(.section-menu-item:hover:not(:disabled)) {
    background: var(--subtle-fill-secondary);
  }
  .section-menu :global(.section-menu-item:disabled) {
    color: var(--text-tertiary);
    cursor: default;
  }
</style>

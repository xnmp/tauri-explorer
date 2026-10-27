<!--
  SettingRow — one Settings row: label and description on the left, the
  control (children) on the right. `hidden` drops the row while the
  settings filter excludes it; `info` adds content under the description.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    description: string;
    hidden: boolean;
    /** Extra class on the row element. */
    class?: string;
    info?: Snippet;
    children?: Snippet;
  }

  const { label, description, hidden, class: extraClass, info, children }: Props = $props();
</script>

<!-- A string template, not class={[...]}: the array form pulls Svelte's clsx
     helper into the shared startup runtime chunk (#1372). -->
<div class="setting-row{extraClass ? ` ${extraClass}` : ''}" class:hidden>
  <div class="setting-info">
    <span class="setting-label">{label}</span>
    <span class="setting-description">{description}</span>
    {@render info?.()}
  </div>
  {@render children?.()}
</div>

<style>
  .hidden {
    display: none !important;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--divider);
  }

  .setting-row:last-child {
    border-bottom: none;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>

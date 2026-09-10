<script lang="ts">

  interface Props {
    onOpen: () => void;
    count: number;
    error: string | null;
  }

  let { onOpen, count, error }: Props = $props();
</script>

{#if count > 0 || error}
  <button
    type="button"
    class:error={!!error}
    class="recovery-notice"
    onclick={onOpen}
    aria-label={error
      ? "Open file recovery; recovery status needs attention"
      : `Open file recovery; ${count} ${count === 1 ? "item" : "items"} need attention`}
    data-testid="file-recovery-notice"
  >
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 5.5A5.5 5.5 0 1 1 2.7 10M3 5.5V2M3 5.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span>{error ? "Recovery needs attention" : `${count} to recover`}</span>
  </button>
{/if}

<style>
  .recovery-notice {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    min-width: 0;
    min-height: 24px;
    padding: 2px var(--spacing-sm);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--system-caution);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .recovery-notice.error {
    color: var(--system-critical);
  }

  .recovery-notice:hover {
    background: var(--subtle-fill-secondary);
    border-color: var(--control-stroke);
  }

  .recovery-notice:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }
</style>

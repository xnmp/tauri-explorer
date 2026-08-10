<!--
  Toast notification overlay - displays stacked notifications
  Extracted from FileList.svelte
-->
<script lang="ts">
  import { toastStore } from "$lib/state/toast.svelte";
  import { openExternalUrl } from "$lib/api/crash";

  function openLink(event: MouseEvent, url: string): void {
    event.preventDefault();
    void openExternalUrl(url);
  }
</script>

{#if toastStore.toasts.length > 0}
  <div class="toast-container">
    {#each toastStore.toasts as toast (toast.id)}
      <div class="toast {toast.type}" class:cut={toast.isCut} role={toast.type === "error" ? "alert" : "status"}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {#if toast.type === "clipboard" && toast.isCut}
            <path d="M6 3L3 6L6 9M10 3L13 6L10 9M4 6H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          {:else if toast.type === "clipboard"}
            <path d="M4 4H12M4 4V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V4M4 4L5 2H11L12 4M7 7V10M9 7V10" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          {:else if toast.type === "error"}
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
            <path d="M8 5V8.5M8 11V10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          {:else if toast.type === "progress"}
            <!-- An in-flight indicator must not wear the success checkmark the
                 default branch draws: a spinning arc reads as "still working". -->
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25" opacity="0.25"/>
            <path class="spinner-arc" d="M8 1.5A6.5 6.5 0 0 1 14.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          {:else}
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.25"/>
            <path d="M5.5 8L7 9.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          {/if}
        </svg>
        <span>{toast.message}{#if toast.type === "clipboard"} — Ctrl+V to paste{/if}</span>
        {#if toast.link}
          <a href={toast.link.url} onclick={(event) => openLink(event, toast.link!.url)}>
            {toast.link.label}
          </a>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Fixed, not absolute (#417): the overlay is mounted once at the app root
     and must overlay whatever the panes show (file list, git graph, …). */
  .toast-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    /* Notifications must remain legible over any pane or vibrancy backdrop. */
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-pill);
    font-size: var(--font-size-caption);
    padding: var(--spacing-sm) var(--spacing-lg);
    box-shadow: var(--shadow-tooltip);
    animation: toastIn 200ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes toastIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .toast.clipboard {
    color: var(--accent);
  }

  .toast.progress {
    color: var(--text-secondary);
    /* Progress feedback must be visible immediately. WebKit can leave an
       entrance animation at its zero-opacity first frame under heavy load,
       hiding the only indication that a slow operation was accepted. */
    animation: none;
  }

  .spinner-arc {
    transform-origin: 8px 8px;
    animation: toastSpin 900ms linear infinite;
  }

  @keyframes toastSpin {
    to { transform: rotate(360deg); }
  }

  /* Respect a reduced-motion preference: the arc still reads as "in progress"
     against the faint full circle without rotating. */
  @media (prefers-reduced-motion: reduce) {
    .spinner-arc { animation: none; }
  }

  .toast.clipboard.cut {
    color: var(--system-caution);
  }

  .toast.error {
    border-color: rgba(196, 43, 28, 0.2);
    color: var(--system-critical);
  }

  .toast.success {
    border-color: rgba(15, 123, 15, 0.2);
    color: var(--system-success);
  }

  .toast a {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
  }
</style>

<!--
  Modal — shared overlay primitive for all dialogs.

  Owns the cross-cutting modal concerns: backdrop, z-index layer (--z-modal),
  Escape-to-close, backdrop click, focus containment (Tab cycles inside the
  dialog), initial focus, focus restore on close, and ARIA dialog semantics.

  The dialog box itself is rendered by the caller so its scoped styles keep
  working. Cards using the standard form-dialog look add class "modal-card"
  to pick up the shared chrome from modal.css.

  Initial focus: the first [autofocus]/[data-autofocus] element inside the
  dialog, falling back to the overlay itself (so dialog-level key handlers
  work without focusing a button — important for confirm dialogs where a
  focused button would double-handle Enter).
-->
<script lang="ts">
  import "./modal.css";
  import type { Snippet } from "svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Extra overlay class(es) — keeps legacy names that e2e selectors target. */
    overlayClass?: string;
    /** "center" (default) for form dialogs, "top" for palette-style surfaces. */
    align?: "center" | "top";
    /** Top padding in "top" alignment (default 10vh). */
    topOffset?: string;
    role?: "dialog" | "alertdialog";
    label?: string;
    labelledby?: string;
    describedby?: string;
    /** Close when the backdrop is clicked (default true). */
    closeOnBackdrop?: boolean;
    /** Close on Escape (default true). Disable to handle Escape in `onkeydown`. */
    closeOnEscape?: boolean;
    /** Keydown events not consumed by Escape/Tab handling. */
    onkeydown?: (event: KeyboardEvent) => void;
    children: Snippet;
  }

  let {
    open,
    onClose,
    overlayClass = "",
    align = "center",
    topOffset = "10vh",
    role = "dialog",
    label,
    labelledby,
    describedby,
    closeOnBackdrop = true,
    closeOnEscape = true,
    onkeydown,
    children,
  }: Props = $props();

  let overlayRef = $state<HTMLElement | null>(null);

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(): HTMLElement[] {
    if (!overlayRef) return [];
    return [...overlayRef.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      // offsetParent is null for display:none subtrees (e.g. inactive tabs)
      (el) => el.offsetParent !== null
    );
  }

  /** Keep Tab inside the dialog: cycle through focusable elements. */
  function trapTab(event: KeyboardEvent): void {
    const els = focusables();
    event.preventDefault();
    if (els.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const index = active ? els.indexOf(active) : -1;
    const next = event.shiftKey
      ? index <= 0
        ? els[els.length - 1]
        : els[index - 1]
      : index === -1 || index === els.length - 1
        ? els[0]
        : els[index + 1];
    next.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      trapTab(event);
      return;
    }
    onkeydown?.(event);
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (closeOnBackdrop && event.target === event.currentTarget) {
      onClose();
    }
  }

  // Initial focus + focus restore. Deferred a tick so caller-side autofocus
  // effects win; only claims focus if it still sits outside the dialog.
  $effect(() => {
    if (!open || !overlayRef) return;
    const ref = overlayRef;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      if (ref.isConnected && !ref.contains(document.activeElement)) {
        const target =
          ref.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? ref;
        target.focus();
      }
    });
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={overlayRef}
    class="modal-overlay {overlayClass}"
    class:top-aligned={align === "top"}
    style:--modal-top-offset={topOffset}
    {role}
    aria-modal="true"
    aria-label={label}
    aria-labelledby={labelledby}
    aria-describedby={describedby}
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}
  >
    {@render children()}
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--z-modal, 1000);
    animation: modal-overlay-in 150ms cubic-bezier(0, 0, 0, 1);
    outline: none;
  }

  .modal-overlay.top-aligned {
    align-items: flex-start;
    padding-top: var(--modal-top-offset, 10vh);
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: none;
    /* Palette-style surfaces open on a keystroke mid-flow; the overlay fade
       delays legibility and reads as input lag (#234). */
    animation: none;
  }

  @keyframes modal-overlay-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-color-scheme: dark) {
    .modal-overlay {
      background: rgba(0, 0, 0, 0.5);
    }

    .modal-overlay.top-aligned {
      background: rgba(0, 0, 0, 0.4);
    }
  }
</style>

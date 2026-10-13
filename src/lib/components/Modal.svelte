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
  import { modalOwnership } from "$lib/state/modal-ownership.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { getDialogPresentation } from "$lib/state/dialog-presentation-context";
  import { canRestoreModalFocus as canRestoreFocus, createPaneDialogFocusRestore } from "$lib/state/modal-focus";
  import { untrack, type Snippet } from "svelte";

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
    /** Retain input ownership when a global close cannot cancel pending work. */
    canClose?: () => boolean;
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
    canClose = () => true,
    onkeydown,
    children,
  }: Props = $props();

  let overlayRef = $state<HTMLElement | null>(null);
  const presentation = getDialogPresentation();
  const scope = presentation?.scope ?? null;
  let ownership = $state.raw<ReturnType<typeof modalOwnership.registerSurface> | null>(null);
  const top = $derived(ownership?.isTop() ?? false);
  let lastFocused: HTMLElement | null = null;

  $effect(() => {
    if (!open) return;
    const owner = untrack(() => modalOwnership.registerSurface((event) => {
      if (event) handleKeydown(event);
      else if (canClose()) onClose();
      focusOwnedSurface();
    }, () => canClose(), focusOwnedSurface, {
      scope, presentation: presentation?.presentation,
      available: () => presentation?.visible ?? true,
      element: () => overlayRef, focus: focusOwnedSurface,
    }));
    ownership = owner;
    return () => { owner.release(); ownership=null; };
  });

  // `:not([tabindex="-1"])` on every clause so an element opted out of the tab
  // order (e.g. a mouse-only affordance reachable another way) is skipped by the
  // trap too — matching native Tab behavior instead of just the [tabindex] rule.
  const FOCUSABLE =
    'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), ' +
    'input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), ' +
    'textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

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
    if (!ownership?.isTop()) return;
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      event.stopPropagation();
      if (canClose()) onClose();
      return;
    }
    if (event.key === "Tab" && !scope) {
      trapTab(event);
      return;
    }
    onkeydown?.(event);
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (!ownership?.isTop()) return;
    if (canClose() && closeOnBackdrop && event.target === event.currentTarget) {
      onClose();
    }
  }

  // Initial focus + focus restore. Deferred a tick so caller-side autofocus
  // effects win; only claims focus if it still sits outside the dialog.
  $effect(() => {
    if (!open || !overlayRef) return;
    const ref = overlayRef;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scope && presentation) return createPaneDialogFocusRestore(ref, previous, scope.paneId, {
      isActive: () => presentation.isActive(),
      isUncovered: () => !dialogStore.isPaneBlocked(scope.paneId),
      focusUncovered: () => presentation.focusUncovered(),
    });
    return () => {
      if (previous && canRestoreFocus(previous)) {
        previous.focus();
      } else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        // Let removal return focus to the document instead of retaining a
        // hidden control that continues to claim keyboard input.
        document.activeElement.blur();
      }
    };
  });
  // A global key may arrive while focus is on the document (e.g. after a
  // disabled control lost focus). Restore the owning surface after a veto.
  function focusOwnedSurface(): void {
    const ref = overlayRef;
    if (!ref) return;
    queueMicrotask(() => {
      if (!ownership?.isTop() || (scope && !presentation?.isActive()) || !ref.isConnected || ref.contains(document.activeElement)) return;
      const remembered = lastFocused;
      const preferred = ref.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      const target = remembered && ref.contains(remembered) && canRestoreFocus(remembered)
        ? remembered
        : preferred && canRestoreFocus(preferred) ? preferred : ref;
      target.focus();
    });
  }

  $effect(() => {
    if (open && overlayRef && top && (!scope || presentation?.isActive())) focusOwnedSurface();
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={overlayRef}
    class="modal-overlay {overlayClass}"
    class:top-aligned={align === "top"}
    class:suspended={!top}
    class:pane-scoped={!!scope}
    style:--modal-top-offset={topOffset}
    role={scope ? "dialog" : role}
    aria-modal={top && !scope ? "true" : undefined}
    aria-hidden={!top ? "true" : undefined}
    inert={!top}
    aria-label={label}
    aria-labelledby={labelledby}
    aria-describedby={describedby}
    tabindex="-1"
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}
    onfocusin={(event)=>{ if(top && event.target instanceof HTMLElement) lastFocused=event.target; }}
  >
    {@render children()}
  </div>
{/if}

<style>
  .modal-overlay.suspended { visibility:hidden; pointer-events:none; }
  .modal-overlay.pane-scoped { position: absolute; }
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--z-modal, 1000);
    outline: none;
  }

  /* Keep the blurred backdrop static. Ending opacity/transform animations on
     it or its contents can drop a WebKitGTK surface for a frame (#1080).
     Installed plugins may ship older entrance CSS; the modal owns their safe
     entrance without requiring every plugin to ship a matching fix. */
  .modal-overlay > :global(.plugin-dialog) {
    animation: modal-card-in 150ms cubic-bezier(0, 0, 0, 1);
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

  @media (prefers-reduced-motion: reduce) {
    .modal-overlay > :global(.plugin-dialog) { animation: none; }
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

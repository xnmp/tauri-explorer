/**
 * Anchor state for the git graph's commit context menu and its "all
 * references" disclosure (#405, #432, #1082). Must be called during
 * component initialisation: it installs the viewport clamp and the
 * disclosure focus/visibility effects.
 *
 * - Pointer menus open at the cursor, converted with clientToFixed so the
 *   position:fixed menu does not drift under CSS zoom (#221).
 * - A disclosure opened from a row's references button keeps its trigger
 *   and the scroller position captured when it opened. Actions chosen inside
 *   it inherit that anchor, so a scroll notification that arrives after the
 *   click for already-applied positioning does not dismiss it; real movement
 *   does (graphViewportMoved). Focus moves into it without scrolling.
 */
import { clientToFixed } from "$lib/domain/zoom";
import { clampMenuPosition } from "$lib/domain/git-graph-view";
import { graphViewportMoved, type GraphViewportPosition, type RemoteRefChip } from "$lib/domain/git-graph";
import type { GraphCommit } from "$lib/state/git-graph-cache";

export interface MenuAnchor {
  x: number;
  y: number;
  commit: GraphCommit;
  trigger?: HTMLElement;
  viewport?: GraphViewportPosition;
}
export interface ActionMenu extends MenuAnchor {
  kind: "actions";
  /** Branch to attach on Checkout, or null → detached checkout of the OID. */
  checkoutBranch: string | null;
  /** Set when the menu was opened from a specific branch badge (#405):
   *  branch-scoped entries (Delete Branch) show only this branch. */
  scopedBranch: string | null;
  /** Set when opened from a remote-only branch chip (#432): the menu offers
   *  a tracking checkout (`git checkout -b <branch> --track <remote>/<branch>`). */
  remote: RemoteRefChip | null;
  /** Set when opened directly from a tag chip. */
  scopedTag: string | null;
}
export type GraphMenu = ActionMenu | (MenuAnchor & { kind: "references" });

export interface GitGraphMenuOptions {
  /** The graph's scroll viewport (references disclosures capture it). */
  scroller: () => HTMLElement | null;
  /** Local branch at an oid, the default Checkout target. */
  localBranchAt: (oid: string) => string | null;
  /** Whether a commit's row is currently rendered. */
  isRowRendered: (oid: string) => boolean;
  /** Find a rendered commit by the row's `data-oid` (short oid). */
  commitForShortOid: (shortOid: string) => GraphCommit | undefined;
  isSynthetic: (commit: GraphCommit) => boolean;
  /** Runs whenever a menu opens (dismisses competing name prompts). */
  onOpen: () => void;
  /** Close the menu and anything it owns. */
  close: () => void;
}

export function useGitGraphMenu(options: GitGraphMenuOptions) {
  let menu = $state<GraphMenu | null>(null);
  let menuEl = $state<HTMLElement | null>(null);

  // Keep the menu on screen (VSCode behavior): after it renders, pull it back
  // inside the viewport, in the same fixed-CSS space as the cursor coords.
  $effect(() => {
    const m = menu;
    const el = menuEl;
    if (!m || !el) return;
    const { x, y } = clampMenuPosition(
      { x: m.x, y: m.y },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: clientToFixed(window.innerWidth), height: clientToFixed(window.innerHeight) },
    );
    if (x !== m.x || y !== m.y) menu = { ...m, x, y };
  });

  $effect(() => {
    if (!menu?.trigger) return;
    if (!options.isRowRendered(menu.commit.oid)) {
      options.close();
      return;
    }
    menuEl?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });

  function openMenu(
    event: MouseEvent,
    commit: GraphCommit,
    scopedBranch: string | null = null,
    remote: RemoteRefChip | null = null,
    scopedTag: string | null = null,
  ): void {
    event.preventDefault();
    options.onOpen();
    // Choosing a ref inside an anchored disclosure inherits its anchor.
    const trigger = menuEl?.contains(event.currentTarget as Node) ? menu?.trigger : undefined;
    menu = {
      kind: "actions",
      trigger,
      viewport: trigger ? menu?.viewport : undefined,
      x: clientToFixed(event.clientX),
      y: clientToFixed(event.clientY),
      commit,
      checkoutBranch: scopedBranch ?? options.localBranchAt(commit.oid),
      scopedBranch,
      remote,
      scopedTag,
    };
  }

  function openReferences(event: MouseEvent, commit: GraphCommit): void {
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    event.preventDefault();
    options.onOpen();
    const scroller = options.scroller();
    menu = { kind: "references", commit, trigger,
      viewport: { top: scroller?.scrollTop ?? 0, left: scroller?.scrollLeft ?? 0 },
      x: clientToFixed(rect.left), y: clientToFixed(rect.bottom) };
  }

  return {
    get menu() { return menu; },
    get menuEl() { return menuEl; },
    set menuEl(value: HTMLElement | null) { menuEl = value; },
    dismiss(): void { menu = null; },
    openMenu,
    openReferences,
    /** Whether an anchored disclosure's viewport moved since it opened. */
    anchorMoved(position: GraphViewportPosition): boolean {
      return !!(menu?.trigger && menu.viewport && graphViewportMoved(menu.viewport, position));
    },
    /** Right-click on the backdrop: open the menu for the commit row under
     *  the cursor in ONE click (instead of the first click merely cancelling
     *  the previous menu, #263). Falls back to closing over non-commit areas. */
    backdropContextMenu(event: MouseEvent): void {
      event.preventDefault();
      const row = document
        .elementsFromPoint(event.clientX, event.clientY)
        .find((el) => el.classList.contains("commit-row")) as HTMLElement | undefined;
      const commit = row?.dataset.oid ? options.commitForShortOid(row.dataset.oid) : undefined;
      if (commit && !options.isSynthetic(commit)) {
        openMenu(event, commit);
      } else {
        options.close();
      }
    },
  };
}

export type GitGraphMenu = ReturnType<typeof useGitGraphMenu>;

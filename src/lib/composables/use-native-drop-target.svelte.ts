/**
 * Position-based drop target detection.
 *
 * Two coordinate spaces:
 * - onDragDropEvent (Tauri): physical pixels → divide by DPR once
 * - PointerEvent.clientX/Y: client pixels → use directly for hit testing
 */

import { getZoomFactor } from "$lib/domain/zoom";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { fileDropTargets, type RegisteredDropTarget } from "$lib/state/file-drop-targets.svelte";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { springRowOf } from "$lib/domain/spring-rows";

export type DropTargetResult =
  | RegisteredDropTarget
  /** `spring`: a row inside a drag's temporary peek, redirected to its folder (#1242). */
  | { type: "folder"; path: string; domMoveOnly?: true; spring?: true }
  | { type: "bookmark"; path: string }
  | { type: "tab"; tabId: string; path: string }
  | { type: "background"; path?: string; miller?: true; domDisabled?: true }
  | { type: "sidebar" }
  | { type: "terminal" }
  | null;

let highlightedElement: HTMLElement | null = null;
let highlightRevision = 0;

function notifyBookmarkDropTarget(isBookmarkTarget: boolean): void {
  if (typeof document === "undefined" || typeof document.dispatchEvent !== "function" || typeof CustomEvent === "undefined") return;
  document.dispatchEvent(new CustomEvent("explorer-bookmark-drop-target", { detail: { isBookmarkTarget } }));
}

// Tauri onDragDropEvent gives physical pixels. elementFromPoint in
// WebKitGTK expects viewport coordinates (DPR-adjusted, no zoom).
function adjustForHitTest(pos: { x: number; y: number }): { x: number; y: number } {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  return { x: pos.x / dpr, y: pos.y / dpr };
}

export function adjustForPointerZoom(pos: { x: number; y: number }): { x: number; y: number } {
  const zoom = getZoomFactor();
  if (zoom === 1) return pos;
  return { x: pos.x / zoom, y: pos.y / zoom };
}

/** Every surface has an owner. Tabs target their active pane even though the
 * strip is outside its DOM; other window chrome has explicit window ownership. */
export function resolveDropOwner(element: Element | null): string | null {
  const tabId = element?.closest?.(".tab[data-tab-id]")?.getAttribute("data-tab-id");
  if (tabId) {
    const tab = windowTabsManager.tabs.find(tab => tab.id === tabId);
    return tab?.kind === "explorer" ? tab.activePaneId : null;
  }
  return element?.closest?.("[data-pane-id]")?.getAttribute("data-pane-id") || null;
}

function isDropOwnerBlocked(element: Element | null, paneId = resolveDropOwner(element)): boolean {
  // CSS suspension can lag ownership. Only the live owning dialog surface
  // may admit its registered targets; every covered base surface is blocked.
  return (!!element?.closest?.(".modal-overlay, .pane-dialog-container")
      || dialogStore.hasModalOpen || (paneId !== null && dialogStore.isPaneBlocked(paneId)))
    && (!element || !modalOwnership.ownsInput(element, dialogStore.hasModalOpen ? null : undefined));
}

function peekDropSurface(el: Element): HTMLElement | null {
  if ((el as HTMLElement).closest?.(".entry-item")) return null;
  return (el as HTMLElement).closest?.(".peek-drop-target[data-path]") ?? null;
}

/** A row, row wrapper, peek-state row or bridge inside a drag's temporary
 * peek targets that peek's folder (a directory row's wrapper: that directory)
 * (#1242); elsewhere such rows keep their ordinary behaviour. The row is read
 * by the same resolver as the spring hover (`springRowOf`). */
function springDropTarget(el: Element): DropTargetResult {
  const row = typeof (el as HTMLElement).closest === "function" ? springRowOf(el) : null;
  if (!row) return null;
  const paneId = (el as HTMLElement).closest("[data-pane-id]")?.getAttribute("data-pane-id");
  const explorer = paneId ? windowTabsManager.getExplorer(paneId) : undefined;
  if (!explorer?.springPeeks.length) return null;
  const folder = row.kind === "bridge" ? (explorer.isSpringPeek(row.path) ? row.path : null)
    : explorer.springDropFolder(row.path, row.kind);
  return folder ? { type: "folder", path: folder, spring: true } : null;
}

/** DOM drag events whose spring redirect the window capture accepted. They
 * still bubble, so a card or panel surface under them retires its own folder
 * feedback; the pane background, which would claim them, leaves them alone. */
const springClaims = new WeakSet<Event>();
export function claimSpringEvent(event: Event): void { springClaims.add(event); }
export function isSpringClaimed(event: Event): boolean { return springClaims.has(event); }

export function resolveDropTargetFromElement(el: Element | null): DropTargetResult {
  if (isDropOwnerBlocked(el)) return { type: "blocked" };
  if (!el) return null;
  const registered = fileDropTargets.resolve(el);
  if (registered) return registered;

  // Embedded terminal: dropping types the paths into the shell prompt (#265).
  const terminal = (el as HTMLElement).closest?.(".terminal-panel");
  if (terminal) return { type: "terminal" };

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]");
  if (folderEntry) {
    const path = folderEntry.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  // A List card's own surface or a peek pseudo-row is its folder (#1240);
  // file rows inside a card stay non-targets, as everywhere else.
  const peekSurface = peekDropSurface(el);
  if (peekSurface) {
    const path = peekSurface.getAttribute("data-path");
    if (path) return { type: "folder", path };
  }

  const spring = springDropTarget(el);
  if (spring) return spring;

  // Miller column directory entries
  const millerEntry = (el as HTMLElement).closest?.(".col-entry[data-path]");
  if (millerEntry) {
    const kind = millerEntry.getAttribute("data-kind");
    const path = millerEntry.getAttribute("data-path");
    if (kind === "directory" && path) return { type: "folder", path };
  }

  // Breadcrumb segment — drop into that ancestor directory.
  const crumb = (el as HTMLElement).closest?.(".crumb[data-path]");
  if (crumb) {
    const path = crumb.getAttribute("data-path");
    if (path) return { type: "folder", path, domMoveOnly: true };
  }

  // Preserve bookmark identity: files move into its folder, while folders pin.
  const bookmark = (el as HTMLElement).closest?.(".bookmark-drop-target[data-path]");
  if (bookmark) {
    const path = bookmark.getAttribute("data-path");
    if (path) return { type: "bookmark", path };
  }

  const sidebar = (el as HTMLElement).closest?.(".quick-access");
  if (sidebar) return { type: "sidebar" };

  // Tab bar — drop files into the tab's directory
  const tabEl = (el as HTMLElement).closest?.(".tab[data-tab-id]");
  if (tabEl) {
    const tabId = tabEl.getAttribute("data-tab-id");
    if (tabId) {
      const path = windowTabsManager.getTabPath(tabId);
      if (path) return { type: "tab", tabId, path };
    }
  }

  // Miller column background (empty space)
  const millerCol = (el as HTMLElement).closest?.(".miller-col[data-path]");
  if (millerCol) {
    const path = millerCol.getAttribute("data-path") || undefined;
    return { type: "background", path, miller: true,
      ...((el as HTMLElement).closest?.(".col-entry") ? { domDisabled: true as const } : {}) };
  }

  // Plugin file views own their surface: no implicit move into the folder.
  if ((el as HTMLElement).closest?.(".plugin-file-view")) return { type: "blocked" };

  const fileList = (el as HTMLElement).closest?.(".content");
  if (fileList) {
    const path = fileList.getAttribute("data-current-path") || undefined;
    return { type: "background", path,
      ...((el as HTMLElement).closest?.(".entry-item") ? { domDisabled: true as const } : {}) };
  }

  return null;
}

/** A delayed DOM fallback belongs to the surface and resources at drop time.
 * A temporary peek's row unmounts once the drag ends (#1242), so a spring
 * target is its captured folder in the same, unnavigated pane. */
export function captureDropDestination(element: Element | null, fallbackExplorer?: ExplorerInstance): () => boolean {
  const target = resolveDropTargetFromElement(element);
  const ancestors: { node: Element; parent: Element | null; attributes: (string | null)[] }[] = [];
  const names = ["data-pane-id", "data-current-path", "data-path", "data-tab-id"];
  for (let node = element; node; node = node.parentElement) {
    ancestors.push({ node, parent: node.parentElement, attributes: names.map(name => node!.getAttribute(name)) });
  }
  const paneId = resolveDropOwner(element);
  const explorer = paneId ? windowTabsManager.getExplorer(paneId)
    : (!target || (target.type === "background" && !target.path)) ? fallbackExplorer : undefined;
  const lease = explorer?.captureMutation();
  if (target?.type === "folder" && target.spring) {
    return () => windowTabsManager.getExplorer(paneId!) === explorer && !!lease?.current() && !isDropOwnerBlocked(null, paneId);
  }
  // Exact registration identity is its generation; replacement on the same
  // DOM node cannot receive a previous registration's gesture.
  const sameTarget = (current: DropTargetResult) => {
    if (current?.type === "blocked") return false;
    if (!target || !current) return target === current;
    if (target.type === "plugin") return current.type === "plugin" && current.registration === target.registration && target.registration.live();
    return current.type === target.type && JSON.stringify(current) === JSON.stringify(target);
  };
  return () => !!element?.isConnected
    && ancestors.every(({ node, parent, attributes }) => node.parentElement === parent && names.every((name, i) => node.getAttribute(name) === attributes[i]))
    && resolveDropOwner(element) === paneId
    && !isDropOwnerBlocked(element, paneId)
    && (paneId === null || windowTabsManager.getExplorer(paneId) === explorer)
    && (!lease || lease.current())
    && sameTarget(resolveDropTargetFromElement(element));
}

/** The element under an onDragDropEvent position (physical pixels). */
export function elementAtNativePosition(position: { x: number; y: number }): Element | null {
  const adjusted = adjustForHitTest(position);
  return document.elementFromPoint(adjusted.x, adjusted.y);
}

/** Resolve drop target from onDragDropEvent position (physical pixels). */
export function resolveDropTarget(position: { x: number; y: number }): DropTargetResult {
  return resolveDropTargetFromElement(elementAtNativePosition(position));
}

/** The element under pointer event coordinates (CSS viewport pixels). */
export function elementAtPoint(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

/** Resolve drop target from pointer event coordinates (CSS viewport pixels). */
export function resolveDropTargetAtPoint(x: number, y: number): DropTargetResult {
  return resolveDropTargetFromElement(elementAtPoint(x, y));
}

/** Highlight target from onDragDropEvent position (physical pixels). */
export function highlightTarget(position: { x: number; y: number }): void {
  const adjusted = adjustForHitTest(position);
  highlightAtCoords(adjusted.x, adjusted.y);
}

/** Highlight target from pointer event coordinates (CSS viewport pixels). */
export function highlightTargetAtPoint(x: number, y: number): void {
  highlightAtCoords(x, y);
}

function highlightAtCoords(cx: number, cy: number): void {
  highlightTargetElement(document.elementFromPoint(cx, cy));
}

/** The element showing a spring redirect's feedback: the folder's own card or
 * panel surface around the row, else the folder's row in the same listing. */
function springHighlightElement(el: Element, folder: string): HTMLElement | null {
  const content = (el as HTMLElement).closest?.(".content") as HTMLElement | null;
  for (let node = el as HTMLElement | null; node && node !== content; node = node.parentElement) {
    if (node.classList?.contains("peek-drop-target") && node.getAttribute("data-path") === folder) return node;
  }
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(folder) : folder.replace(/["\\]/g, "\\$&");
  return content?.querySelector<HTMLElement>(`.entry-item.directory[data-path="${escaped}"], .peek-drop-target[data-path="${escaped}"]`) ?? null;
}

/** Highlight the drop target an element resolves to (DOM drag events). */
export function highlightTargetElement(el: Element | null): void {
  highlightRevision++;
  if (!el) {
    clearHighlights();
    clearSidebarHighlight();
    notifyBookmarkDropTarget(false);
    return;
  }
  const registered = resolveDropTargetFromElement(el);
  if (registered?.type === "plugin" || registered?.type === "blocked") {
    clearSidebarHighlight();
    notifyBookmarkDropTarget(false);
    setHighlightedElement(registered.type === "plugin" ? registered.registration.element : null);
    return;
  }

  const folderEntry = (el as HTMLElement).closest?.(".entry-item.directory[data-path]") as HTMLElement | null;
  const millerEntry = (el as HTMLElement).closest?.(".col-entry[data-kind='directory'][data-path]") as HTMLElement | null;
  const millerCol = (el as HTMLElement).closest?.(".miller-col[data-path]") as HTMLElement | null;
  const tabEl = (el as HTMLElement).closest?.(".tab[data-tab-id]") as HTMLElement | null;
  const crumbEl = (el as HTMLElement).closest?.(".crumb[data-path]") as HTMLElement | null;
  const bookmarkEl = (el as HTMLElement).closest?.(".bookmark-drop-target[data-path]") as HTMLElement | null;
  const sidebarEl = (el as HTMLElement).closest?.(".quick-access") as HTMLElement | null;
  const terminalEl = (el as HTMLElement).closest?.(".terminal-panel") as HTMLElement | null;
  const peekSurface = peekDropSurface(el);
  if (registered?.type === "folder" && registered.spring) {
    clearSidebarHighlight();
    notifyBookmarkDropTarget(false);
    setHighlightedElement(springHighlightElement(el, registered.path));
    return;
  }
  const targetEl = terminalEl || folderEntry || peekSurface || millerEntry || tabEl || crumbEl || bookmarkEl || millerCol || (!sidebarEl ? (el as HTMLElement).closest?.(".content") as HTMLElement | null : null);

  if (sidebarEl) {
    setHighlightedElement(targetEl);
    setSidebarHighlight(sidebarEl);
    notifyBookmarkDropTarget(bookmarkEl !== null);
  } else {
    clearSidebarHighlight();
    notifyBookmarkDropTarget(false);
    setHighlightedElement(targetEl);
  }
}

function setHighlightedElement(element: HTMLElement | null): void {
  if (element !== highlightedElement) {
    highlightedElement?.classList.remove("drop-target");
    highlightedElement = element;
  }
  if (element && !element.classList.contains("drop-target")) element.classList.add("drop-target");
}

let highlightedSidebar: HTMLElement | null = null;

function setSidebarHighlight(el: HTMLElement): void {
  if (el === highlightedSidebar) return;
  clearSidebarHighlight();
  highlightedSidebar = el;
  el.classList.add("drag-over");
}

function clearSidebarHighlight(): void {
  if (highlightedSidebar) {
    highlightedSidebar.classList.remove("drag-over");
    highlightedSidebar = null;
  }
}

export function clearHighlights(): void {
  highlightRevision++;
  if (highlightedElement) {
    highlightedElement.classList.remove("drop-target");
    highlightedElement = null;
  }
  clearSidebarHighlight();
  notifyBookmarkDropTarget(false);
}

/** An async drop only owns the feedback present when it was claimed. */
export function captureHighlightCleanup(): () => void {
  const revision = highlightRevision;
  return () => { if (revision === highlightRevision) clearHighlights(); };
}

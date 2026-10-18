/**
 * The row under a drag for spring-loaded peeks (#1242). One resolver serves the
 * hover observation (`spring-load-driver.ts`) and the drop redirect
 * (`use-native-drop-target.svelte.ts`), so the two cannot disagree about which
 * row a hit belongs to. A Details row wrapper (`[data-row-path]`, hit at a
 * row's pixel-snapped edge under fractional scaling or zoom) resolves like the
 * row it wraps.
 */

/** The DOM surface read, so resolution is testable without a DOM. */
export interface SpringHitElement {
  closest(selector: string): SpringHitElement | null;
  getAttribute(name: string): string | null;
}

/** `bridge`: a transparent region that belongs to a temporary peek (a Tiles band
 * gap, a stacked panel's channel or ribbon, a List card's wrap path). */
export type SpringRowKind = "directory" | "file" | "state" | "bridge";
export interface SpringRow { readonly path: string; readonly kind: SpringRowKind }

const ROWS = ".entry-item[data-path], [data-row-path], [data-peek-state], [data-spring-bridge]";
const DIRECTORY = ".entry-item.directory[data-path]";

/** The nearest row identity containing `element`, or null. A peek-state row and a
 * bridge are named by their folder. */
export function springRowOf(element: SpringHitElement | null): SpringRow | null {
  const row = element?.closest(ROWS);
  if (!row) return null;
  const bridge = row.getAttribute("data-spring-bridge");
  if (bridge) return { path: bridge, kind: "bridge" };
  const state = row.getAttribute("data-peek-state");
  if (state) return { path: state, kind: "state" };
  const wrapped = row.getAttribute("data-row-path");
  if (wrapped !== null) {
    const kind = row.getAttribute("data-row-kind");
    return wrapped && (kind === "directory" || kind === "file" || kind === "state") ? { path: wrapped, kind } : null;
  }
  const path = row.getAttribute("data-path");
  return path ? { path, kind: row.closest(DIRECTORY) === row ? "directory" : "file" } : null;
}

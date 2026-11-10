/**
 * Dragging items out of the in-app Trash (#1554). Trash entries have no
 * filesystem path until restored, so a drop never moves them by path: it
 * restores their opaque IDs into the destination folder (ADR 0019). Pure
 * routing only; the restore itself lives in the lazy `state/trash-location.ts`.
 */
import { TRASH_PATH, isVirtualPath } from "./virtual-path";

/** The opaque ID behind a Trash entry path (`trash://<id>`), else null. */
export function trashEntryId(path: string): string | null {
  if (!path.startsWith(TRASH_PATH)) return null;
  const id = path.slice(TRASH_PATH.length);
  return id && !/[\\/\0]/.test(id) ? id : null;
}

/**
 * IDs of a drag whose sources are Trash entries. Null when the drag carries
 * no Trash entry (an ordinary file drag); an empty list when it mixes Trash
 * entries with anything else, which no drop may complete.
 */
export function trashDragIds(source: { path?: unknown; paths?: unknown } | null | undefined): string[] | null {
  if (!source) return null;
  const paths = Array.isArray(source.paths) ? source.paths : [source.path];
  if (!paths.some(path => typeof path === "string" && path.startsWith(TRASH_PATH))) return null;
  const ids = paths.map(path => typeof path === "string" ? trashEntryId(path) : null);
  return ids.every((id): id is string => id !== null) ? [...new Set(ids)] : [];
}

export type TrashDropRoute =
  | { kind: "restore"; ids: string[]; destination: string }
  /** Consumed without effect; `message` explains a deliberate refusal. */
  | { kind: "refuse"; message: string | null };

const NO_PATH = "Items in the Trash have no file path until they are restored.";
const DROP_ON_FOLDER = "Drop items from the Trash onto a folder or bookmark to restore them there.";

/**
 * How a drop completes for a Trash drag, or null when `source` is not one.
 * Folders, bookmarks (including for folder sources: a trashed folder is not
 * pinned), tabs and pane backgrounds restore into their real folder. Nothing
 * else can receive a Trash entry, and the copy modifier does not apply.
 */
export function routeTrashDrop(
  source: { path?: unknown; paths?: unknown } | null | undefined,
  target: { type: string; path?: string } | null | undefined,
  fallbackDirectory?: string,
): TrashDropRoute | null {
  const ids = trashDragIds(source);
  if (ids === null) return null;
  if (!ids.length || !target) return { kind: "refuse", message: null };
  let destination: string | undefined;
  switch (target.type) {
    case "folder": case "bookmark": case "tab":
      destination = target.path; break;
    case "background":
      destination = target.path || fallbackDirectory; break;
    case "sidebar":
      return { kind: "refuse", message: DROP_ON_FOLDER };
    case "terminal":
      return { kind: "refuse", message: NO_PATH };
    default:
      return { kind: "refuse", message: null };
  }
  // Dropping back into the Trash (or any provider location) changes nothing.
  // The native command validates the folder itself.
  if (!destination || isVirtualPath(destination)) return { kind: "refuse", message: null };
  return { kind: "restore", ids, destination };
}

/** The dragged row's display name by ID, for outcome messages that are keyed
 * by ID because no destination name was chosen (a stale listing). */
export function trashDragNames(source: { path?: unknown; name?: unknown } | null | undefined): Map<string, string> {
  const id = typeof source?.path === "string" ? trashEntryId(source.path) : null;
  return id && typeof source?.name === "string" ? new Map([[id, source.name]]) : new Map();
}

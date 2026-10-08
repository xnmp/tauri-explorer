import { shortcutsConflict } from "./shortcut-conflicts";

type BindingMap = Readonly<Record<string, string | null | undefined>>;

/** Check the proposed final map, allowing swaps/cycles and rejecting ambiguity.
 * Recheck after rejection: restoring a skipped default can conflict with another import.
 */
export function planShortcutImport(current: BindingMap, candidates: Readonly<Record<string, string | null>>) {
  let accepted = { ...candidates };
  const conflicts: string[] = [];
  while (true) {
    const prospective = { ...current, ...accepted };
    const rejected = Object.entries(accepted).filter(([id, shortcut]) => shortcut !== null &&
      Object.entries(prospective).some(([otherId, other]) => otherId !== id && other && shortcutsConflict(shortcut, other)))
      .map(([id]) => id);
    if (rejected.length === 0) return { accepted, conflicts };
    const rejectedIds = new Set(rejected);
    accepted = Object.fromEntries(Object.entries(accepted).filter(([id]) => !rejectedIds.has(id)));
    conflicts.push(...rejected);
  }
}

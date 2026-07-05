/**
 * Removable-drive tracking (pure). Issue: refactor/audit-tier4-quick-fixes.
 *
 * Inputs are canonical directory keys (forward slashes, no trailing
 * separator, case-folded for Windows — see `directoryKey`), so a single
 * forward-slash containment check covers every separator/case variant.
 */

/** True when `path` is `root` or lies underneath it. */
export function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/**
 * Fold step for the pane's remembered removable drive.
 *
 * - If the path sits under a *present* removable root, remember the longest
 *   such root.
 * - Otherwise keep the previous root while the path is still under it (the
 *   drive was unplugged — that memory is what lets the pane show a
 *   "drive removed" state instead of a generic listing error).
 * - Reset once the user navigates elsewhere.
 *
 * Idempotent for fixed inputs, so re-running it on its own output is safe.
 */
export function nextRemovableRoot(
  previous: string | null,
  pathKey: string,
  presentRoots: readonly string[],
): string | null {
  if (!pathKey) return null;
  const present = presentRoots
    .filter((root) => isUnderRoot(pathKey, root))
    .sort((a, b) => b.length - a.length)[0];
  if (present) return present;
  if (previous && isUnderRoot(pathKey, previous)) return previous;
  return null;
}

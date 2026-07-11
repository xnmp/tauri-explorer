/**
 * Resolve what activating an entry (double-click / Enter) should act on.
 *
 * Windows `.lnk` shortcuts are followed to their target so a shortcut to a
 * folder navigates in-app and a shortcut to a file opens the real target.
 * Everything else passes through unchanged. When a shortcut can't be resolved
 * (missing target, parse failure) we fall back to the shortcut itself, letting
 * the OS shell follow it on open.
 */

import type { FileEntry } from "$lib/domain/file";
import { isShortcut } from "$lib/domain/file-types";
import { resolveShortcut } from "$lib/api/files";
import { basename } from "$lib/domain/path";

export interface ActivationTarget {
  kind: "directory" | "file";
  /** Path to navigate into (directory) or open (file). */
  path: string;
  /** Basename of the path, for display/recents. */
  name: string;
}

export async function resolveActivation(entry: FileEntry): Promise<ActivationTarget> {
  if (isShortcut(entry)) {
    const resolved = await resolveShortcut(entry.path);
    if (resolved?.target) {
      return {
        kind: resolved.isDir ? "directory" : "file",
        path: resolved.target,
        name: basename(resolved.target),
      };
    }
  }
  return { kind: entry.kind, path: entry.path, name: entry.name };
}

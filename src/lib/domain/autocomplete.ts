/**
 * Address-bar path autocomplete logic.
 * Pure functions backing BreadcrumbAutocomplete.svelte.
 */

import type { FileEntry } from "./file";
import { expandTilde, isUncPath } from "./path";

/** A Windows drive path (`C:`, `C:\\…`, `C:/…`). */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/;

/** Maximum suggestions shown in the dropdown. */
export const MAX_SUGGESTIONS = 12;

/**
 * Split a partially-typed path into the directory to list and the name
 * prefix to filter by.
 *
 * `"/home/us"`  → list `"/home/"`, filter by `"us"`
 * `"/home/"`    → list `"/home/"`, filter by `""`
 * `"~/do"`      → tilde-expanded first
 * `"name"`      → list `"/"`, filter by `"name"`
 * `"C:\\Users\\fo"` → list `"C:\\Users\\"`, filter by `"fo"`
 * `"C:"`        → list `"C:/"`, filter by `""`
 *
 * A backslash separates segments only in Windows drive and UNC paths; in a
 * POSIX path it is a legal file-name character and stays in the prefix.
 */
export function parsePathInput(
  input: string,
  homeDir: string | null,
): { parentDir: string; prefix: string } {
  const expanded = expandTilde(input, homeDir);
  if (!expanded || expanded === "/") return { parentDir: "/", prefix: "" };
  const windows = WINDOWS_DRIVE_PATH.test(expanded) || isUncPath(expanded);
  if (windows && /^[A-Za-z]:$/.test(expanded)) return { parentDir: `${expanded}/`, prefix: "" };
  const lastSlash = windows
    ? Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"))
    : expanded.lastIndexOf("/");
  if (lastSlash === expanded.length - 1) return { parentDir: expanded, prefix: "" };
  if (lastSlash < 0) return { parentDir: "/", prefix: expanded };
  return {
    parentDir: expanded.substring(0, lastSlash + 1),
    prefix: expanded.substring(lastSlash + 1),
  };
}

/**
 * Filter directory entries to autocomplete suggestions: directories whose
 * name starts with the prefix (case-insensitive), sorted by name, capped.
 */
export function filterDirectorySuggestions(
  entries: readonly FileEntry[],
  prefix: string,
  limit: number = MAX_SUGGESTIONS,
): FileEntry[] {
  const lowerPrefix = prefix.toLowerCase();
  return entries
    .filter((e) => e.kind === "directory" && e.name.toLowerCase().startsWith(lowerPrefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

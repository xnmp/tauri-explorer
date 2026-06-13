/**
 * Address-bar path autocomplete logic.
 * Pure functions backing BreadcrumbAutocomplete.svelte.
 */

import type { FileEntry } from "./file";
import { expandTilde } from "./path";

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
 */
export function parsePathInput(
  input: string,
  homeDir: string | null,
): { parentDir: string; prefix: string } {
  const expanded = expandTilde(input, homeDir);
  if (!expanded || expanded === "/") return { parentDir: "/", prefix: "" };
  if (expanded.endsWith("/")) return { parentDir: expanded, prefix: "" };
  const lastSlash = expanded.lastIndexOf("/");
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

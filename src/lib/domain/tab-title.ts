/**
 * Tab title disambiguation (VS Code style).
 *
 * A tab's title is the basename of its folder. When two open tabs would show
 * the same basename (e.g. two different `components` folders), we append just
 * enough of each one's parent path to tell them apart — the shortest trailing
 * segment(s) that make every colliding tab unique. Tabs whose basename is
 * already unique keep the bare name.
 *
 * Pure and synchronous so the caller can feed it whatever "identity path" it
 * likes (the folder itself, or a git repo root) and unit-test the result.
 */

export interface TabTitleItem {
  id: string;
  /** The path whose basename is the title; parents disambiguate collisions. */
  path: string;
}

function segments(path: string): string[] {
  return path.split(/[/\\]/).filter(Boolean);
}

/** Label shown for a single item given the parent segments needed to make it
 *  unique within its collision group (empty when the bare basename suffices). */
function formatLabel(base: string, parents: string[]): string {
  return parents.length > 0 ? `${base} · ${parents.join("/")}` : base;
}

/**
 * Map each item id to its display label, disambiguating shared basenames by the
 * shortest distinguishing parent path.
 */
export function disambiguateTabTitles(items: TabTitleItem[]): Map<string, string> {
  const result = new Map<string, string>();

  // Group items by basename; only colliding groups need disambiguation.
  const groups = new Map<string, TabTitleItem[]>();
  for (const item of items) {
    const segs = segments(item.path);
    const base = segs[segs.length - 1] ?? item.path;
    const group = groups.get(base);
    if (group) group.push(item);
    else groups.set(base, [item]);
  }

  for (const [base, group] of groups) {
    // Disambiguate by *distinct* path: items sharing the exact same path (e.g.
    // two tabs on the same cwd) can't be told apart and shouldn't try — they
    // collapse to one and share the bare basename when no other path collides.
    const distinctPaths = [...new Set(group.map((it) => it.path))];
    if (distinctPaths.length === 1) {
      for (const item of group) result.set(item.id, base);
      continue;
    }

    const segArrays = distinctPaths.map(segments);
    const maxLen = Math.max(...segArrays.map((a) => a.length));

    // Smallest tail length k (≥2, includes the basename) that makes every
    // distinct path's tail unique.
    let k = 2;
    for (; k < maxLen; k++) {
      const tails = segArrays.map((a) => a.slice(-k).join("/"));
      if (new Set(tails).size === distinctPaths.length) break;
    }

    const labelByPath = new Map<string, string>();
    distinctPaths.forEach((path, i) => {
      const segs = segArrays[i];
      // Parent segments inside the distinguishing tail, excluding the basename.
      const parents = segs.slice(Math.max(0, segs.length - k), segs.length - 1);
      labelByPath.set(path, formatLabel(base, parents));
    });

    for (const item of group) result.set(item.id, labelByPath.get(item.path)!);
  }

  return result;
}

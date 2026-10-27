/**
 * Lineage peek grouping (docs/execution-plans/lineage-peek.md §3, §5): a
 * provider supplies "file X was made from P, Q" for a folder's files; the host
 * owns the grouping, so it is identical for every provider. Pure: no Svelte,
 * no IO. The tree walk itself is `flattenPeekEntries` (folder-peek.ts), which
 * composes these children with folder peeks.
 */
import type { FileEntry } from "./file";
import { pathComparison } from "./path";

/** A file's lineage parent, as the provider supplies it (SDK `entryLineage`). */
export type LineageParent =
  | { kind: "entry"; path: string }
  | { kind: "external"; key: string; label: string; thumbnailPath?: string };

export interface EntryLineage {
  /** Opaque; equal revisions mean equal lineage. */
  revision: string;
  /** Path of a file in the directory → its lineage parents in input order. */
  parents: ReadonlyMap<string, readonly LineageParent[]>;
}

/** A parent a group shares with the peeked file, after validation. */
export type LineageCoParent =
  | { kind: "entry"; path: string; name: string }
  | { kind: "external"; key: string; label: string; thumbnailPath?: string };

/** The children P shares with other parents S∖P: one group row per distinct S. */
export interface LineageGroup {
  /** Expanded-state id: `group:<P>|<sorted S∖P keys>`. Never contains NUL. */
  id: string;
  /** The peeked file P. */
  parent: string;
  /** S∖P in parent-set order. */
  coParents: readonly LineageCoParent[];
  /** "with B", "with B, C", or "with B, C +2" past three names. */
  label: string;
  /** The first co-parent's thumbnail source, if it has one. */
  thumbnailPath?: string;
  /** Children with exactly this parent set, in the pane's sort. */
  members: readonly FileEntry[];
}

export interface LineageChildren {
  /** Sorted by label. */
  groups: readonly LineageGroup[];
  /** Children made from P alone, in the pane's sort. */
  direct: readonly FileEntry[];
}

export type LineageProjection =
  | {
    kind: "grouped";
    /** Depth 0: files without a present parent, plus ordinary files, in the pane's sort. */
    roots: readonly FileEntry[];
    /** Lineage children of a listed file, by its path; absent for a file without any. */
    children(path: string): LineageChildren | undefined;
    /** Every lineage descendant of `paths` (excluding `paths`), in listing order. */
    descendants(paths: Iterable<string>): string[];
  }
  /** Grouping is off: a cycle (or nothing to group). `reason` "cycle" is counted. */
  | { kind: "flat"; reason: "cycle" | "empty" };

/** External parents can never collide with a path: they are prefixed. */
const externalKey = (key: string) => `external:${key}`;
/** Group ids live in a NUL-separated occurrence key, so strip any NUL. */
const safe = (text: string) => text.replaceAll("\0", "");
const EXTERNAL_MARKER = " ↗";

export function lineageGroupLabel(names: readonly string[]): string {
  if (names.length <= 3) return `with ${names.join(", ")}`;
  return `with ${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Validates the provider's graph against the listing and groups it (§3).
 *
 * - `listing` is the pane's visible depth-0 listing (hidden rules applied),
 *   already in the pane's sort; children keep that order.
 * - `entry` parents not in the listing, and self-edges, are dropped; a parent
 *   listed twice counts once. External parents count in the parent set.
 * - A cycle turns grouping off (`flat`, reason "cycle"); it never throws.
 */
export function projectLineage(listing: readonly FileEntry[], lineage: EntryLineage, windows: boolean): LineageProjection {
  const paths = pathComparison(windows);
  const byKey = new Map<string, FileEntry>();
  const order = new Map<string, number>();
  listing.forEach((entry, index) => {
    const key = paths.key(entry.path);
    if (key !== null && !byKey.has(key)) { byKey.set(key, entry); order.set(key, index); }
  });
  /** Child key → validated parent set (S) in input order. */
  const sets = new Map<string, LineageCoParent[]>();
  /** Child key → its present entry parents' keys. */
  const edges = new Map<string, string[]>();
  for (const [childPath, parents] of lineage.parents) {
    const childKey = paths.key(childPath);
    if (childKey === null || !byKey.has(childKey) || !Array.isArray(parents)) continue;
    const seen = new Set<string>();
    const set: LineageCoParent[] = [];
    const entryParents: string[] = [];
    for (const parent of parents) {
      if (parent?.kind === "entry" && typeof parent.path === "string") {
        const key = paths.key(parent.path);
        const entry = key === null ? undefined : byKey.get(key);
        if (!entry || key === childKey || seen.has(key!)) continue;
        seen.add(key!); entryParents.push(key!);
        set.push({ kind: "entry", path: entry.path, name: entry.name });
      } else if (parent?.kind === "external" && typeof parent.key === "string") {
        const key = externalKey(parent.key);
        if (seen.has(key)) continue;
        seen.add(key);
        set.push({ kind: "external", key: parent.key, label: String(parent.label ?? parent.key),
          ...(typeof parent.thumbnailPath === "string" ? { thumbnailPath: parent.thumbnailPath } : {}) });
      }
    }
    if (!entryParents.length) continue;
    sets.set(childKey, set);
    edges.set(childKey, entryParents);
  }
  if (!edges.size) return { kind: "flat", reason: "empty" };
  if (hasCycle(edges)) return { kind: "flat", reason: "cycle" };

  const keyOf = (parent: LineageCoParent) => parent.kind === "entry" ? paths.key(parent.path)! : externalKey(parent.key);
  const nameOf = (parent: LineageCoParent) => parent.kind === "entry" ? parent.name : `${parent.label}${EXTERNAL_MARKER}`;
  const byOrder = (a: string, b: string) => order.get(a)! - order.get(b)!;
  const direct = new Map<string, string[]>();
  const groups = new Map<string, Map<string, { coParents: LineageCoParent[]; members: string[] }>>();
  for (const [childKey, set] of sets) {
    for (const parentKey of edges.get(childKey)!) {
      if (set.length === 1) {
        const list = direct.get(parentKey);
        if (list) list.push(childKey); else direct.set(parentKey, [childKey]);
        continue;
      }
      const coParents = set.filter(parent => keyOf(parent) !== parentKey);
      const id = safe(`group:${byKey.get(parentKey)!.path}|${coParents.map(keyOf).sort().join("|")}`);
      const forParent = groups.get(parentKey) ?? new Map();
      groups.set(parentKey, forParent);
      const group = forParent.get(id) ?? { coParents, members: [] };
      group.members.push(childKey);
      forParent.set(id, group);
    }
  }
  const children = new Map<string, LineageChildren>();
  for (const parentKey of new Set([...direct.keys(), ...groups.keys()])) {
    const parent = byKey.get(parentKey)!.path;
    const parentGroups: LineageGroup[] = [...(groups.get(parentKey) ?? new Map<string, { coParents: LineageCoParent[]; members: string[] }>()).entries()].map(([id, group]) => {
      const first = group.coParents[0];
      const thumbnailPath = first?.kind === "entry" ? first.path : first?.thumbnailPath;
      return {
        id, parent, coParents: group.coParents, label: lineageGroupLabel(group.coParents.map(nameOf)),
        ...(thumbnailPath ? { thumbnailPath } : {}),
        members: group.members.sort(byOrder).map(key => byKey.get(key)!),
      };
    }).sort((a, b) => collator.compare(a.label, b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    children.set(parentKey, { groups: parentGroups, direct: (direct.get(parentKey) ?? []).sort(byOrder).map(key => byKey.get(key)!) });
  }
  const roots = listing.filter(entry => {
    const key = paths.key(entry.path);
    return key === null || !edges.has(key);
  });
  return {
    kind: "grouped",
    roots,
    children(path) {
      const key = paths.key(path);
      return key === null ? undefined : children.get(key);
    },
    descendants(start) {
      const found = new Set<string>();
      const stack = [...start].map(path => paths.key(path)).filter((key): key is string => key !== null);
      const origin = new Set(stack);
      while (stack.length) {
        const of = children.get(stack.pop()!);
        if (!of) continue;
        for (const entry of [...of.groups.flatMap(group => group.members), ...of.direct]) {
          const key = paths.key(entry.path)!;
          if (found.has(key) || origin.has(key)) continue;
          found.add(key); stack.push(key);
        }
      }
      return [...found].sort(byOrder).map(key => byKey.get(key)!.path);
    },
  };
}

/** Kahn's algorithm over child → parents edges. */
function hasCycle(edges: ReadonlyMap<string, readonly string[]>): boolean {
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const [child, parents] of edges) {
    pending.set(child, parents.length);
    for (const parent of parents) {
      if (!pending.has(parent)) pending.set(parent, edges.get(parent)?.length ?? 0);
      const list = dependents.get(parent);
      if (list) list.push(child); else dependents.set(parent, [child]);
    }
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([key]) => key);
  let done = 0;
  while (ready.length) {
    const key = ready.pop()!;
    done++;
    for (const child of dependents.get(key) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return done !== pending.size;
}

/** The parent file of a group id, for pruning expanded state. */
export function lineageGroupParent(id: string): string | null {
  if (!id.startsWith("group:")) return null;
  const at = id.indexOf("|", 6);
  return at < 0 ? null : id.slice(6, at);
}


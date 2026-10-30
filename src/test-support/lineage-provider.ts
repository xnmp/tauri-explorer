/**
 * Browser-test lineage provider (lineage peek e2e). Registers an
 * `entryLineage` contribution the way a plugin's `registerEntryLineage` does,
 * against the mock filesystem, and lets a spec change the lineage and fire
 * `changed` like a provider whose index updated.
 */
import { entryLineageRegistry } from "$lib/plugins/entry-lineage-registry.svelte";
import type { LineageParent } from "$lib/domain/entry-lineage";

let parents = new Map<string, LineageParent[]>();
let revision = 0;
let directory = "";
let loadDelay = 0;
/** File name → provider text (`EntryLineage.labels`, #1449); null sends no labels. */
type Labels = Record<string, { prompt?: string; title?: string }>;
let labels: Labels | null = null;
const listeners = new Set<() => void>();
let dispose: (() => void) | null = null;

/** Child file → parent file names (entries) or `{ external }` labels, all in `dir`. */
export function install(dir: string, lineage: Record<string, (string | { external: string; key: string })[]>, options: { delay?: number; labels?: Labels } = {}): void {
  directory = dir;
  loadDelay = options.delay ?? 0;
  labels = options.labels ?? null;
  parents = toMap(lineage);
  revision++;
  dispose?.();
  dispose = entryLineageRegistry.register("e2e", {
    id: "e2e.lineage",
    title: "Traces",
    available: path => path === directory,
    async load(path, signal) {
      if (loadDelay) await new Promise(resolve => setTimeout(resolve, loadDelay));
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const own = path === directory;
      return {
        revision: String(revision), parents: own ? new Map(parents) : new Map(),
        ...(own && labels ? { labels: new Map(Object.entries(labels).map(([name, text]) => [`${directory}/${name}`, text])) } : {}),
      };
    },
    subscribe(_path, changed) { listeners.add(changed); return () => listeners.delete(changed); },
  });
}

/** Replace the lineage and notify subscribers, as a provider's `changed` does. */
export function update(lineage: Record<string, (string | { external: string; key: string })[]>): void {
  parents = toMap(lineage);
  revision++;
  for (const changed of [...listeners]) changed();
}

export function uninstall(): void { dispose?.(); dispose = null; listeners.clear(); }

function toMap(lineage: Record<string, (string | { external: string; key: string })[]>): Map<string, LineageParent[]> {
  return new Map(Object.entries(lineage).map(([child, list]) => [`${directory}/${child}`, list.map(parent => typeof parent === "string"
    ? { kind: "entry" as const, path: `${directory}/${parent}` }
    : { kind: "external" as const, key: parent.key, label: parent.external })]));
}

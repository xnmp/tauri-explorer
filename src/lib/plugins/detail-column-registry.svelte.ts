/**
 * Plugin Details columns (#1523): the startup-resident read side. Providers
 * are built by `register-contributions.ts` (loaded with a plugin's first
 * registration), each with its own batched resolver, so values load only for
 * rendered rows and are cached per path + revision. A provider's columns are
 * offered only while the rows asked about include an entry it applies to.
 * Removal aborts in-flight loads and forgets cached values.
 */
import type { FileEntry } from "$lib/domain/file";
import type { DetailRowValues, PluginDetailColumn } from "$lib/domain/plugin-detail-columns";
import type { BatchedEntryResolver } from "$lib/state/batched-entry-resolver.svelte";
import { createOrderedRegistry } from "$lib/state/ordered-registry";

interface RegisteredDetailProvider {
  readonly columns: readonly PluginDetailColumn[];
  /** Never throws. */
  readonly applies: (entry: FileEntry) => boolean;
  readonly resolver: BatchedEntryResolver<DetailRowValues | null>;
}

const NONE: readonly PluginDetailColumn[] = [];

function createDetailColumnRegistry() {
  const registrations = createOrderedRegistry<RegisteredDetailProvider>();
  let providers = $state.raw<readonly RegisteredDetailProvider[]>([]);
  let last: { offered: readonly RegisteredDetailProvider[]; columns: readonly PluginDetailColumn[] } = { offered: [], columns: NONE };
  const owners = $derived(new Map(providers.flatMap((provider) => provider.columns.map((column) => [column.id, provider] as const))));

  return {
    add(id: string, provider: RegisteredDetailProvider, order?: number): () => void {
      const dispose = registrations.register(id, provider, order);
      providers = registrations.values();
      return () => {
        if (!dispose()) return;
        provider.resolver.dispose();
        providers = registrations.values();
      };
    },
    /** Reactive: columns of providers that apply to at least one entry. The
     *  same provider set returns the same array, so rows keep a stable prop
     *  across listing refreshes. */
    columnsFor(entries: Iterable<FileEntry>): readonly PluginDetailColumn[] {
      if (!providers.length) return NONE;
      const pending = new Set(providers);
      for (const entry of entries) {
        for (const provider of pending) if (provider.applies(entry)) pending.delete(provider);
        if (!pending.size) break;
      }
      const offered = providers.filter((provider) => !pending.has(provider));
      if (offered.length !== last.offered.length || offered.some((provider, index) => provider !== last.offered[index])) {
        // Provider order, regardless of which entry matched first.
        last = { offered, columns: offered.length ? offered.flatMap((provider) => provider.columns) : NONE };
      }
      return last.columns;
    },
    /** Load a rendered row's values from the providers it needs: those with a
     *  shown column, plus every provider while Length is shown (any of them
     *  may supply `lengthSeconds`). */
    request(entry: FileEntry, shown: readonly PluginDetailColumn[], length: boolean): void {
      for (const provider of providers) {
        if (length || shown.some((column) => owners.get(column.id) === provider)) provider.resolver.request(entry);
      }
    },
    /** Reactive display text, or undefined while loading / when absent. */
    text(entry: FileEntry, column: PluginDetailColumn): string | undefined {
      return owners.get(column.id)?.resolver.value(entry)?.columns?.[column.key];
    },
    /** Reactive Length-column seconds from the first provider that supplies them. */
    lengthSeconds(entry: FileEntry): number | undefined {
      for (const provider of providers) {
        const seconds = provider.resolver.value(entry)?.lengthSeconds;
        if (seconds !== undefined) return seconds;
      }
      return undefined;
    },
    /** Reactive: every provider's resolver, for the folder-wide Length sort
     *  (#1531, `length-sort-requests.svelte.ts`); any may supply `lengthSeconds`. */
    resolvers: () => providers.map((provider) => provider.resolver),
  };
}

export const detailColumnRegistry = createDetailColumnRegistry();

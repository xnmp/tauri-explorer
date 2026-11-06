/**
 * Plugin file icon and Details column registration (#1523), loaded with a
 * plugin's first such contribution so the startup bundle carries only the
 * registries' read paths. Validation is pure (`domain/plugin-contribution-
 * validation.ts`); this module builds the registered values.
 */
import type { FileEntry } from "$lib/domain/file";
import type { FileIconContribution } from "$lib/domain/plugin-file-icon";
import type { DetailColumnProvider, DetailRowValues } from "$lib/domain/plugin-detail-columns";
import { normalizeDetailColumns, normalizeDetailRowValues, normalizeFileIcon } from "$lib/domain/plugin-contribution-validation";
import { BatchedEntryResolver } from "$lib/state/batched-entry-resolver.svelte";
import { fileIconRegistry } from "./file-icon-registry.svelte";
import { detailColumnRegistry } from "./detail-column-registry.svelte";

export function registerFileIcon(id: string, icon: FileIconContribution, order: number): () => void {
  return fileIconRegistry.register(id, normalizeFileIcon(icon), order);
}

/** `report` receives the provider's first applies/load failure only. */
export function registerDetailColumns(id: string, provider: DetailColumnProvider, report: (error: unknown) => void, order: number): () => void {
  if (typeof provider?.applies !== "function" || typeof provider.load !== "function") throw new Error(`Detail columns ${id} needs applies() and load()`);
  const columns = normalizeDetailColumns(id, provider.columns);
  const keys = columns.map((column) => column.key);
  let reported = false;
  const once = (error: unknown) => { if (!reported) { reported = true; report(error); } };
  const applies = (entry: FileEntry) => {
    try { return provider.applies(entry) === true; } catch (error) { once(error); return false; }
  };
  const resolver = new BatchedEntryResolver<DetailRowValues | null>({
    load: (entries, signal) => Promise.resolve().then(() => provider.load(entries, signal))
      .catch((error) => { if (!signal.aborted) once(error); throw error; }),
    normalize: (value) => normalizeDetailRowValues(value, keys),
    failure: null,
    eligible: applies,
  });
  return detailColumnRegistry.add(id, { columns, applies, resolver }, order);
}

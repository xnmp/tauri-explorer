/**
 * Plugin Details columns (#1523). A provider declares columns for the files it
 * `applies` to and loads their values lazily, for rendered rows only — the
 * same contract as the built-in Length and Resolution columns. Contracts
 * only: validation is `plugin-contribution-validation.ts` (loaded lazily on
 * first registration); `plugins/detail-column-registry.svelte.ts` owns loading.
 */
import type { FileEntry } from "./file";

export interface DetailColumnSpec {
  /** Stable within the provider: `[a-z][a-z0-9-]{0,31}`. */
  key: string;
  label: string;
  /** Initial width in CSS pixels (clamped to 60-4096; default 120). */
  width?: number;
}

/** One row's values. Strings are display text; `lengthSeconds` fills the
 *  built-in Length column for files the host cannot measure itself. */
export interface DetailRowValues {
  readonly columns?: Readonly<Record<string, string>>;
  readonly lengthSeconds?: number;
}

export interface DetailColumnProvider {
  /** `<pluginId>.<name>`. */
  id: string;
  columns: readonly DetailColumnSpec[];
  /** Synchronous and cheap (e.g. an extension test); called per listed entry. */
  applies(entry: FileEntry): boolean;
  /** One item per entry, in order; `null` for an unreadable file. Called with
   *  at most 16 entries; `signal` aborts when the plugin deactivates. */
  load(entries: readonly FileEntry[], signal: AbortSignal): Promise<readonly (DetailRowValues | null)[]>;
}

/** A host column: the provider-qualified id is its settings/width key. */
export interface PluginDetailColumn {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly width: number;
}

export const MAX_PROVIDER_COLUMNS = 8;
export const PLUGIN_COLUMN_SIZE = { min: 60, max: 4096 } as const;

/** Persisted visibility (`settings.pluginColumnVisibility`): shown until hidden. */
export const pluginColumnShown = (visibility: Readonly<Record<string, boolean>>, id: string): boolean => visibility[id] !== false;

export const togglePluginColumn = (visibility: Readonly<Record<string, boolean>>, id: string): Record<string, boolean> =>
  ({ ...visibility, [id]: !pluginColumnShown(visibility, id) });

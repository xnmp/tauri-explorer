/**
 * Contribution registry for plugin-provided settings sections.
 *
 * SettingsDialog renders each registered section descriptor-driven
 * (text/password/toggle/select rows). Each section owns a reactive `values`
 * map seeded from the plugin's storage blob and written back through it, so the
 * settings UI stays synchronous while persistence rides the existing config
 * commands.
 */

import type { SettingRowDescriptor, SettingsSectionDescriptor, PluginStorage } from "./api";

export interface RegisteredSettingsSection {
  pluginId: string;
  id: string;
  title: string;
  rows: SettingRowDescriptor[];
  /** Current values keyed by row id (reactive). */
  readonly values: Record<string, unknown>;
  /** Value for a row, falling back to the row's declared default. */
  valueOf(row: SettingRowDescriptor): unknown;
  /** Update a row value and persist the whole blob. */
  setValue(rowId: string, value: unknown): void;
}

function defaultsFrom(rows: SettingRowDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.default !== undefined) out[row.id] = row.default;
  }
  return out;
}

function createSection(
  pluginId: string,
  desc: SettingsSectionDescriptor,
  storage: PluginStorage
): RegisteredSettingsSection {
  const defaults = defaultsFrom(desc.rows);
  let values = $state<Record<string, unknown>>({ ...defaults });

  // Seed from persisted storage (async). Defaults show until it resolves.
  void storage.get().then((stored) => {
    values = { ...defaults, ...stored };
  });

  return {
    pluginId,
    id: desc.id,
    title: desc.title,
    rows: desc.rows,
    get values() {
      return values;
    },
    valueOf(row: SettingRowDescriptor): unknown {
      const v = values[row.id];
      return v !== undefined ? v : row.default;
    },
    setValue(rowId: string, value: unknown): void {
      values = { ...values, [rowId]: value };
      void storage.set(values);
    },
  };
}

function createSettingsRegistry() {
  let sections = $state<RegisteredSettingsSection[]>([]);

  return {
    get sections() {
      return sections;
    },
    /** Register a section; returns a disposer that removes it. */
    register(
      pluginId: string,
      desc: SettingsSectionDescriptor,
      storage: PluginStorage
    ): () => void {
      const section = createSection(pluginId, desc, storage);
      sections = [...sections, section];
      // Remove by (pluginId, id), not object reference: Svelte's `$state` array
      // deep-proxies elements, so the stored section never `===` this `section`.
      return () => {
        sections = sections.filter(
          (s) => !(s.pluginId === section.pluginId && s.id === section.id)
        );
      };
    },
    /** Remove all sections. Test helper. */
    clear(): void {
      sections = [];
    },
  };
}

export const pluginSettingsSections = createSettingsRegistry();

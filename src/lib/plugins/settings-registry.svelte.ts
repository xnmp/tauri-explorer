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
import { createOrderedRegistry } from "$lib/state/ordered-registry";

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
  /** Await persistence for dialogs that must report save failures. */
  save(patch: Record<string, unknown>): Promise<void>;
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
  storage: PluginStorage,
): RegisteredSettingsSection {
  const defaults = defaultsFrom(desc.rows);
  let values = $state<Record<string, unknown>>({ ...defaults });

  // Seed from persisted storage (async). Defaults show until it resolves.
  // Seed race (#154): a user can edit a row before this load resolves. Those
  // edits must win over the stale persisted blob, so we record keys touched
  // while loading and re-apply them ON TOP of the loaded values. Without this,
  // the load would silently clobber the user's in-flight edit.
  let loading = true;
  const editedWhileLoading = new Set<string>();
  const ready = storage
    .get()
    .then((stored) => {
      const preserved: Record<string, unknown> = {};
      for (const key of editedWhileLoading) preserved[key] = values[key];
      values = { ...defaults, ...stored, ...preserved };
    })
    .catch(() => {
      // Load failed — keep the defaults + any edits already applied to `values`.
    })
    .finally(() => {
      loading = false;
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
      if (loading) editedWhileLoading.add(rowId);
      values = { ...values, [rowId]: value };
      void storage.set(values);
    },
    async save(patch: Record<string, unknown>): Promise<void> {
      await ready;
      const next = { ...values, ...patch };
      await (storage.setChecked?.(next) ?? storage.set(next));
      values = next;
    },
  };
}

function createSettingsRegistry() {
  let sections = $state<RegisteredSettingsSection[]>([]);
  const registrations = createOrderedRegistry<RegisteredSettingsSection>();

  return {
    get sections() {
      return sections;
    },
    /** Register a section; returns a disposer that removes it. Sections appear
     *  by `order` (the plugin's list position), then registration; a plugin
     *  registering the same section id twice throws. */
    register(
      pluginId: string,
      desc: SettingsSectionDescriptor,
      storage: PluginStorage,
      order = Number.MAX_SAFE_INTEGER,
    ): () => void {
      const section = createSection(pluginId, desc, storage);
      const dispose = registrations.register(`${pluginId}\u0000${desc.id}`, section, order);
      sections = registrations.values();
      return () => {
        if (dispose()) sections = registrations.values();
      };
    },
    /** Remove all sections. Test helper. */
    clear(): void {
      registrations.clear();
      sections = [];
    },
  };
}

export const pluginSettingsSections = createSettingsRegistry();

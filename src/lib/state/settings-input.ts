/**
 * The persisted-settings input contract: which values read from
 * settings.json / localStorage may enter live state, and which unknown keys
 * are carried through untouched. Pure; the store supplies its defaults.
 * Split out of `settings.svelte.ts` (file-size budget).
 */

import { isFileViewId } from "$lib/domain/file-view-id";
import { NUMERIC_SETTINGS, isValidNumericSetting, type NumericSettingRule } from "$lib/domain/settings-numbers";
import type { Settings } from "./settings.svelte";

export const MAX_PERSISTED_SETTINGS_BYTES = 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Persisted keys this version does not know, kept so a newer version's
 *  settings survive a round trip through this one. */
export function persistedExtras(value: unknown, defaults: Settings): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const known = new Set<string>(Object.keys(defaults));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

export function persistedSettings(settings: Settings, extras: Record<string, unknown>): Record<string, unknown> {
  return { ...extras, ...settings };
}

const SETTING_ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  iconTheme: ["default", "material", "classic", "minimal", "catppuccin"],
  thumbnailSize: ["small", "medium", "large", "xlarge"],
  viewMode: ["details", "list", "tiles"],
  previewPanePosition: ["right", "bottom", "top", "auto"],
  defaultPaneLayout: ["dwindle", "right", "down"],
};

// Exhaustiveness is checked against Settings: a new numeric preference must
// declare its consumer contract in the domain before it can enter live state.
export type NumericSettingsKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];
const SETTING_NUMBER_RULES: Record<NumericSettingsKey, NumericSettingRule> = NUMERIC_SETTINGS;

export function boundedPersistedInput(value: unknown): unknown {
  try {
    return JSON.stringify(value).length <= MAX_PERSISTED_SETTINGS_BYTES ? value : {};
  } catch {
    return {};
  }
}

/** Keep only values satisfying the existing Settings contract. */
export function normalizeSettingsInput(value: unknown, defaults: Settings): Partial<Settings> {
  if (!isRecord(value)) return {};
  const normalized: Partial<Settings> = {};
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    const candidate = value[key];
    const fallback = defaults[key];
    if (candidate === undefined) continue;
    if (key === "terminalShortcuts" || key === "pluginsEnabled" || key === "pluginColumnVisibility") {
      if (!isRecord(candidate)) continue;
      const expected = key === "terminalShortcuts" ? "string" : "boolean";
      (normalized as Record<string, unknown>)[key] = Object.fromEntries(
        Object.entries(candidate).filter(([, entry]) => typeof entry === expected),
      );
      continue;
    }
    if (key === "navBarButtons" || key === "columnVisibility") {
      if (!isRecord(candidate) || !isRecord(fallback)) continue;
      (normalized as Record<string, unknown>)[key] = {
        ...fallback,
        ...Object.fromEntries(
          Object.keys(fallback)
            .filter((nestedKey) => typeof candidate[nestedKey] === typeof fallback[nestedKey])
            .map((nestedKey) => [nestedKey, candidate[nestedKey]]),
        ),
      };
      continue;
    }
    if (typeof fallback === "number") {
      if (isValidNumericSetting(SETTING_NUMBER_RULES[key as NumericSettingsKey], candidate)) {
        (normalized as Record<string, unknown>)[key] = candidate;
      }
      continue;
    }
    if (typeof candidate !== typeof fallback) continue;
    if (key === "defaultFileView" && candidate !== "" && !isFileViewId(candidate as string)) continue;
    const allowed = SETTING_ENUMS[key];
    if (allowed && !allowed.includes(candidate as string)) continue;
    (normalized as Record<string, unknown>)[key] = candidate;
  }
  return normalized;
}

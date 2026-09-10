/** Numeric preferences must satisfy the consumers that render or count them.
 * Persisted data is validated strictly; interactive setters clamp finite input. */
export interface NumericSettingRule {
  min: number;
  max: number;
  integer?: boolean;
  zeroIsDefault?: boolean;
}

export const NUMERIC_SETTINGS = {
  zoomLevel: { min: 50, max: 200 },
  backgroundOpacity: { min: 0, max: 100 },
  backgroundBlur: { min: 0, max: 20 },
  listViewColumns: { min: 0, max: 6, integer: true },
  listColumnMaxWidth: { min: 100, max: 600 },
  previewPaneWidth: { min: 160, max: 600, zeroIsDefault: true },
  previewPaneHeight: { min: 120, max: 600, zeroIsDefault: true },
  terminalPanelHeight: { min: 96, max: 800 },
  recentItemsCount: { min: 0, max: 20, integer: true },
  millerLayers: { min: 0, max: 3, integer: true },
  millerLayersPreferred: { min: 1, max: 3, integer: true },
  windowsBackdropOpacity: { min: 0, max: 100 },
  previewFontSize: { min: 8, max: 28 },
  settingsVersion: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true },
} as const satisfies Record<string, NumericSettingRule>;

export type NumericSettingKey = keyof typeof NUMERIC_SETTINGS;

export function isValidNumericSetting(rule: NumericSettingRule, value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && (!rule.integer || Number.isInteger(value))
    && ((rule.zeroIsDefault === true && value === 0) || (value >= rule.min && value <= rule.max));
}

/** Invalid non-finite input leaves the current preference unchanged. */
export function clampNumericSetting(key: NumericSettingKey, value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const rule: NumericSettingRule = NUMERIC_SETTINGS[key];
  if (rule.zeroIsDefault && value <= 0) return 0;
  const clamped = Math.min(rule.max, Math.max(rule.min, value));
  return rule.integer ? Math.round(clamped) : clamped;
}

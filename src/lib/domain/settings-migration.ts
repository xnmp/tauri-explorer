/**
 * Versioned migrations for the persisted settings blob (#506).
 *
 * WHY THIS EXISTS. Settings persist as a WHOLE object — `saveSettings` writes
 * every key to localStorage and `settings.json`, and loading merges
 * `{ ...DEFAULT_SETTINGS, ...saved }`, so a persisted key always beats its
 * default. Flipping a default therefore reaches NEW installs only; every
 * existing install keeps the old value forever. #471 flipped
 * `tabTitleGitRoot` to `true` and no existing install ever saw it — the
 * git-repo tab icon stayed missing, and the same bug was re-reported as #506.
 *
 * The mechanism: the persisted blob carries a `settingsVersion` stamp. Each
 * entry below names the keys whose persisted value must be dropped in favour
 * of the current default, and runs exactly once per install — on the load
 * that finds a stamp below the entry's version. After that the stamp is at or
 * above it and the entry never fires again, so a user who deliberately
 * changes the setting afterwards keeps their choice.
 *
 * Pure and dependency-free by layering rule (domain must not import
 * $lib/state or $lib/api), so it is generic over the settings shape rather
 * than importing the `Settings` type.
 *
 * WHEN YOU FLIP A DEFAULT: add a migration entry here, or existing installs
 * will silently keep the old value and you will be debugging #471/#506 again.
 */

/** Key holding the schema version inside the persisted settings blob. */
export const SETTINGS_VERSION_KEY = "settingsVersion";

/** One versioned, one-shot correction to a persisted settings blob. */
export interface SettingsMigration {
  /** Applies to installs whose stored stamp is strictly below this. */
  readonly version: number;
  /** Persisted keys to discard in favour of their current default value. */
  readonly resetToDefault: readonly string[];
  /** Why the persisted value must be dropped — cite the issue. */
  readonly reason: string;
}

/** The ledger. Append only; never renumber or remove a shipped entry. */
export const SETTINGS_MIGRATIONS: readonly SettingsMigration[] = [
  {
    version: 1,
    resetToDefault: ["tabTitleGitRoot"],
    reason:
      "#471 flipped tabTitleGitRoot's default to true, but whole-object " +
      "persistence pinned every existing install to the original false, so " +
      "the git-repo tab icon never appeared (#506).",
  },
];

/** Highest shipped migration version — the stamp a migrated blob carries. */
export const CURRENT_SETTINGS_VERSION: number = SETTINGS_MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/** Migrated settings, plus whether anything was rewritten. `changed` is the
 *  signal to persist: false means the caller can skip the write. */
export interface SettingsMigrationResult<T> {
  readonly settings: T;
  readonly changed: boolean;
}

/** A usable persisted blob: JSON objects only. Anything else (a string, an
 *  array, null, a corrupted value) is treated as "nothing persisted". */
function asRecord(value: unknown): Record<string, unknown> {
  const usable = typeof value === "object" && value !== null && !Array.isArray(value);
  return usable ? (value as Record<string, unknown>) : {};
}

/** The stamp on a persisted blob, or 0 when absent or unusable. An unusable
 *  stamp reads as 0 rather than as "already migrated": re-running a
 *  migration is recoverable, skipping one leaves the bug in place. */
function storedVersion(persisted: Record<string, unknown>): number {
  const raw = persisted[SETTINGS_VERSION_KEY];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/**
 * Merge a persisted settings blob over the defaults, applying any migration
 * the blob has not seen yet.
 *
 * Persisted values win, as before — except for the keys named by migrations
 * above the blob's stamp, which fall back to their default. The result
 * carries the higher of the stored and current stamps, so each migration
 * runs at most once per install and a blob written by a newer build is never
 * downgraded.
 *
 * Pure: the inputs are not mutated.
 */
export function migrateSettings<T extends object>(
  persisted: Partial<T> | null | undefined,
  defaults: T,
  migrations: readonly SettingsMigration[] = SETTINGS_MIGRATIONS,
): SettingsMigrationResult<T> {
  const saved = asRecord(persisted);
  const from = storedVersion(saved);
  const target = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const defaulted = defaults as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaulted, ...saved };

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    for (const key of migration.resetToDefault) {
      // hasOwn, not `in`: an entry naming an inherited property (a typo like
      // "toString") must not copy a prototype member onto the blob.
      if (Object.hasOwn(defaulted, key)) merged[key] = defaulted[key];
    }
  }

  merged[SETTINGS_VERSION_KEY] = Math.max(from, target);
  return { settings: merged as T, changed: from < target };
}

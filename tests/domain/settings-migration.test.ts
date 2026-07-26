/**
 * Unit tests for the versioned persisted-settings migration (#506).
 *
 * The bug: settings persist as a whole object and load as
 * `{ ...DEFAULT_SETTINGS, ...saved }`, so #471's flip of
 * `tabTitleGitRoot` to `true` was invisible to every install that had ever
 * saved settings — their persisted `false` kept shadowing it and the
 * git-repo tab icon never appeared.
 *
 * These tests pin the two halves of the contract that matter: a pre-stamp
 * blob adopts the new default, and a stamped blob keeps whatever the user
 * chose (the migration is ONE-SHOT, not a recurring reset).
 */
import { describe, it, expect } from "vitest";
import {
  CURRENT_SETTINGS_VERSION,
  SETTINGS_VERSION_KEY,
  migrateSettings,
  type SettingsMigration,
} from "$lib/domain/settings-migration";

/** Stand-in for the real settings shape: one migrated key, one untouched. */
interface Fixture {
  tabTitleGitRoot: boolean;
  showGitStatus: boolean;
  previewFontSize: number;
  settingsVersion: number;
}

const DEFAULTS: Fixture = {
  tabTitleGitRoot: true,
  showGitStatus: false,
  previewFontSize: 12,
  settingsVersion: CURRENT_SETTINGS_VERSION,
};

describe("migrateSettings — adopting a flipped default (#506)", () => {
  it("drops a pre-stamp persisted tabTitleGitRoot:false so the new default wins", () => {
    // Exactly the blob on a real pre-#471 install: the key is present and
    // false, and there is no settingsVersion at all.
    const { settings, changed } = migrateSettings({ tabTitleGitRoot: false }, DEFAULTS);

    expect(settings.tabTitleGitRoot).toBe(true);
    expect(changed).toBe(true);
  });

  it("stamps the migrated blob with the current version", () => {
    const { settings } = migrateSettings({ tabTitleGitRoot: false }, DEFAULTS);

    expect(settings[SETTINGS_VERSION_KEY]).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("leaves every unrelated persisted key untouched", () => {
    const { settings } = migrateSettings(
      { tabTitleGitRoot: false, showGitStatus: true, previewFontSize: 20 },
      DEFAULTS,
    );

    expect(settings.showGitStatus).toBe(true);
    expect(settings.previewFontSize).toBe(20);
  });
});

describe("migrateSettings — a deliberate opt-out survives (#506)", () => {
  it("keeps tabTitleGitRoot:false when the blob already carries the stamp", () => {
    // A user who turned the decoration off AFTER the migration ran. Resetting
    // them again would make the setting impossible to switch off.
    const { settings, changed } = migrateSettings(
      { tabTitleGitRoot: false, settingsVersion: CURRENT_SETTINGS_VERSION },
      DEFAULTS,
    );

    expect(settings.tabTitleGitRoot).toBe(false);
    expect(changed).toBe(false);
  });

  it("is idempotent: re-migrating its own output changes nothing", () => {
    const once = migrateSettings({ tabTitleGitRoot: false }, DEFAULTS);
    const twice = migrateSettings(once.settings, DEFAULTS);

    expect(twice.settings).toEqual(once.settings);
    expect(twice.changed).toBe(false);
  });

  it("does not downgrade or re-apply against a stamp from a newer build", () => {
    const future = CURRENT_SETTINGS_VERSION + 5;
    const { settings, changed } = migrateSettings(
      { tabTitleGitRoot: false, settingsVersion: future },
      DEFAULTS,
    );

    expect(settings.tabTitleGitRoot).toBe(false);
    expect(settings[SETTINGS_VERSION_KEY]).toBe(future);
    expect(changed).toBe(false);
  });
});

describe("migrateSettings — malformed and absent input (#506)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a string", "not-an-object"],
    ["a number", 7],
    ["an array", [1, 2, 3]],
  ])("falls back to the defaults for %s", (_label, persisted) => {
    const { settings } = migrateSettings(persisted as Partial<Fixture>, DEFAULTS);

    expect(settings.tabTitleGitRoot).toBe(true);
    expect(settings.showGitStatus).toBe(false);
    expect(settings.previewFontSize).toBe(12);
    expect(settings[SETTINGS_VERSION_KEY]).toBe(CURRENT_SETTINGS_VERSION);
  });

  it.each([
    ["a string version", "1"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative version", -3],
    ["null", null],
  ])("treats %s as unstamped and migrates", (_label, version) => {
    const { settings, changed } = migrateSettings(
      { tabTitleGitRoot: false, settingsVersion: version } as unknown as Partial<Fixture>,
      DEFAULTS,
    );

    expect(settings.tabTitleGitRoot).toBe(true);
    expect(settings[SETTINGS_VERSION_KEY]).toBe(CURRENT_SETTINGS_VERSION);
    expect(changed).toBe(true);
  });

  it("does not mutate the persisted object it was given", () => {
    const persisted = { tabTitleGitRoot: false };
    migrateSettings(persisted, DEFAULTS);

    expect(persisted).toEqual({ tabTitleGitRoot: false });
  });
});

describe("migrateSettings — ledger semantics (#506)", () => {
  const LEDGER: readonly SettingsMigration[] = [
    { version: 1, resetToDefault: ["tabTitleGitRoot"], reason: "v1" },
    { version: 2, resetToDefault: ["showGitStatus"], reason: "v2" },
  ];
  const DEFAULTS_V2: Fixture = { ...DEFAULTS, settingsVersion: 2 };

  it("applies every entry above the stored stamp, and no entry at or below it", () => {
    const { settings, changed } = migrateSettings(
      { tabTitleGitRoot: false, showGitStatus: true, settingsVersion: 1 },
      DEFAULTS_V2,
      LEDGER,
    );

    // v1 already ran on this install, so its key keeps the persisted value…
    expect(settings.tabTitleGitRoot).toBe(false);
    // …while v2 has not, so its key resets to the default.
    expect(settings.showGitStatus).toBe(false);
    expect(settings[SETTINGS_VERSION_KEY]).toBe(2);
    expect(changed).toBe(true);
  });

  it("applies the whole ledger to an unstamped blob", () => {
    const { settings } = migrateSettings(
      { tabTitleGitRoot: false, showGitStatus: true },
      DEFAULTS_V2,
      LEDGER,
    );

    expect(settings.tabTitleGitRoot).toBe(true);
    expect(settings.showGitStatus).toBe(false);
  });

  it("an empty ledger is a plain defaults-merge that never reports a change", () => {
    const { settings, changed } = migrateSettings({ tabTitleGitRoot: false }, DEFAULTS, []);

    expect(settings.tabTitleGitRoot).toBe(false);
    expect(changed).toBe(false);
  });

  it("ignores a ledger key that only exists on Object.prototype", () => {
    // A typo'd or hostile entry naming an inherited key must not smuggle a
    // function onto the settings blob and out to settings.json.
    const { settings } = migrateSettings({ tabTitleGitRoot: false }, DEFAULTS, [
      { version: 1, resetToDefault: ["toString", "constructor"], reason: "typo" },
    ]);

    expect(Object.hasOwn(settings, "toString")).toBe(false);
    expect(Object.hasOwn(settings, "constructor")).toBe(false);
  });
});

/**
 * What the site demo boots with, decided before any app module loads: the
 * fixture world, the storage seed (settings, keybindings, bookmarks, mock
 * config files) and the launch path, plus a report for the host page.
 *
 * Total by construction: nothing a host sends can make this throw. Fields that
 * cannot be used are dropped with a warning; if the fixture itself cannot be
 * read, the plan fails closed to the built-in mock fixtures and says why.
 * Pure and framework-free.
 */
import { convertDemoFixture, type DemoWorld } from "./demo-fixture";
import type { DemoInit } from "./demo-protocol";
import { QUICK_ACCESS_FOLDER_NAMES } from "./quick-access";
import { CURRENT_SETTINGS_VERSION } from "./settings-migration";

/** Settings that differ from a fresh install: the demo shows features that are off by default. */
export const DEMO_DEFAULT_SETTINGS: Readonly<Record<string, unknown>> = { enableTerminal: true, enableGitGraph: true };

export interface DemoBootReport {
  /** `provided`: the host's fixture is served; `builtin`: the built-in mock fixtures are. */
  readonly fixture: "provided" | "builtin";
  /** Why a provided fixture could not be served (null when nothing failed). */
  readonly error: string | null;
  readonly warnings: readonly string[];
}

export interface DemoBootPlan {
  readonly world: DemoWorld | null;
  /** localStorage seed: key → stored text. */
  readonly storage: Readonly<Record<string, string>>;
  /** `__LAUNCH_DATA__` for the window; null keeps the mock's defaults. */
  readonly launch: { readonly home: string; readonly cwd: string } | null;
  readonly report: DemoBootReport;
}

export interface DemoBootContext {
  readonly now: number;
  /** The embedding page's URL: what a relative `assetBase` resolves against. */
  readonly pageUrl: string;
}

const MAX_WARNINGS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A JSON-safe copy of a plain object, or null when it is not one (cycles, BigInt, functions…). */
function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(copy) ? copy : null;
  } catch {
    return null;
  }
}

/** Command id → shortcut (or null to unbind); other values are dropped. */
function shortcuts(record: Record<string, unknown> | null): Record<string, string | null> | null {
  if (!record) return null;
  return Object.fromEntries(Object.entries(record)
    .filter((entry): entry is [string, string | null] => typeof entry[1] === "string" || entry[1] === null));
}

/** An absolute http(s) base URL for fixture assets; the page URL when absent or unusable. */
export function resolveDemoAssetBase(raw: unknown, pageUrl: string): { url: string; warning: string | null } {
  if (raw === undefined) return { url: pageUrl, warning: null };
  try {
    const url = new URL(String(raw), pageUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return { url: url.href, warning: null };
  } catch {
    // reported below
  }
  return { url: pageUrl, warning: `assetBase ${JSON.stringify(String(raw)).slice(0, 80)} is not an http(s) URL; using the page URL` };
}

function storageSeed(settings: Record<string, unknown>, keybindings: Record<string, string | null>, world: DemoWorld | null) {
  const stored = { ...DEMO_DEFAULT_SETTINGS, ...settings, settingsVersion: CURRENT_SETTINGS_VERSION };
  const config: Record<string, string> = { "settings.json": JSON.stringify(stored, null, 2) };
  const storage: Record<string, string> = {
    "explorer-settings": JSON.stringify(stored),
    "explorer-keybindings": JSON.stringify(keybindings),
    "explorer-keybindings-sidebar-migration": "true",
  };
  if (world) {
    // The sidebar shows exactly the fixture's bookmarks: the desktop's default
    // system folders (Downloads, Pictures…) would be dead links into a world
    // that need not have them, or duplicate a bookmark of the same folder.
    const bookmarks = world.bookmarks.map(({ name, path }) => ({ name, path, icon: "folder" }));
    storage["explorer-bookmarks"] = JSON.stringify(bookmarks);
    storage["explorer-hidden-system-folders"] = JSON.stringify(QUICK_ACCESS_FOLDER_NAMES);
    config["bookmarks.json"] = JSON.stringify(bookmarks, null, 2);
  }
  // The mock config store seeds itself from this key when its module loads.
  storage["mock-config-files"] = JSON.stringify(config);
  return storage;
}

/** The built-in fixtures with the demo defaults only. */
export function builtinDemoBootPlan(error: string | null = null, warnings: readonly string[] = []): DemoBootPlan {
  return { world: null, storage: storageSeed({}, {}, null), launch: null, report: { fixture: "builtin", error, warnings } };
}

/**
 * `plan` with its world dropped after it failed to install: the host's
 * settings and keybindings stand (stores may already have read them), while
 * the bookmarks and launch path into the missing world go.
 */
export function withoutDemoWorld(plan: DemoBootPlan, error: string): DemoBootPlan {
  const storage = { ...plan.storage };
  delete storage["explorer-bookmarks"];
  delete storage["explorer-hidden-system-folders"];
  try {
    const config = JSON.parse(storage["mock-config-files"] ?? "{}") as Record<string, string>;
    delete config["bookmarks.json"];
    storage["mock-config-files"] = JSON.stringify(config);
  } catch {
    delete storage["mock-config-files"];
  }
  return { world: null, storage, launch: null, report: { fixture: "builtin", error, warnings: plan.report.warnings } };
}

export function planDemoBoot(init: DemoInit | null, context: DemoBootContext): DemoBootPlan {
  if (!init) return builtinDemoBootPlan();
  const warnings: string[] = [];
  try {
    const assetBase = resolveDemoAssetBase(init.assetBase, context.pageUrl);
    if (assetBase.warning) warnings.push(assetBase.warning);
    const world = init.fixture === undefined
      ? null
      : convertDemoFixture(init.fixture, { assetBase: assetBase.url, now: context.now, userId: init.user });
    const settings = init.settings === undefined ? {} : jsonRecord(init.settings);
    if (settings === null) warnings.push("settings are not a JSON object; using the demo defaults");
    const keybindings = init.keybindings === undefined ? {} : shortcuts(jsonRecord(init.keybindings));
    if (keybindings === null) warnings.push("keybindings are not a JSON object; using the defaults");

    let launch: DemoBootPlan["launch"] = null;
    if (world) {
      const home = world.user.home;
      let cwd = home;
      if (init.startPath !== undefined) {
        if (init.startPath in world.listings) cwd = init.startPath;
        else warnings.push(`startPath ${init.startPath} is not a folder in the fixture; starting at ${home}`);
      }
      launch = { home, cwd };
    }
    return {
      world,
      storage: storageSeed(settings ?? {}, keybindings ?? {}, world),
      launch,
      report: {
        fixture: world ? "provided" : "builtin",
        error: null,
        warnings: [...warnings, ...(world?.warnings ?? [])].slice(0, MAX_WARNINGS),
      },
    };
  } catch (error) {
    return builtinDemoBootPlan(`The fixture could not be loaded: ${describe(error)}`, warnings);
  }
}

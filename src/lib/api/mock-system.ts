/**
 * Mock application/system commands: drives, startup and crash diagnostics, updates, warm windows,
 * terminals, config files, plugins, themes and external launches.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { FrontendSlowLoadRecord, SlowLoadRecord } from "$lib/domain/load-diagnostics";
import { emitWatcherGitChange } from "$lib/state/git-refresh";
import { getMockControl, MOCK_LOCAL_KEYS } from "./mock-control";
import { mockDrivesFixture } from "./mock-fixtures";
import type { CommandHandler } from "./mock-dispatch";
import { MOCK_REPO_ROOT } from "./mock-git-state";


const mockSlowLoads: SlowLoadRecord[] = [];

// Mutable so manual/E2E testing can simulate ejecting a removable drive: the
// drives store re-polls `list_drives` every ~1.5s, so replacing this list makes
// the change propagate. `window.__mockControl.ejectDrive(path)` (set below)
// removes one. Cloned from the fixture at load so reassigning this local
// binding doesn't try to rebind mock-fixtures.ts's export.
let mockDrives: { name: string; path: string; kind: string; detail?: string; provider?: string }[] =
  [...mockDrivesFixture];

if (typeof window !== "undefined") {
  const control = getMockControl();
  // Test affordance (mock/browser only): drop a drive to mimic an eject.
  control.ejectDrive = (path: string) => {
    mockDrives = mockDrives.filter((d) => d.path !== path);
  };
  // Test affordance (mock/browser only): fire the watcher signal a repo on a
  // UNC path gets every 3s from the poll watcher (#387). Used to prove a diff
  // still lands while those refreshes rain on it (#396).
  control.gitPoll = () => {
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
}

/**
 * localStorage key an e2e/unit test can set to pre-seed the mock config store
 * with `{ [filename]: contents }` before the app boots. Re-exported here
 * (rather than requiring every caller to import `MOCK_LOCAL_KEYS` just for
 * this one key) since `tests/state/settings-migration.test.ts` already
 * imports it from this module; the value itself lives in
 * `MOCK_LOCAL_KEYS.configSeed` alongside every other mock localStorage key.
 *
 * The mock config store is in-memory and starts empty, so without this there
 * is no way to present the app with an EXISTING settings.json — every mock
 * run looks like a fresh install. That blind spot is exactly what hid #506:
 * a settings migration only runs against the durable store of record, which
 * the mock could never populate.
 */
export const MOCK_CONFIG_SEED_KEY = MOCK_LOCAL_KEYS.configSeed;

/** In-memory config file store for mock mode, optionally test-seeded. */
const mockConfigFiles: Record<string, string> = loadMockConfigSeed();

function loadMockConfigSeed(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(MOCK_CONFIG_SEED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      ) as [string, string][],
    );
  } catch {
    return {};
  }
}

export const systemCommands: Record<string, CommandHandler> = {
  // A browser has no native window to start an OS drag. Match a failed
  // native start (Result<(), String>): reject without a completion callback
  // so the source retains DOM-drop authority. Never fake a successful lease.
  native_file_drag_clock: () => ({ id: `browser:${performance.timeOrigin}`, now: performance.timeOrigin + performance.now() }),
  start_file_drag: () => { throw "Native file dragging is unavailable in the browser"; },
  end_html5_file_drag: () => undefined,
  get_home_directory: () => "/home/user",
  get_launch_cwd: () => "/home/user",
  list_drives: () => {
    const control = getMockControl();
    const drives = control.linuxVolumes ?? mockDrives;
    // Model the native mount-table/cloud fallback when the optional service
    // disappears. Only mounted paths survive, without a UDisks identity.
    return control.udisksUnavailable
      ? drives.filter((d) => d.path !== null).map((d) => ({ ...d, deviceId: undefined }))
      : drives;
  },
  mount_drive: (args) => {
    const control = getMockControl();
    if (control.udisksUnavailable) throw new Error("Linux storage service (UDisks2) unavailable");
    if (control.mountError) throw new Error(control.mountError);
    const drive = control.linuxVolumes?.find((d) => d.deviceId === args?.deviceId);
    if (!drive) throw new Error("Linux storage service (UDisks2) unavailable");
    drive.path ??= "/media/user/USB_DRIVE";
    return drive.path;
  },
  // The mock has no UDisks push subscription, so the drive store stays in
  // poll mode; the volume evidence specs assert on that polling.
  drive_updates_live: () => false,
  log_startup_timing: () => undefined,
  log_startup_progress: () => undefined,

  // Crash reporting (#184, #302): a Rust crash is simulated when the e2e test
  // sets localStorage.mockCrashReport before load; a frontend crash is
  // simulated by record_frontend_crash writing localStorage.mockFrontendCrash.
  // Either is consumed on first read, mirroring take_crash_report's mark-seen.
  take_crash_report: () => {
    if (localStorage.getItem(MOCK_LOCAL_KEYS.crashReport) === "1") {
      localStorage.removeItem(MOCK_LOCAL_KEYS.crashReport);
      return {
        fileName: "crash-1700000000.txt",
        contents:
          "tauri-explorer 1.0.0 crash report\nos: linux (x86_64)\ntime: 1700000000 (unix)\npanic: mock panic for testing\nlocation: src/lib.rs:1:1\n\nbacktrace:\n<omitted>\n",
      };
    }
    const frontend = localStorage.getItem(MOCK_LOCAL_KEYS.frontendCrash);
    if (frontend) {
      localStorage.removeItem(MOCK_LOCAL_KEYS.frontendCrash);
      return JSON.parse(frontend);
    }
    return null;
  },
  log_frontend_error: () => undefined,
  // Frontend crash capture (#302): persist a crash record the next "launch"
  // (page reload) will offer via take_crash_report. Dedupe lives in crash.ts.
  record_frontend_crash: (args) => {
    const message = String(args.message ?? "");
    const stack = args.stack ? String(args.stack) : "<no stack captured>";
    localStorage.setItem(
      MOCK_LOCAL_KEYS.frontendCrash,
      JSON.stringify({
        fileName: "crash-1700000001.txt",
        contents:
          `tauri-explorer 0.0.0-mock crash report\nos: linux (x86_64)\n` +
          `time: 1700000001 (unix)\nsource: frontend (webview)\n` +
          `panic: ${message}\nlocation: webview\n\nbacktrace:\n${stack}\n`,
      }),
    );
    return undefined;
  },
  open_external_url: (args) => {
    if (localStorage.getItem(MOCK_LOCAL_KEYS.openUrlError) === "1") {
      throw new Error("Mock browser handoff failed");
    }
    const url = args.url as string;
    localStorage.setItem(MOCK_LOCAL_KEYS.openedUrl, url);
    return undefined;
  },
  // Slow-load diagnostics (#1022): an in-memory stand-in for the rotating
  // records under the native log directory. The browser has no native trace
  // or mount table, so those halves are null, as when native capture fails.
  record_slow_load: (args) => {
    const record = args.record as FrontendSlowLoadRecord;
    const stored: SlowLoadRecord = {
      ...record,
      schema: 1,
      source: "frontend",
      native: null,
      blocker: null,
      filesystem: null,
      appVersion: "0.0.0-mock",
      os: "linux",
    };
    const index = mockSlowLoads.findIndex((existing) => existing.id === record.id);
    if (index >= 0) mockSlowLoads.splice(index, 1, stored);
    else mockSlowLoads.push(stored);
    mockSlowLoads.sort((a, b) => b.id.localeCompare(a.id));
    mockSlowLoads.splice(20);
    return undefined;
  },
  recent_slow_loads: (args) => mockSlowLoads.slice(0, Math.min(20, (args.limit as number | null) ?? 20)),
  // The mock never stores the token value, only that one is saved (#1455).
  user_report_token_state: () =>
    localStorage.getItem(MOCK_LOCAL_KEYS.reportToken) === "1" ? "configured" : "absent",
  save_user_report_token: () => {
    localStorage.setItem(MOCK_LOCAL_KEYS.reportToken, "1");
    return undefined;
  },
  clear_user_report_token: () => {
    localStorage.removeItem(MOCK_LOCAL_KEYS.reportToken);
    return undefined;
  },
  submit_user_report: (args) => {
    localStorage.setItem(MOCK_LOCAL_KEYS.submittedReport, JSON.stringify(args));
    const error = localStorage.getItem(MOCK_LOCAL_KEYS.reportError);
    if (error) {
      throw {
        kind: error,
        message: localStorage.getItem(MOCK_LOCAL_KEYS.reportErrorMessage) ?? (error === "daily_cap"
          ? "Reports are temporarily unavailable"
          : "Unable to submit report"),
      };
    }
    return {
      url: "https://github.com/xnmp/tauri-explorer/issues/5470",
      number: 5470,
    };
  },

  // Update check (#185): a newer release is simulated when the e2e test
  // sets localStorage.mockUpdateAvailable before load.
  check_for_update: () =>
    localStorage.getItem(MOCK_LOCAL_KEYS.updateAvailable) === "1"
      ? {
          version: "9.9.9",
          url:
            localStorage.getItem(MOCK_LOCAL_KEYS.updateUrl) ??
            "https://github.com/xnmp/tauri-explorer/releases/tag/v9.9.9",
        }
      : null,

  // Pre-warmed window pool: no pool outside Tauri — spawn is always refused
  // and claims always miss, so openNewWindow takes the fresh-window path.
  warm_pool_begin_spawn: () => false,
  warm_pool_activate: () => false,
  warm_pool_cancel_spawn: () => undefined,
  warm_pool_register: () => undefined,
  warm_pool_claim: () => null,
  warm_pool_discard: () => undefined,
  warm_pool_shutdown: () => undefined,

  open_file: () => {
    // No-op for mock
  },

  open_file_at_line: () => {
    // No-op for mock
  },

  open_image_with_siblings: () => {
    // No-op for mock
  },

  // Embedded terminal: a PTY can't be faked meaningfully in the browser —
  // spawn "succeeds" (so the panel renders and e2e can exercise the toggle)
  // but never emits output. Real terminal behavior is covered by e2e-tauri.
  terminal_reserve_id: () => 1,
  terminal_spawn: () => ({ id: 1, shellKind: "posix", wslDistro: null }),
  terminal_write: () => ({ droppedBytes: 0 }),
  terminal_resize: () => {},
  terminal_kill: () => {},
  terminal_status: () => ({ busy: false, cwd: null }),

  // Config file persistence (in-memory mock)
  read_config_file: (args) => {
    const filename = args.filename as string;
    return mockConfigFiles[filename] ?? "";
  },

  write_config_file: (args) => {
    const filename = args.filename as string;
    const data = args.data as string;
    mockConfigFiles[filename] = data;
  },

  get_config_dir: () => "/home/user/.config/tauri-explorer",

  // ----- File-picker portal -----

  // Records the response so e2e tests can assert on the actual outcome.
  picker_respond: (args) => {
    localStorage.setItem(MOCK_LOCAL_KEYS.pickerResponse, JSON.stringify(args));
    return null;
  },

  // ----- Window theming (no-op in mock) -----

  set_window_theme: () => {},

  // ----- Commands that launch external processes (no-op in mock) -----

  open_file_with: () => {},
  list_open_with_applications: () => getMockControl().openWithApplications ?? [
    { id: "text-editor.desktop", name: "Text Editor" },
    { id: "alternate-editor.desktop", name: "Alternate Editor" },
  ],
  open_file_with_application: (args) => {
    localStorage.setItem("mock-open-with-launch", JSON.stringify(args));
  },

  open_recycle_bin: () => {
    const error = localStorage.getItem(MOCK_LOCAL_KEYS.openRecycleBinError);
    if (error) throw new Error(error);
  },

  open_in_terminal: () => {},
  list_installed_plugins: () => [],
  take_pending_plugin_install_errors: () => [],
  take_window_launch_requests: () => [],
  pick_file: (args) => ((args.options as { mode?: string; filename?: string } | undefined)?.mode === "save" ? `/home/user/Downloads/${(args.options as { filename?: string }).filename}` : null),
  save_file_copy: (args) => { (getMockControl().savedVideoCopies ??= []).push({ source: String(args.source), destination: String(args.destination) }); },
  install_plugin: () => { throw new Error("Install plugin packages in the native app"); },
  uninstall_plugin: () => undefined,
  set_plugin_package_enabled: () => undefined,
  plugin_backend_invoke: () => { throw new Error("No native plugin backend in the browser fixture"); },
  list_installed_terminals: () => ["ghostty", "kitty", "alacritty", "gnome-terminal", "xterm"],
  set_ffmpeg_path: () => {},

  set_as_wallpaper: () => {},

  // ----- Misc -----

  get_log_dir: () => "/tmp/tauri-explorer/logs",
  write_theme_file: (args) => {
    mockConfigFiles[`themes/${args.filename as string}`] = args.data as string;
    return undefined;
  },
  list_user_themes: () =>
    Object.entries(mockConfigFiles)
      .filter(([k]) => k.startsWith("themes/"))
      .map(([k, v]) => [k.slice("themes/".length), v]),

  // Layout themes (#1306): `layouts/<name>.css` entries of the seeded config.
  list_user_layouts: () =>
    Object.entries(mockConfigFiles)
      .filter(([k]) => k.startsWith("layouts/"))
      .map(([k, css]) => ({ filename: k.slice("layouts/".length), css, error: null })),
  ensure_layouts_dir: () => "/home/user/.config/tauri-explorer/layouts",

  get_app_info: () => ({ version: "0.0.0-mock", os: "linux", arch: "x86_64" }),
};

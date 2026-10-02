/**
 * Single typed control surface for the browser/e2e mock backend
 * (`mock-invoke.ts`). Before this module, mock-invoke.ts read and wrote ~19
 * ad hoc `globalThis.__mockXxx` globals and ~13 ad hoc `localStorage
 * "mock-*"` string keys, each declared inline (often re-declared with a
 * slightly different inline type) at every call site, in mock-invoke.ts and
 * in 25+ e2e specs (#869).
 *
 * Two storage domains, each with one owner here:
 *
 * - `window.__mockControl` ({@link MockControl}): fixture overrides and
 *   injected failure/latency modes that must be visible before
 *   mock-invoke.ts's first command, plus the test-exposed action hooks the
 *   mock installs for e2e specs to call (`gitReset`, `ejectDrive`, ...).
 *   mock-invoke.ts is dynamically imported lazily, on the app's first real
 *   `invoke()` call (see `src/lib/api/common.ts`) — NOT at page load — so
 *   `window.__mockControl` is not guaranteed to exist yet even after
 *   `page.goto`/`waitForLoadState` resolve, only once something has actually
 *   driven an IPC call (e.g. the initial directory listing). Every read/write
 *   here and at every e2e call site must therefore go through
 *   {@link getMockControl} or an equivalent `??= {}` guard rather than assume
 *   the object already exists; a bare `window.__mockControl!.foo = ...` (no
 *   `??=`) has caused a real flake (#869) because a spec ran before the first
 *   `invoke()`. `page.addInitScript` closures always predate the object for
 *   the same reason, and are additionally the right place to seed values that
 *   must survive a reload, since plain window assignments reset on navigation.
 *
 * - `localStorage` ({@link MOCK_LOCAL_KEYS}): flags/records that must
 *   survive a page reload *without* being re-seeded by addInitScript —
 *   crash/report state is written by the running app itself and consumed
 *   exactly once on the next simulated launch (see e2e/crash-notice.spec.ts).
 *   A plain `window.__mockControl` property can't model that: addInitScript
 *   would re-seed it on every navigation and defeat the consumed-on-read
 *   assertions. Each localStorage key lives in `MOCK_LOCAL_KEYS` instead of
 *   being retyped as a string literal at every call site; e2e specs pass the
 *   constant into `page.evaluate`/`page.addInitScript` as an argument rather
 *   than importing it into the closure — those closures are serialized by
 *   `Function#toString()` and run in the page, so they cannot close over a
 *   Node-side import (a `import type` for {@link MockControl} is fine to
 *   reference inside a closure: type-only imports are erased before the
 *   closure is ever stringified).
 */
import type { Drive } from "./drives";
import type { GitFileEntry, GitOpState } from "./git";
import type { ImageCropCapture, ImageCropSave } from "./image-crop";
import type { FileMutationReceipt } from "$lib/domain/file";

export interface MockGitState {
  branch: string;
  detached: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
  op_state: GitOpState;
}

export interface MockGitCommit {
  message: string;
  amend: boolean;
  files: string[];
  commit_id: string;
}

export interface MockControl {
  // ----- Preview / thumbnails: fixture overrides + action hooks -----
  /** Overrides `read_text_file` for the path under test. */
  previewReadText?: (path: string) => string | Promise<string>;
  /** Overrides `read_image_data_url` for the path under test. */
  previewReadImage?: (path: string) => string | Promise<string>;
  imageCropCapture?: (path: string) => ImageCropCapture | Promise<ImageCropCapture>;
  imageCropSave?: (request: ImageCropSave) => FileMutationReceipt | Promise<FileMutationReceipt>;
  /** Overrides `get_video_thumbnail_data`. */
  videoThumbnail?: (path: string, size?: number) => string | Promise<string>;
  /** Action hook: bump the mtime/size of a previewed file to simulate an
   * external edit landing while its preview is open. */
  previewRevision?: (path: string) => void;
  /** Action hook: bump the mtime/size of the fixture video under preview. */
  videoRevision?: () => void;

  // ----- Git fixture + action hooks -----
  /** Recorded commits, so tests can assert the message that was committed. */
  gitCommits?: MockGitCommit[];
  /** Paths archived via the SCM "archive untracked" action. */
  gitArchived?: string[];
  /** Action hook: reset the mock repo to its seed state. */
  gitReset?: () => void;
  /** Action hook: simulate a working-tree edit made outside the app. */
  gitExternalModify?: (path: string) => void;
  /** Action hook: simulate every section becoming clean. */
  gitSetClean?: () => void;
  /** Action hook: put the mock repo into an in-progress conflicted merge. */
  gitStartMergeConflict?: () => void;
  /** Action hook: read the current mock git state (repo.rs test parity). */
  gitState?: () => MockGitState;
  /** Action hook: fire the same watcher signal the poll watcher emits for a
   * repo on a UNC path (#387, #396). */
  gitPoll?: () => void;
  /** Force `git_log`'s `has_more` true regardless of the mock fixture size,
   * to drive the infinite-load path (like `__MOCK_LATENCY__`, a test hook). */
  graphForceHasMore?: boolean;

  // ----- Linux volumes / drives -----
  linuxVolumes?: Drive[];
  udisksUnavailable?: boolean;
  mountError?: string;
  /** Action hook: drop a drive from the fixture list to mimic an eject. */
  ejectDrive?: (path: string) => void;

  // ----- Cross-cutting test instrumentation -----
  /** Per-command invocation counter, incremented by every `mockInvoke` call. */
  invokeCounts?: Record<string, number>;
  /** Command name -> error message. Injects a rejection instead of running
   * the command's handler. */
  failures?: Record<string, string>;
  /** Command name -> extra artificial latency in ms, on top of the base
   * simulated round-trip delay. Also settable via `?mockLatency=name:ms,...`. */
  latency?: Record<string, number>;
}

/** The mock's single window-global control object. mock-invoke.ts creates
 * this eagerly at import time; every reader/writer (mock-invoke.ts itself,
 * or an e2e spec via `page.addInitScript`/`page.evaluate`) goes through this
 * function rather than re-declaring an inline `window as unknown as {...}`
 * cast at each call site. Reads `globalThis`, not `window`, on purpose:
 * mock-invoke.ts is also driven directly from vitest (`environment: "node"`,
 * no DOM), where `window` is undefined unless a test stubs it, but
 * `globalThis` always exists and is the same object as `window` in a real
 * browser or jsdom. */
export function getMockControl(): MockControl {
  const g = globalThis as unknown as { __mockControl?: MockControl };
  return (g.__mockControl ??= {});
}

/** Canonical localStorage keys for mock flags/records that must survive a
 * page reload without addInitScript re-seeding them (see module doc). Import
 * this object — never retype one of its values as a string literal. */
export const MOCK_LOCAL_KEYS = {
  /** "1" when set; consumed (removed) by the next `take_crash_report` read. */
  crashReport: "mockCrashReport",
  /** JSON `{ fileName, contents }`; consumed by the next `take_crash_report` read. */
  frontendCrash: "mockFrontendCrash",
  /** "1" when set: `open_external_url` throws. */
  openUrlError: "mock-open-url-error",
  /** Last URL passed to `open_external_url`. */
  openedUrl: "mock-opened-url",
  /** Error kind string: `submit_user_report` throws `{ kind, message }`. */
  reportError: "mock-report-error",
  /** JSON of the last `submit_user_report` payload. */
  submittedReport: "mock-submitted-report",
  /** "1" when set: `check_for_update` reports a newer release. */
  updateAvailable: "mockUpdateAvailable",
  /** Overrides the reported release URL when `updateAvailable` is set. */
  updateUrl: "mock-update-url",
  /** Text `clipboard_read_text` returns. */
  clipboardText: "mock-clipboard-text",
  /** "1" when set: `clipboard_publish` with `operation: "cut"` throws. */
  cutOwnershipUnavailable: "mock-cut-ownership-unavailable",
  /** "1" when set: `clipboard_has_image` reports true. */
  reportClipboardImage: "mock-report-clipboard-image",
  /** Error message: `open_recycle_bin` throws it. */
  openRecycleBinError: "mock-open-recycle-bin-error",
  /** JSON of the last `picker_respond` payload. */
  pickerResponse: "mock-picker-response",
  /** JSON array log of streaming-search calls. */
  streamingSearches: "mock-streaming-searches",
  /** JSON `{ [filename]: contents }` to pre-seed the mock config store with
   *  before the app boots (see `MOCK_CONFIG_SEED_KEY` in mock-invoke.ts). */
  configSeed: "mock-config-files",
} as const;

export type MockLocalKey = (typeof MOCK_LOCAL_KEYS)[keyof typeof MOCK_LOCAL_KEYS];

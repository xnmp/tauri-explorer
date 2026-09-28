import { browser, $, $$ } from "@wdio/globals";
// Keep command types available to standalone fixture-contract tests too.
import type {} from "webdriverio";
import path from "node:path";
import {
  boundNativeProcessSample,
  collectNativeProcessEvidence,
  firstMissingRendererAt,
  newestRenderer,
  writeFreshWindowDiagnostics,
  type FreshWindowPageSnapshot,
  type FreshWindowSelectedDiagnostics,
  type NativeProcessSample,
  type ProcessObservation,
} from "../fresh-window-diagnostics";
import {
  writeWarmClaimFailure,
  type WarmClaimIdentity,
  type WarmClaimMilestone,
  type WarmClaimStage,
} from "../warm-claim-diagnostics";

const applicationBinary = path.resolve(
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer",
);

const diagnosticsDirectory =
  process.env.TAURI_NATIVE_DIAGNOSTICS_DIR
  ?? path.resolve("e2e-tauri", "logs", "fresh-window");

const warmClaimDiagnosticsDirectory =
  process.env.TAURI_NATIVE_DIAGNOSTICS_DIR
  ?? path.resolve("e2e-tauri", "logs", "warm-claim");

/**
 * Evidence for the most recent fresh-window selection (#703).
 *
 * The Linux session loss happened between selection and the first element
 * lookup, so this is captured unconditionally at selection and replayed if the
 * lookup fails — by then the session can already be invalid.
 */
let lastFreshWindow: FreshWindowSelectedDiagnostics | null = null;

/** Exact entry selector for native paths, including Windows `\` and quotes. */
export function entryPathSelector(
  entryPath: string,
  scope = ".entry-item",
): string {
  const escaped = Array.from(entryPath, character => {
    const code = character.charCodeAt(0);
    if (character === "\\" || character === '"') return `\\${character}`;
    if (code === 0) return "\uFFFD";
    if (code <= 0x1f || code === 0x7f) return `\\${code.toString(16)} `;
    return character;
  }).join("");
  return `${scope}[data-path="${escaped}"]`;
}

/**
 * One atomic renderer sample. WebKitWebDriver may evaluate injected scripts in
 * an isolated world, so read DOM state only — never application globals.
 */
async function captureFreshWindowPage(): Promise<FreshWindowPageSnapshot | { error: string }> {
  try {
    return await browser.execute(() => {
      const data = document.documentElement.dataset;
      const status = document.querySelector(".status-path");
      return {
        capturedAt: Date.now(),
        label: data.e2eWindowLabel ?? null,
        hooksReady: data.e2eHooksReady === "true",
        fileListCount: document.querySelectorAll(".file-list").length,
        entryCount: document.querySelectorAll(".entry-item").length,
        statusPath: status ? status.getAttribute("title") : null,
        url: location.href,
        readyState: document.readyState,
        visibility: document.visibilityState,
      };
    }) as FreshWindowPageSnapshot;
  } catch (error) {
    return { error: String(error) };
  }
}

/**
 * Record why a first lookup in a fresh window failed, using process evidence
 * only: a lost session cannot answer another WebDriver command. Exported for
 * contract tests; specs reach it through `waitForFreshWindowElement`.
 */
export function recordFreshWindowLookupFailure(
  selector: string,
  error: unknown,
  lookupStartedAt = Date.now(),
  nativeDuringLookup: NativeProcessSample[] = [],
  observedFirstMissingAt?: number | null,
): string | null {
  const selected = lastFreshWindow;
  if (!selected) return null;
  const nativeAfterFailure = nativeDuringLookup.at(-1)
    ?? boundNativeProcessSample(collectNativeProcessEvidence({ applicationPath: applicationBinary }));
  const selectedRendererAtSelection = newestRenderer(selected.nativeAtSelection);
  return writeFreshWindowDiagnostics({
    ...selected,
    phase: "lookup-failed",
    lookup: {
      selector,
      startedAt: lookupStartedAt,
      failedAt: Date.now(),
      error: String(error),
    },
    nativeAfterFailure,
    nativeDuringLookup,
    selectedRendererAtSelection,
    selectedRendererFirstMissingAt: observedFirstMissingAt === undefined
      ? firstMissingRendererAt(selectedRendererAtSelection, nativeDuringLookup)
      : observedFirstMissingAt,
  }, diagnosticsDirectory);
}

function rendererKey(renderer: ProcessObservation): string {
  return `${renderer.pid}:${renderer.startTime}`;
}

function beginNativeProcessTimeline(
  timeout: number,
  extraRenderers: readonly ProcessObservation[] = [],
) {
  const samples: NativeProcessSample[] = [];
  const baselineRenderers: ProcessObservation[] = [];
  const tracked = new Map<string, {
    renderer: ProcessObservation;
    firstSeenAt: number;
    firstMissingAt: number | null;
  }>();
  let focusedRenderer: {
    renderer: ProcessObservation;
    firstSeenAt: number;
    firstMissingAt: number | null;
  } | null = null;
  const maxTrackedRenderers = 256;
  let untrackedRendererObservations = 0;
  const track = (renderer: ProcessObservation, firstSeenAt: number): boolean => {
    if (renderer.startTime === null) return false;
    const key = rendererKey(renderer);
    if (tracked.has(key)) return true;
    if (tracked.size >= maxTrackedRenderers) {
      untrackedRendererObservations += 1;
      return false;
    }
    tracked.set(key, { renderer, firstSeenAt, firstMissingAt: null });
    return true;
  };
  const focusRenderer = (renderer: ProcessObservation | null, firstSeenAt: number) => {
    if (!renderer || renderer.startTime === null || tracked.has(rendererKey(renderer))) return;
    focusedRenderer = { renderer, firstSeenAt, firstMissingAt: null };
  };
  extraRenderers.forEach((renderer) => track(renderer, Date.now()));
  const sampleInterval = 500;
  const maxSamples = Math.ceil(timeout / sampleInterval) + 2;
  const sample = () => {
    const observation = collectNativeProcessEvidence({ applicationPath: applicationBinary });
    if ("webkit" in observation) {
      for (const renderer of observation.webkit) {
        if (renderer.executable && path.basename(renderer.executable) === "WebKitWebProcess" &&
            renderer.startTime !== null) {
          if (track(renderer, observation.sampledAt) && samples.length === 0) {
            baselineRenderers.push(renderer);
          }
        }
      }
      for (const state of tracked.values()) {
        if (state.firstMissingAt !== null) continue;
        const present = observation.webkit.some((renderer) =>
          renderer.pid === state.renderer.pid && renderer.startTime === state.renderer.startTime);
        if (!present) state.firstMissingAt = observation.sampledAt;
      }
      const focused = focusedRenderer;
      if (focused && focused.firstMissingAt === null) {
        const present = observation.webkit.some((renderer) =>
          renderer.pid === focused.renderer.pid &&
          renderer.startTime === focused.renderer.startTime);
        if (!present) focused.firstMissingAt = observation.sampledAt;
      }
    }
    // Keep the pre-operation baseline and the newest bounded window even if a
    // WebDriver command outlives its nominal timeout.
    if (samples.length >= maxSamples) samples.splice(1, 1);
    samples.push(boundNativeProcessSample(observation));
  };
  sample();
  const timer = setInterval(sample, sampleInterval);
  timer.unref();
  const firstMissingAt = (renderer: ProcessObservation | null): number | null => {
    if (!renderer) return null;
    const trackedMissingAt = tracked.get(rendererKey(renderer))?.firstMissingAt;
    if (trackedMissingAt !== undefined) return trackedMissingAt;
    return focusedRenderer && rendererKey(focusedRenderer.renderer) === rendererKey(renderer)
      ? focusedRenderer.firstMissingAt : null;
  };
  const baselineRendererDisappearances = () => baselineRenderers.map((renderer) => ({
    renderer,
    firstMissingAt: firstMissingAt(renderer),
  }));
  const observedRendererLifetimes = () => [
    ...tracked.values(),
    ...(focusedRenderer ? [focusedRenderer] : []),
  ];
  return {
    samples,
    sample,
    firstMissingAt,
    focusRenderer,
    baselineRendererDisappearances,
    observedRendererLifetimes,
    untrackedRendererObservations: () => untrackedRendererObservations,
    stop: () => clearInterval(timer),
  };
}

/**
 * Sample all WebKit renderer identities before source close and throughout
 * abandoned warm-claim expiry. A failed WebDriver session cannot answer a
 * follow-up command, so failure recording reads only local process state.
 */
export async function monitorWarmClaimExpiry<T>(
  claim: WarmClaimIdentity,
  action: (mark: (stage: WarmClaimStage) => void) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const milestones: WarmClaimMilestone[] = [{ stage: "monitor-started", at: startedAt }];
  const mark = (stage: WarmClaimStage) => milestones.push({ stage, at: Date.now() });
  // The source-window wait is 10 s and the parked-window wait is 40 s.
  const timeline = beginNativeProcessTimeline(50_000);
  try {
    return await action(mark);
  } catch (error) {
    timeline.sample();
    const before = timeline.samples[0];
    writeWarmClaimFailure({
      issue: 781,
      phase: "claim-expiry-failed",
      ...claim,
      startedAt,
      failedAt: Date.now(),
      failure: String(error),
      milestones,
      nativeBeforeClose: before,
      nativeDuringExpiry: timeline.samples,
      rendererDisappearances: timeline.baselineRendererDisappearances(),
      observedRendererLifetimes: timeline.observedRendererLifetimes(),
      untrackedRendererObservations: timeline.untrackedRendererObservations(),
    }, warmClaimDiagnosticsDirectory);
    throw error;
  } finally {
    timeline.stop();
  }
}

/**
 * Wait for the first element of a freshly opened window, retaining diagnostics
 * when it never resolves. The existence contract is unchanged; only the
 * failure path gains evidence.
 */
export async function waitForFreshWindowElement(
  selector: string,
  timeout: number,
): Promise<void> {
  const lookupStartedAt = Date.now();
  const selectedRenderer = newestRenderer(lastFreshWindow?.nativeAtSelection ?? null);
  const timeline = beginNativeProcessTimeline(
    timeout,
    selectedRenderer ? [selectedRenderer] : [],
  );
  try {
    await $(selector).waitForExist({ timeout });
  } catch (error) {
    timeline.sample();
    recordFreshWindowLookupFailure(
      selector,
      error,
      lookupStartedAt,
      timeline.samples,
      timeline.firstMissingAt(selectedRenderer),
    );
    throw error;
  } finally {
    timeline.stop();
  }
}

/** Retain the planned child label if launch fails before returning it. */
export async function monitorFreshWindowOpen(
  requestedLabel: string,
  action: () => Promise<unknown>,
  outputDirectory = diagnosticsDirectory,
): Promise<{ kind: "fresh"; label: string }> {
  const openStartedAt = Date.now();
  const timeline = beginNativeProcessTimeline(20_000);
  try {
    const opened = await action();
    if (!opened || typeof opened !== "object" ||
        !("kind" in opened) || opened.kind !== "fresh" ||
        !("label" in opened) || opened.label !== requestedLabel) {
      throw new Error(`fresh-open returned ${JSON.stringify(opened)} instead of ${requestedLabel}`);
    }
    return { kind: "fresh", label: requestedLabel };
  } catch (error) {
    timeline.sample();
    writeFreshWindowDiagnostics({
      issue: 703,
      phase: "open-failed",
      requestedLabel,
      openStartedAt,
      openFailedAt: Date.now(),
      openError: String(error),
      nativeBeforeOpen: timeline.samples[0],
      nativeDuringOpen: timeline.samples,
      baselineRendererDisappearances: timeline.baselineRendererDisappearances(),
      observedRendererLifetimes: timeline.observedRendererLifetimes(),
      untrackedRendererObservations: timeline.untrackedRendererObservations(),
    }, outputDirectory);
    throw error;
  } finally {
    timeline.stop();
  }
}

/** A fresh launch must introduce a new handle and expose its requested label. */
export async function switchToFreshWindow(
  label: string,
  existingHandles: readonly string[],
): Promise<string> {
  lastFreshWindow = null;
  const selectionStartedAt = Date.now();
  const timeline = beginNativeProcessTimeline(20_000);
  // Existing pages cannot satisfy fresh-open. Avoid probing their renderers:
  // a parked/retiring WebKit page can block script execution indefinitely.
  const existing = new Set(existingHandles);
  let selected = "";
  try {
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        if (existing.has(handle)) continue;
        await browser.switchToWindow(handle);
        if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
          selected = handle;
          return true;
        }
      }
      return false;
    }, { timeout: 20_000, timeoutMsg: `fresh native window ${label} did not become ready` });
  } catch (error) {
    timeline.sample();
    writeFreshWindowDiagnostics({
      issue: 703,
      phase: "selection-failed",
      requestedLabel: label,
      selectionStartedAt,
      selectionFailedAt: Date.now(),
      selectionError: String(error),
      existingHandles: [...existingHandles],
      nativeBeforeSelection: timeline.samples[0],
      nativeDuringSelection: timeline.samples,
      baselineRendererDisappearances: timeline.baselineRendererDisappearances(),
      observedRendererLifetimes: timeline.observedRendererLifetimes(),
      untrackedRendererObservations: timeline.untrackedRendererObservations(),
    }, diagnosticsDirectory);
    timeline.stop();
    throw error;
  }

  // Persist the label and native state before another WebDriver command: the
  // page snapshot itself can hang or lose the session.
  const selectedAt = Date.now();
  const nativeAtSelection = boundNativeProcessSample(
    collectNativeProcessEvidence({ applicationPath: applicationBinary }));
  const selectedRenderer = newestRenderer(nativeAtSelection);
  timeline.focusRenderer(selectedRenderer, selectedAt);
  lastFreshWindow = {
    issue: 703,
    phase: "selected",
    requestedLabel: label,
    handle: selected,
    selectedAt,
    pageAtSelection: null,
    nativeAtSelection,
  };
  writeFreshWindowDiagnostics(lastFreshWindow, diagnosticsDirectory);
  try {
    const pageAtSelection = await captureFreshWindowPage();
    timeline.sample();
    lastFreshWindow = {
      ...lastFreshWindow,
      pageAtSelection,
      nativeDuringPageSnapshot: timeline.samples,
      pageSnapshotRendererFirstMissingAt: timeline.firstMissingAt(selectedRenderer),
    };
    writeFreshWindowDiagnostics(lastFreshWindow, diagnosticsDirectory);
    return selected;
  } finally {
    timeline.stop();
  }
}

/**
 * Raw DOM textContent of the element(s) matching `selector`, joined.
 *
 * WebKitWebDriver's "Get Element Text" returns *rendered* text, which is
 * empty for elements clipped to zero width by `overflow:hidden` +
 * `white-space:nowrap` when they lack `flex:1` (e.g. the content-search
 * `.file-name` and the file-list `.entry-name`). textContent is the raw
 * DOM string and is immune to that, so assertions stay stable headless.
 */
export async function domText(selector: string): Promise<string> {
  const el = $(selector);
  return ((await el.getProperty("textContent")) as string | null) ?? "";
}

/** Read the matching text in one renderer task. Retaining WebElement handles
 * across separate reads races row replacement and can strand polling on stale
 * elements even after the expected content has already been published. */
export async function domTexts(selector: string): Promise<string[]> {
  return browser.execute(
    (query: string) => Array.from(
      document.querySelectorAll(query),
      element => element.textContent ?? "",
    ),
    selector,
  );
}

/** Visible file/folder names in the active listing (CSS-clip-immune). */
export async function entryNames(): Promise<string[]> {
  return await domTexts(".entry-item .entry-name");
}

/**
 * Navigate the active pane to `dir`.
 *
 * Uses the dev-only "e2e-navigate" hook instead of address-bar editing:
 * under Xvfb (no window manager) the breadcrumb path input blurs — and
 * cancels — the instant it opens, so typing into it is untestable there.
 *
 * Confirmation reads the status bar's full-path title attribute — the
 * breadcrumbs apply p10k-style truncation, so long directory names never
 * appear in them verbatim. The backend resolves each request to one native
 * spelling per directory (#799); pass `resolved` when `dir` is another
 * spelling of it, such as a trailing-separator or Windows case variant.
 */
export async function navigateTo(dir: string, resolved = dir): Promise<void> {
  // Close any commit graph restored from a prior spec's persisted state.
  // localStorage is shared across every tauri-driver
  // session (same origin), so a spec that left the graph open would relaunch
  // this one into graph mode and `.file-list` would never render (#447). The
  // pane's onMount registers the hook. Wait for its DOM readiness marker before
  // dispatching so exactly one real navigation/listing is queued.
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () => document.documentElement.dataset.e2eHooksReady === "true",
      ),
    { timeout: 15_000, timeoutMsg: "dev e2e hooks never became ready" },
  );

  // A prior spec can persist a temporary path and then delete its fixture.
  // The next session correctly starts on an error surface with no file list,
  // but its navigation hook is ready and can recover to the requested path.
  await browser.execute(() => {
    window.dispatchEvent(new CustomEvent("e2e-reset-view"));
  });

  const token = `${Date.now()}-${Math.random()}`;
  await browser.execute((target: string, navigationToken: string) => {
    delete document.documentElement.dataset.e2eNavigationComplete;
    window.dispatchEvent(
      new CustomEvent("e2e-navigate", {
        detail: { path: target, token: navigationToken },
      }),
    );
  }, dir, token);

  let shown: string | null = null;
  try {
    await browser.waitUntil(async () => {
      const completedToken = await browser.execute(
        () => document.documentElement.dataset.e2eNavigationComplete,
      );
      shown = await $(".status-path").getAttribute("title");
      return completedToken === token && shown === resolved;
    });
  } catch (error) {
    throw new Error(
      `status bar never showed ${resolved} for ${dir}; last showed ${shown}`,
      { cause: error },
    );
  }
}

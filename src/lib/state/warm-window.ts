/**
 * EXPERIMENTAL — pre-warmed window pooling (settings.warmWindow, default off).
 *
 * Hypothesis: the dominant new-window cost is WKWebView/WebView2 creation
 * (~130–225 ms) plus a fresh JS bundle parse. If we create ONE hidden window
 * shortly after launch and let it fully boot while parked idle, Ctrl+N can just
 * navigate + show it — skipping both costs — then spawn a replacement.
 *
 * READINESS HANDSHAKE (the fix for the earlier broken version): a warm window
 * is only usable once its activate-listener is registered. The warm page emits
 * `warm-ready` AFTER it has called listen(); the parent marks the label usable
 * only on receiving that. Marking it usable on mere `tauri://created` (window
 * exists, JS not booted) was the bug — activation events fired into the void,
 * the window never showed, and Ctrl+N appeared dead.
 *
 * KNOWN RISK being measured: on macOS WKWebView may defer expensive layout/
 * raster until a window is shown, so a hidden warm window might not have paid
 * the cost we hope to skip. The `Startup(warm-activate): show=Xms` log line
 * (emitted on every activation) is the number that decides keep-vs-kill.
 *
 * MEASURE MODE (`?warm=measure`): the warm window self-activates once it's ready
 * (no keypress), so activation latency can be captured headlessly.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "$lib/api/files";
import { windowTabsManager } from "./window-tabs.svelte";
import type { ViewMode } from "./types";

// Reuse the "explorer-" label prefix so warm windows inherit the same Tauri
// capability/ACL scope as normal child windows (capabilities/default.json lists
// "explorer-*"). A distinct "warm-*" prefix would be denied event:listen etc.
// The "-warm-" infix lets us still identify them if needed.
const WARM_LABEL_PREFIX = "explorer-warm-";

/** Warm window → parent: "my activate-listener is registered, I'm usable." */
export const WARM_READY_EVENT = "warm-ready";
/** Parent → warm window: "become a real window at this path." */
export const WARM_ACTIVATE_EVENT = "warm-activate";

export interface WarmReadyPayload {
  label: string;
}
export interface WarmActivatePayload {
  path: string;
  viewMode?: ViewMode;
  x?: number;
  y?: number;
  /** Set when the parent fired this; used to dedupe self-fire vs real Ctrl+N. */
  measure?: boolean;
}

/** Label of a warm window that has signalled ready, if any. */
let readyLabel: string | null = null;
let spawning = false;
let readyListenerInstalled = false;

/** "1" = normal parked warm window; "measure" = self-firing measurement run. */
export function warmMode(): "off" | "park" | "measure" {
  if (typeof window === "undefined") return "off";
  const v = new URLSearchParams(window.location.search).get("warm");
  if (v === "measure") return "measure";
  if (v === "1") return "park";
  return "off";
}

/** Install the parent-side listener for warm-ready exactly once. */
async function ensureReadyListener(): Promise<void> {
  if (readyListenerInstalled) return;
  readyListenerInstalled = true;
  await listen<WarmReadyPayload>(WARM_READY_EVENT, (event) => {
    readyLabel = event.payload.label;
    spawning = false;
  });
}

/**
 * Create a hidden, parked warm window if none is pending/ready. The window
 * signals `warm-ready` once its listener is up; only then is it usable.
 * `measure` makes the warm window self-activate for headless latency capture.
 */
export function spawnWarmWindow(measure = false): void {
  if (readyLabel || spawning) return;
  spawning = true;
  void ensureReadyListener();

  const label = WARM_LABEL_PREFIX + Date.now();
  const baseUrl = window.location.origin + window.location.pathname;
  // Park the warm window at the SPAWNER's current path so its boot-time init
  // navigates somewhere valid. Without this it fell back to "/home" (nonexistent
  // on macOS), producing a broken, multi-second list load on activation.
  const parkPath =
    windowTabsManager.getActiveExplorer()?.currentPath ||
    (window as { __LAUNCH_DATA__?: { home: string } }).__LAUNCH_DATA__?.home ||
    "/";
  const params = new URLSearchParams({ warm: measure ? "measure" : "1", path: parkPath });
  const url = `${baseUrl}?${params.toString()}`;

  try {
    const win = new WebviewWindow(label, {
      url,
      title: "tauri-explorer",
      width: 1200,
      height: 800,
      visible: false,
      // Decorated like a normal window so that, once shown, it's a real titled
      // window — not a chromeless surface that's easy to miss behind others.
      decorations: typeof navigator !== "undefined" && navigator.platform.startsWith("Mac"),
      skipTaskbar: true,
    });
    win.once("tauri://error", () => {
      readyLabel = null;
      spawning = false;
    });
    // NOTE: readyLabel is set by the warm-ready handshake, NOT here.
  } catch {
    spawning = false;
  }
}

/**
 * If a warm window has signalled ready, activate it for `path` and return true.
 * Otherwise return false so the caller spawns a normal window. On success,
 * spawns a replacement for the next time.
 */
export async function consumeWarmWindow(
  path: string,
  viewMode: ViewMode | undefined,
  at: { x: number; y: number } | undefined,
  seed: () => void,
): Promise<boolean> {
  const label = readyLabel;
  if (!label) return false;
  readyLabel = null; // claim it

  seed(); // write dir-seed so the activated window renders instantly

  const payload: WarmActivatePayload = {
    path,
    viewMode,
    x: at ? Math.round(at.x - 120) : undefined,
    y: at ? Math.round(at.y - 16) : undefined,
  };

  try {
    await emitTo(label, WARM_ACTIVATE_EVENT, payload);
    spawnWarmWindow(); // replenish
    return true;
  } catch {
    return false; // activation failed → caller falls back to a fresh window
  }
}

/**
 * Run inside a parked/measure warm window: register the activate-listener,
 * signal readiness to the parent, and — in measure mode — self-activate once so
 * we capture activation latency headlessly. Returns after wiring is set up.
 */
export async function runWarmWindow(measure: boolean): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const self = getCurrentWindow();

  let activated = false;
  await listen<WarmActivatePayload>(WARM_ACTIVATE_EVENT, async (event) => {
    if (activated) return; // one-shot
    activated = true;
    const tActivate = performance.now();
    const { path, viewMode, x, y } = event.payload;

    const explorer = windowTabsManager.getActiveExplorer();
    if (explorer) {
      if (viewMode) explorer.setViewMode(viewMode);
      void explorer.navigateTo(path);
    }

    try {
      if (typeof x === "number" && typeof y === "number") {
        const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
        await self.setPosition(new PhysicalPosition(x, y));
      }
      await self.show();
      await self.unminimize();
      await self.setFocus();
      // Briefly assert always-on-top so the freshly-shown window comes to the
      // front, then release so it behaves like a normal window.
      await self.setAlwaysOnTop(true);
      setTimeout(() => void self.setAlwaysOnTop(false), 300);
    } catch {
      // best effort
    }

    // Activation latency telemetry (event received → window shown), durable in
    // the app log next to the Rust `Startup:` line.
    const dt = performance.now() - tActivate;
    void invoke("log_startup_timing", {
      summary: `Startup(warm-activate): show=${dt.toFixed(1)}ms`,
    }).catch(() => {});
  });

  // Signal readiness to the parent (after the listener above is registered).
  await emit(WARM_READY_EVENT, { label: self.label } satisfies WarmReadyPayload);

  // Measure mode (?warm=measure): self-fire one activation so activation latency
  // can be captured headlessly, with no keypress. Not used in the shipped path.
  if (measure) {
    const home = (window as { __LAUNCH_DATA__?: { home: string } }).__LAUNCH_DATA__?.home ?? "/";
    await emitTo(self.label, WARM_ACTIVATE_EVENT, {
      path: home,
      x: 100,
      y: 100,
      measure: true,
    } satisfies WarmActivatePayload);
  }
}

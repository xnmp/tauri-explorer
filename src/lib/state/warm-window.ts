/**
 * Pre-warmed window pooling (settings.warmWindow).
 *
 * The dominant new-window cost is webview creation (~130–225 ms) plus a fresh
 * JS bundle parse. We keep ONE hidden window fully booted and parked; Ctrl+N
 * just navigates + shows it — skipping both costs — then spawns a replacement.
 *
 * POOL OWNERSHIP: the pool lives in Rust (warm_pool.rs), not JS module scope.
 * Every window talks to the same registry, so a window that was itself opened
 * via Ctrl+N can claim and replenish warm windows exactly like the original
 * one. Claims are atomic — two windows racing Ctrl+N can't both activate the
 * same warm window.
 *
 * READINESS HANDSHAKE: a warm window is only claimable once its
 * activate-listener is registered. The warm page calls warm_pool_register
 * AFTER listen(); claiming on mere `tauri://created` (window exists, JS not
 * booted) was an earlier bug — activation events fired into the void and
 * Ctrl+N appeared dead.
 *
 * POSITION: computed at consume time from the CLAIMING window's live
 * outerPosition/outerSize, mirroring the fresh-window path (+30/+30 cascade,
 * tear-off under cursor, parent-sized). The warm window's park position is
 * meaningless — an earlier bug left plain-Ctrl+N activations wherever the OS
 * had parked the hidden window.
 *
 * KNOWN RISK being measured: a hidden webview may defer expensive layout/
 * raster until shown (macOS WKWebView especially), so a warm window might not
 * have paid the cost we hope to skip. The `Startup(warm-activate): show=Xms`
 * log line (emitted on every activation) is the number that decides
 * keep-vs-kill.
 *
 * MEASURE MODE (`?warm=measure`): the warm window self-activates once it's
 * ready (no keypress), so activation latency can be captured headlessly.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "$lib/api/files";
import { windowTabsManager } from "./window-tabs.svelte";
import { explorerWindowAppearance } from "./window-appearance";
import type { ViewMode } from "./types";

// Reuse the "explorer-" label prefix so warm windows inherit the same Tauri
// capability/ACL scope as normal child windows (capabilities/default.json lists
// "explorer-*"). A distinct "warm-*" prefix would be denied event:listen etc.
// The "-warm-" infix identifies them (warm_pool.rs matches on it too).
const WARM_LABEL_PREFIX = "explorer-warm-";

/** Parent → warm window: "become a real window at this path." */
export const WARM_ACTIVATE_EVENT = "warm-activate";

export interface WarmActivatePayload {
  path: string;
  viewMode?: ViewMode;
  /** Physical-pixel geometry mirroring the fresh-window path; always set by
   *  consumeWarmWindow, optional only for the measure-mode self-fire. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Set on the measure-mode self-fire; used to dedupe vs real Ctrl+N. */
  measure?: boolean;
}

/** "1" = normal parked warm window; "measure" = self-firing measurement run. */
export function warmMode(): "off" | "park" | "measure" {
  if (typeof window === "undefined") return "off";
  const v = new URLSearchParams(window.location.search).get("warm");
  if (v === "measure") return "measure";
  if (v === "1") return "park";
  return "off";
}

/**
 * Create a hidden, parked warm window if the global pool wants one. The Rust
 * registry hands out at most one spawn reservation, so any number of windows
 * can call this concurrently (boot priming, post-consume replenish) without
 * over-spawning. The window becomes claimable only after it registers itself.
 */
export async function spawnWarmWindow(measure = false): Promise<void> {
  let reserved = false;
  try {
    reserved = await invoke<boolean>("warm_pool_begin_spawn");
  } catch {
    return; // not running in Tauri (e.g. browser E2E) — no pool
  }
  if (!reserved) return;

  const cancelReservation = () => void invoke("warm_pool_cancel_spawn").catch(() => {});

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

  try {
    const win = new WebviewWindow(label, {
      url: `${baseUrl}?${params.toString()}`,
      width: 1200,
      height: 800,
      visible: false,
      skipTaskbar: true,
      ...explorerWindowAppearance(),
    });
    win.once("tauri://error", cancelReservation);
  } catch {
    cancelReservation();
  }
}

/**
 * Claim a ready warm window from the global pool, activate it for `path`, and
 * return true. Returns false when none is ready (or activation fails) so the
 * caller spawns a normal window — Ctrl+N can never be a no-op. On a miss the
 * pool is primed so the NEXT new window is warm; on a hit a replacement is
 * spawned.
 */
export async function consumeWarmWindow(
  path: string,
  viewMode: ViewMode | undefined,
  at: { x: number; y: number } | undefined,
  seed: () => void,
): Promise<boolean> {
  let label: string | null = null;
  try {
    label = await invoke<string | null>("warm_pool_claim");
  } catch {
    return false; // not running in Tauri — fresh-window path handles it
  }
  if (!label) {
    void spawnWarmWindow();
    return false;
  }

  seed(); // write dir-seed so the activated window renders instantly

  // Geometry mirrors the fresh-window path, computed from THIS (claiming)
  // window at consume time: tear-off places the title bar under the cursor,
  // otherwise cascade +30/+30 from the current window, at its size.
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);

  const payload: WarmActivatePayload = {
    path,
    viewMode,
    x: at ? Math.round(at.x - 120) : pos.x + 30,
    y: at ? Math.round(at.y - 16) : pos.y + 30,
    width: size.width,
    height: size.height,
  };

  try {
    await emitTo(label, WARM_ACTIVATE_EVENT, payload);
    void spawnWarmWindow(); // replenish
    return true;
  } catch {
    return false; // activation failed → caller falls back to a fresh window
  }
}

/**
 * Run inside a parked/measure warm window: register the activate-listener,
 * then report ready to the Rust pool — in that order, so a claim can never
 * reach a window that isn't listening yet. In measure mode, self-activate once
 * so activation latency is captured headlessly.
 */
export async function runWarmWindow(measure: boolean): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const self = getCurrentWindow();

  let activated = false;
  await listen<WarmActivatePayload>(WARM_ACTIVATE_EVENT, async (event) => {
    if (activated) return; // one-shot
    activated = true;
    const tActivate = performance.now();
    const { path, viewMode, x, y, width, height } = event.payload;

    const explorer = windowTabsManager.getActiveExplorer();
    if (explorer) {
      if (viewMode) explorer.setViewMode(viewMode);
      void explorer.navigateTo(path);
    }

    try {
      const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
      if (typeof x === "number" && typeof y === "number") {
        await self.setPosition(new PhysicalPosition(x, y));
      }
      if (typeof width === "number" && typeof height === "number") {
        await self.setSize(new PhysicalSize(width, height));
      }
      await self.show();
      // Parked windows skip the taskbar; a revealed one is a real window.
      await self.setSkipTaskbar(false);
      await self.unminimize();
      await self.setFocus();
      // Briefly assert always-on-top so the freshly-shown window comes to the
      // front, then release so it behaves like a normal window.
      await self.setAlwaysOnTop(true);
      setTimeout(() => void self.setAlwaysOnTop(false), 300);
    } catch {
      // best effort — some calls are unsupported per platform (e.g. Wayland
      // ignores setPosition, macOS has no taskbar concept)
    }

    // Activation latency telemetry (event received → window shown), durable in
    // the app log next to the Rust `Startup:` line.
    const dt = performance.now() - tActivate;
    void invoke("log_startup_timing", {
      summary: `Startup(warm-activate): show=${dt.toFixed(1)}ms`,
    }).catch(() => {});
  });

  // Report ready to the global pool (after the listener above is registered).
  await invoke("warm_pool_register", { label: self.label }).catch(() => {});

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

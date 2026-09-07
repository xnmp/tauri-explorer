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
 * same warm window — and a claimed label counts as a REAL window in the
 * registry from that moment (labels are immutable, so the registry, not the
 * label, is what distinguishes an activated window from a parked one).
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
 * MEASURE MODE: launching the app with WARM_MEASURE=1 makes Rust spawn one
 * hidden measure window (flagged via the `__WARM_MEASURE__` global). It
 * self-activates once it's ready — no keypress — so activation latency can be
 * captured headlessly from the log on platforms without a WebDriver (macOS).
 * Measure windows never register with the pool: they are probes, not stock.
 */

import { createWarmActivation } from "./warm-activation";
import { requestWindowAcknowledgement, acknowledgeWindowRequest } from "./window-handoff";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { logStartupTiming } from "$lib/api/environment";
import {
  warmPoolActivate,
  warmPoolBeginSpawn,
  warmPoolCancelSpawn,
  warmPoolClaim,
  warmPoolDiscard,
  warmPoolRegister,
} from "$lib/api/warm-pool";
import { windowTabsManager } from "./window-tabs.svelte";
import { explorerWindowAppearance } from "./window-appearance";
import { settingsStore } from "./settings.svelte";
import { themeStore } from "./theme.svelte";
import type { ViewMode } from "./types";
import { normalizeWarmActivation, type WarmActivatePayload } from "$lib/domain/window-input";
export type { WarmActivatePayload } from "$lib/domain/window-input";
import { formatWindowTitle } from "../domain/tab-title";
import { resolveLaunchHomePath } from "./window-title.svelte";

// Reuse the "explorer-" label prefix so warm windows inherit the same Tauri
// capability/ACL scope as normal child windows (capabilities/default.json lists
// "explorer-*"). A distinct "warm-*" prefix would be denied event:listen etc.
// The "-warm-" infix identifies them (warm_pool.rs matches on it too).
const WARM_LABEL_PREFIX = "explorer-warm-";

/** Parent → warm window: "become a real window at this path." */
export const WARM_ACTIVATE_EVENT = "warm-activate";
const WARM_ACTIVATED_EVENT = "explorer://warm-activated";

/** "1" = normal parked warm window; "measure" = self-firing measurement run
 *  (Rust-spawned via WARM_MEASURE=1, flagged with the __WARM_MEASURE__
 *  global since its URL is fixed by WebviewUrl::App). */
export function warmMode(): "off" | "park" | "measure" {
  if (typeof window === "undefined") return "off";
  if ((window as { __WARM_MEASURE__?: boolean }).__WARM_MEASURE__) return "measure";
  if (new URLSearchParams(window.location.search).get("warm") === "1") return "park";
  return "off";
}

/**
 * Create a hidden, parked warm window if the global pool wants one. The Rust
 * registry hands out at most one spawn reservation, so any number of windows
 * can call this concurrently (boot priming, post-consume replenish) without
 * over-spawning. The window becomes claimable only after it registers itself.
 */
export async function spawnWarmWindow(): Promise<void> {
  const label = WARM_LABEL_PREFIX + crypto.randomUUID();
  let reserved = false;
  try {
    reserved = await warmPoolBeginSpawn(label);
  } catch {
    return; // not running in Tauri (e.g. browser E2E) — no pool
  }
  if (!reserved) return;

  const cancelReservation = () => void warmPoolCancelSpawn(label).catch(() => {});

  const baseUrl = window.location.origin + window.location.pathname;
  // Park the warm window at the SPAWNER's current path so its boot-time init
  // navigates somewhere valid. Without this it fell back to "/home" (nonexistent
  // on macOS), producing a broken, multi-second list load on activation.
  const homePath = resolveLaunchHomePath();
  const parkPath = windowTabsManager.getActiveExplorer()?.currentPath || homePath || "/";
  const params = new URLSearchParams({ warm: "1", path: parkPath });
  if (homePath) params.set("home", homePath);

  try {
    const win = new WebviewWindow(label, {
      url: `${baseUrl}?${params.toString()}`,
      width: 1200,
      height: 800,
      visible: false,
      skipTaskbar: true,
      ...explorerWindowAppearance(formatWindowTitle(parkPath, homePath)),
    });
    void win.once("tauri://error", cancelReservation).catch(cancelReservation);
  } catch {
    cancelReservation();
  }
}

/**
 * Claim a ready warm window from the global pool, activate it for `path`, and
 * return its label only after acknowledged reveal. Returns null on a miss or
 * failed activation so the caller spawns a normal window — Ctrl+N can never be a no-op. On a miss the
 * pool is primed so the NEXT new window is warm; on a hit a replacement is
 * spawned.
 *
 * (The claiming window does NOT seed directory entries: dir-seeds are only
 * consumed at boot by windowTabsManager.init, and a warm window booted long
 * ago — activation renders via a normal navigateTo instead.)
 */
export async function consumeWarmWindow(
  path: string,
  viewMode: ViewMode | undefined,
  at: { x: number; y: number } | undefined,
): Promise<string | null> {
  if (!normalizeWarmActivation({ path, viewMode })
    || (at && (!Number.isFinite(at.x) || !Number.isFinite(at.y)))) return null;
  let label: string | null = null;
  try {
    label = await warmPoolClaim();
  } catch {
    return null; // not running in Tauri — fresh-window path handles it
  }
  if (!label) {
    void spawnWarmWindow();
    return null;
  }

  // Everything after claiming shares one failure boundary. A native geometry
  // read can fail just like emitTo; either must retire the claimed window.
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const payload = normalizeWarmActivation({
      path, viewMode,
      x: at ? Math.round(at.x - 120) : pos.x + 30,
      y: at ? Math.round(at.y - 16) : pos.y + 30,
      width: size.width, height: size.height,
    });
    if (!payload) throw new Error("Invalid warm-window geometry");
    const activated = await requestWindowAcknowledgement(win.label, label, async (handoff) => {
      await emitTo(label!, WARM_ACTIVATE_EVENT, { ...payload, handoff });
    }, { event: WARM_ACTIVATED_EVENT });
    if (!activated) throw new Error("Warm destination did not acknowledge activation");
  } catch {
    await warmPoolDiscard(label).catch(() => {});
    return null;
  }
  void spawnWarmWindow(); // replenish
  return label;
}

/**
 * Run inside a parked/measure warm window: register the activate-listener,
 * then report ready to the Rust pool — in that order, so a claim can never
 * reach a window that isn't listening yet. In measure mode, self-activate once
 * so activation latency is captured headlessly (and skip pool registration —
 * a self-activated window must never be claimable).
 */
export function runWarmWindow(measure: boolean): { ready: Promise<boolean>; dispose(): void } {
  let started = 0;
  const self = getCurrentWindow();
  const owner = createWarmActivation({
    measure,
    acceptsActivation: () => windowTabsManager.acceptsTransfers,
    listen: (handler) => listen<unknown>(WARM_ACTIVATE_EVENT, ({ payload }) => handler(payload), { target: self.label }),
    register: async () => warmPoolRegister(self.label),
    refreshSettings: async (current) => {
      started = performance.now();
      try { await settingsStore.init(); if (current()) themeStore.syncFromSettings(); }
      catch { /* Keep boot-time preferences if the config cannot be read. */ }
    },
    navigate: async ({ path, viewMode }) => {
      const explorer = windowTabsManager.getActiveExplorer();
      if (!explorer) throw new Error("Warm destination has no active explorer");
      if (viewMode) explorer.setViewMode(viewMode);
      if (!await explorer.navigateTo(path, { autoEnterSingleSubdir: false })) throw new Error("Warm navigation failed or was superseded");
    },
    prepare: async ({ path, x, y, width, height }, current) => {
      try {
        const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
        if (!current()) return;
        if (x !== undefined && y !== undefined) await self.setPosition(new PhysicalPosition(x, y));
        if (!current()) return;
        if (width !== undefined && height !== undefined) await self.setSize(new PhysicalSize(width, height));
      } catch { /* Geometry is best effort on compositors such as Wayland. */ }
      if (current()) await self.setTitle(formatWindowTitle(path, resolveLaunchHomePath())).catch(() => {});
    },
    show: () => self.show(),
    commit: () => warmPoolActivate(self.label),
    focus: async (current) => {
      await self.setSkipTaskbar(false).catch(() => {});
      if (!current()) return;
      await self.unminimize().catch(() => {});
      if (current()) await self.setFocus().catch(() => {});
    },
    acknowledge: (request) => acknowledgeWindowRequest(request, self.label, WARM_ACTIVATED_EVENT),
    retire: () => warmPoolDiscard(self.label),
    reject: (request) => acknowledgeWindowRequest(request, self.label, WARM_ACTIVATED_EVENT, false),
    requestAddressBar: () => window.dispatchEvent(new Event("explorer:focus-address-bar")),
    shown: () => {
      void logStartupTiming(`Startup(warm-activate): show=${(performance.now() - started).toFixed(1)}ms`).catch(() => {});
    },
    reportError: (error) => console.error("Warm window activation failed:", error),
  });
  if (measure) {
    void owner.ready.then((ready) => ready ? owner.activate({ path: resolveLaunchHomePath() ?? "/", x: 100, y: 100, measure: true }) : undefined);
    started = performance.now();
  }
  return owner;
}

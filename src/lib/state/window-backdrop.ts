/**
 * Windows translucent backdrop (Mica / Acrylic).
 *
 * Acrylic's native tint is very thin, so we tint it with the current theme's
 * background colour at a user-controlled alpha (`windowsBackdropOpacity`) —
 * lower alpha = more see-through. Mica samples the desktop wallpaper and
 * ignores a tint colour on Windows 11, so it's left untinted.
 *
 * The same `Effects` object seeds new windows (build time) and is re-applied
 * at runtime via `setEffects`, so changing material/opacity/theme updates the
 * live window without a restart (only toggling the backdrop on from "off"
 * needs one, since window transparency is fixed at creation).
 */

import { Effect, type Effects, type Color } from "@tauri-apps/api/window";
import { isWindows } from "$lib/domain/platform";
import { settingsStore } from "./settings.svelte";

/** Read the active theme's solid background as an [r, g, b] triple (0-255). */
function themeBackgroundRgb(): [number, number, number] {
  const fallback: [number, number, number] = [30, 30, 32];
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--background-solid")
    .trim();
  if (!raw) return fallback;
  // Let the browser normalise any CSS colour (hex/rgb/named) to "rgb(r, g, b)".
  const probe = document.createElement("span");
  probe.style.color = raw;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const parts = computed.match(/\d+/g);
  if (!parts || parts.length < 3) return fallback;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Build the window `Effects` for the current backdrop settings, or undefined. */
export function windowsBackdropEffects(): Effects | undefined {
  if (!isWindows) return undefined;
  const mode = settingsStore.windowsBackdrop;
  if (mode === "off") return undefined;
  if (mode === "mica") return { effects: [Effect.Mica] };

  const [r, g, b] = themeBackgroundRgb();
  const alpha = Math.round(Math.min(100, Math.max(0, settingsStore.windowsBackdropOpacity)) * 2.55);
  const color: Color = [r, g, b, alpha];
  return { effects: [Effect.Acrylic], color };
}

/** Apply (or clear) the backdrop on the current window at runtime. No-op off Windows. */
export async function applyWindowsBackdrop(): Promise<void> {
  if (!isWindows) return;
  const effects = windowsBackdropEffects();
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (effects) {
      await win.setEffects(effects);
    } else {
      await win.clearEffects();
    }
  } catch (err) {
    console.error("Failed to apply window backdrop:", err);
  }
}

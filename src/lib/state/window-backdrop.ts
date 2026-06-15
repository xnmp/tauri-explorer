/**
 * Windows translucent backdrop (Mica / Acrylic).
 *
 * The native effect just turns the material on. We can't control Acrylic's
 * strength with the effect's tint colour — that's ignored on Windows 11 (it
 * only works on Windows 10 v1903+) — so strength is controlled in CSS instead:
 * `applyWindowsBackdrop` paints a theme-coloured tint over the window at a
 * user-chosen alpha (`windowsBackdropOpacity`). Lower alpha = more see-through.
 * This works the same on Windows 10 and 11.
 *
 * Mica samples the desktop wallpaper (never see-through to windows behind it),
 * so it's left untinted.
 *
 * The material is applied at runtime via `setEffects` and also seeds new
 * windows at build time, so changing material/opacity/theme updates the live
 * window without a restart — only enabling the backdrop from "off" needs one,
 * since window transparency is fixed at creation.
 */

import { Effect, type Effects } from "@tauri-apps/api/window";
import { isWindows } from "$lib/domain/platform";
import { settingsStore } from "./settings.svelte";

const BACKDROP_ATTR = "data-win-backdrop";
const TINT_ATTR = "data-win-acrylic";
const TINT_VAR = "--win-acrylic-tint";

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

/** Build the native window `Effects` (material only) for the current settings. */
export function windowsBackdropEffects(): Effects | undefined {
  if (!isWindows) return undefined;
  switch (settingsStore.windowsBackdrop) {
    case "mica":
      return { effects: [Effect.Mica] };
    case "acrylic":
      return { effects: [Effect.Acrylic] };
    default:
      return undefined;
  }
}

/** Set the CSS attributes/vars that style the app for the current backdrop. */
function applyBackdropStyling(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const mode = settingsStore.windowsBackdrop;

  // Any backdrop keeps the app's normal (darker) surface colours instead of the
  // lighter macOS island tint, so enabling Mica/Acrylic doesn't wash colours out.
  root.toggleAttribute(BACKDROP_ATTR, mode !== "off");

  // Acrylic strength tint controls how see-through it is. Mica isn't see-through
  // (it samples the wallpaper), so it gets no tint.
  if (mode === "acrylic") {
    const [r, g, b] = themeBackgroundRgb();
    const alpha = Math.min(100, Math.max(0, settingsStore.windowsBackdropOpacity)) / 100;
    root.style.setProperty(TINT_VAR, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    root.setAttribute(TINT_ATTR, "");
  } else {
    root.style.removeProperty(TINT_VAR);
    root.removeAttribute(TINT_ATTR);
  }
}

/** Apply (or clear) the backdrop on the current window at runtime. No-op off Windows. */
export async function applyWindowsBackdrop(): Promise<void> {
  if (!isWindows) return;
  applyBackdropStyling();
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

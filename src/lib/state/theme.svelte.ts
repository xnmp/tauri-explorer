/**
 * Theme state management using Svelte 5 runes.
 * Issue: tauri-explorer-l7lv, tauri-jvdk, tauri-explorer-0nut
 *
 * Themes are defined in CSS files at src/lib/themes/ (bundled)
 * and optionally in ~/.config/tauri-explorer/themes/ (user themes).
 *
 * Bundled themes: add CSS file + @import in index.css.
 * User themes: drop a CSS file in the config themes directory.
 * All themes are auto-discovered from CSS at runtime.
 */

import { listUserThemes, setWindowTheme } from "$lib/api/files";
import { loadPersisted, removePersisted } from "./persisted";
import { settingsStore } from "./settings.svelte";

interface ThemeColors {
  backgroundSolid: string;
  divider: string;
  accent: string;
}

export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  order: number;
  colors: ThemeColors;
}

/** Read a CSS custom property value, trimmed. */
function cssValue(style: CSSStyleDeclaration, prop: string): string {
  return style.getPropertyValue(prop).trim();
}

/** Strip CSS string quotes: "Foo" -> Foo */
function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** Parse int with a fallback (parseInt returns NaN for empty/missing values). */
function intOr(s: string, fallback: number): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Inject user theme CSS strings into the document as <style> elements.
 * Each gets a data attribute so we can identify/replace them later.
 */
function injectUserThemeStyles(themes: [string, string][]): void {
  // Remove previously injected user themes
  document
    .querySelectorAll("style[data-user-theme]")
    .forEach((el) => el.remove());

  for (const [filename, css] of themes) {
    const style = document.createElement("style");
    style.setAttribute("data-user-theme", filename);
    style.textContent = css;
    document.head.appendChild(style);
  }
}

/**
 * Scan loaded stylesheets for [data-theme="..."] rules and extract
 * metadata from CSS custom properties (--theme-name, --theme-description, etc.).
 */
function discoverThemes(): ThemeInfo[] {
  const themes: ThemeInfo[] = [];

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet
    }

    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule)) continue;

      const match = rule.selectorText.match(/\[data-theme="([^"]+)"\]/);
      if (!match) continue;

      const id = match[1];
      const style = rule.style;

      const name = cssValue(style, "--theme-name");
      if (!name) continue; // not a theme rule (or missing metadata)

      themes.push({
        id,
        name: unquote(name),
        description: unquote(cssValue(style, "--theme-description")),
        order: intOr(cssValue(style, "--theme-order"), 999),
        colors: {
          backgroundSolid: cssValue(style, "--background-solid"),
          divider: cssValue(style, "--divider"),
          accent: cssValue(style, "--accent"),
        },
      });
    }
  }

  return themes.sort((a, b) => a.order - b.order);
}

function createThemeState() {
  // Migrate from old standalone "theme" localStorage key (one-shot):
  // if settings doesn't have a theme yet, adopt the legacy value into
  // settings, then delete the legacy key so it can't resurrect stale state.
  const legacyTheme = loadPersisted<string | null>("theme", null);
  const initialTheme = settingsStore.theme !== "light" ? settingsStore.theme
    : legacyTheme || "light";
  if (legacyTheme !== null) {
    if (settingsStore.theme === "light" && legacyTheme !== "light") {
      settingsStore.setTheme(legacyTheme);
    }
    removePersisted("theme");
  }

  let currentThemeId = $state(initialTheme);
  let themes = $state<ThemeInfo[]>([]);

  // Apply the saved theme synchronously at store creation. The primary flash
  // fix lives in app.html's head script (runs before the bundle in every
  // window); this is a redundant safety net for environments where that script
  // didn't run as expected (dev/test/mock). Idempotent — sets the same value.
  // (Guarded for SSR/test environments where `document` is absent.)
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", initialTheme);
  }

  const currentTheme = $derived(
    themes.find((t) => t.id === currentThemeId) || themes[0],
  );

  function setTheme(themeId: string) {
    currentThemeId = themeId;
    settingsStore.setTheme(themeId);
    applyTheme(themeId);
  }

  function applyTheme(themeId: string) {
    document.documentElement.setAttribute("data-theme", themeId);
    requestAnimationFrame(() => {
      const raw = getComputedStyle(document.body).backgroundColor || "";
      if (raw) localStorage.setItem("explorer-bg", raw);
      const match = raw.match(/[\d.]+/g);
      if (match && match.length >= 3) {
        const vals = match.map(Number);
        const isFloat = vals[0] <= 1 && vals[1] <= 1 && vals[2] <= 1 && raw.includes("color(");
        const r = isFloat ? Math.round(vals[0] * 255) : vals[0];
        const g = isFloat ? Math.round(vals[1] * 255) : vals[1];
        const b = isFloat ? Math.round(vals[2] * 255) : vals[2];
        const a = vals[3] !== undefined
          ? Math.round((isFloat || vals[3] <= 1 ? vals[3] : vals[3] / 255) * 255)
          : 255;
        localStorage.setItem("explorer-bg-rgba", JSON.stringify([r, g, b, a]));
      }
      const colorScheme = getComputedStyle(document.documentElement).colorScheme;
      setWindowTheme(colorScheme === "light" ? "light" : "dark");
    });
  }

  /** Swap the visual theme without persisting it. Used by the theme picker
   *  for live preview while arrowing through options — so pressing Escape
   *  can restore the saved theme just by re-applying `currentThemeId`. */
  function previewTheme(themeId: string) {
    applyTheme(themeId);
  }

  async function initTheme() {
    // Load user themes from config dir and inject into DOM
    const result = await listUserThemes();
    if (result.ok && result.data.length > 0) {
      injectUserThemeStyles(result.data);
    }

    themes = discoverThemes();

    // If saved theme no longer exists, fall back to first available
    if (themes.length > 0 && !themes.some((t) => t.id === currentThemeId)) {
      currentThemeId = themes[0].id;
    }

    applyTheme(currentThemeId);
  }

  /** Re-sync theme from settings after settings.init() loads the config file. */
  function syncFromSettings() {
    const fileTheme = settingsStore.theme;
    if (fileTheme && fileTheme !== currentThemeId) {
      currentThemeId = fileTheme;
      applyTheme(fileTheme);
    }
  }

  return {
    get currentThemeId() {
      return currentThemeId;
    },
    get currentTheme() {
      return currentTheme;
    },
    get availableThemes() {
      return themes;
    },
    setTheme,
    previewTheme,
    initTheme,
    syncFromSettings,
  };
}

export const themeStore = createThemeState();

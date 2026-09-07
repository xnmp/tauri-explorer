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

import { dedupeThemesById, resolveThemeId } from "$lib/domain/theme-list";
import { listUserThemes } from "$lib/api/config";
import { setWindowTheme } from "$lib/api/system";
import { EXPLORER_BG_RGBA_KEY, loadPersisted, removePersisted, savePersisted, savePersistedRaw } from "./persisted";
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

  // Last occurrence wins: user themes are injected after built-ins, so a
  // reused id resolves to the rules that actually paint (#585).
  return dedupeThemesById(themes).sort((a, b) => a.order - b.order);
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
  // The theme actually painted on the DOM right now — diverges from
  // currentThemeId during picker live-previews. Consumers that must repaint
  // imperatively on any visual theme change (e.g. the terminal) key on this.
  let appliedThemeId = $state(initialTheme);
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
    appliedThemeId = themeId;
    // Keep the shared hljs token palette (themes/syntax.css) in sync with the
    // theme's color-scheme. getComputedStyle here forces a synchronous style
    // recalc, so the class flips in the same frame as the theme (#246).
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    document.documentElement.classList.toggle("hljs-light", scheme === "light");
    document.documentElement.classList.toggle("hljs-dark", scheme !== "light");
    requestAnimationFrame(() => {
      const raw = getComputedStyle(document.body).backgroundColor || "";
      // Raw CSS color string, not JSON — app.html's pre-paint script reads
      // this key directly, so the exact format must be preserved.
      if (raw) savePersistedRaw("explorer-bg", raw);
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
        savePersisted(EXPLORER_BG_RGBA_KEY, [r, g, b, a]);
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

  /**
   * Apply the resolved form of `requested`.
   *
   * The fallback is deliberately NOT written back to settings. A user theme
   * can be missing for a boring, temporary reason — the CSS file was moved, or
   * `listUserThemes` failed once — and persisting the fallback would turn that
   * into a permanent loss of the user's choice. Settings keeps naming the
   * theme they picked; restoring the file restores it.
   *
   * That is only safe because every reader resolves: `syncFromSettings` below
   * compares the *resolved* id, so an unpersisted fallback is not undone by
   * the next reload re-applying the missing name.
   */
  function applyResolvedTheme(requested: string): void {
    currentThemeId = resolveThemeId(themes, requested);
    applyTheme(currentThemeId);
  }

  async function initTheme() {
    // Load user themes from config dir and inject into DOM
    const result = await listUserThemes();
    if (result.ok && result.data.length > 0) {
      injectUserThemeStyles(result.data);
    }

    themes = discoverThemes();

    // Resolve from settings, not from `currentThemeId`: after a fallback, the
    // live id is the substitute, and re-running this (a themes/*.css file
    // reappearing, #599) must be able to return to the theme the user chose.
    applyResolvedTheme(settingsStore.theme || currentThemeId);
  }

  /** Re-sync theme from settings after settings.init() loads the config file,
   *  and after an external settings.json edit (#599). */
  function syncFromSettings() {
    const fileTheme = settingsStore.theme;
    if (!fileTheme) return;
    if (resolveThemeId(themes, fileTheme) === currentThemeId) return;
    applyResolvedTheme(fileTheme);
  }

  return {
    get currentThemeId() {
      return currentThemeId;
    },
    get appliedThemeId() {
      return appliedThemeId;
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

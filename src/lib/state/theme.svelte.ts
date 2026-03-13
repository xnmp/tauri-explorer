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

import { listUserThemes } from "$lib/api/files";
import { loadPersisted, savePersisted } from "./persisted";

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
  const savedTheme = loadPersisted<string | null>("theme", null);

  let currentThemeId = $state(savedTheme || "light");
  let themes = $state<ThemeInfo[]>([]);

  const currentTheme = $derived(
    themes.find((t) => t.id === currentThemeId) || themes[0],
  );

  function setTheme(themeId: string) {
    currentThemeId = themeId;
    savePersisted("theme", themeId);
    applyTheme(themeId);
  }

  function applyTheme(themeId: string) {
    document.documentElement.setAttribute("data-theme", themeId);
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
    initTheme,
  };
}

export const themeStore = createThemeState();

/**
 * Theme state management using Svelte 5 runes.
 * Issue: tauri-explorer-l7lv, tauri-jvdk
 *
 * Themes are defined in CSS files at src/lib/themes/
 * To add a new theme:
 * 1. Create a CSS file in src/lib/themes/ (copy an existing one)
 * 2. Add @import to src/lib/themes/index.css
 * That's it - themes are auto-discovered from CSS at runtime.
 */

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

/** Strip CSS string quotes: "Foo" -> Foo */
const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, "");

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
      const s = rule.style;

      const name = s.getPropertyValue("--theme-name");
      if (!name) continue; // not a theme rule (or missing metadata)

      themes.push({
        id,
        name: unquote(name),
        description: unquote(s.getPropertyValue("--theme-description")),
        order: parseInt(s.getPropertyValue("--theme-order"), 10) || 999,
        colors: {
          backgroundSolid: s.getPropertyValue("--background-solid").trim(),
          divider: s.getPropertyValue("--divider").trim(),
          accent: s.getPropertyValue("--accent").trim(),
        },
      });
    }
  }

  return themes.sort((a, b) => a.order - b.order);
}

function createThemeState() {
  const savedTheme = typeof localStorage !== "undefined"
    ? localStorage.getItem("theme")
    : null;

  let currentThemeId = $state(savedTheme || "light");
  let themes = $state<ThemeInfo[]>([]);

  const currentTheme = $derived(
    themes.find((t) => t.id === currentThemeId) || themes[0],
  );

  function setTheme(themeId: string) {
    currentThemeId = themeId;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("theme", themeId);
    }
    applyTheme(themeId);
  }

  function applyTheme(themeId: string) {
    document.documentElement.setAttribute("data-theme", themeId);
  }

  function initTheme() {
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

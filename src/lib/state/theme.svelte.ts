/**
 * Theme state management using Svelte 5 runes.
 * Issue: tauri-explorer-l7lv
 *
 * Themes are defined in CSS files at src/lib/themes/
 * To add a new theme:
 * 1. Create a CSS file in src/lib/themes/ (copy an existing one)
 * 2. Add @import to src/lib/themes/index.css
 * 3. Add the theme to availableThemes below
 */

export type ThemeId = "light" | "dark" | "solarized-light";

interface ThemeColors {
  backgroundSolid: string;
  divider: string;
  accent: string;
}

interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  colors: ThemeColors;
}

// Available themes - add new themes here
// Colors are duplicated from CSS for the theme preview in ThemeSwitcher
const availableThemes: ThemeInfo[] = [
  {
    id: "light",
    name: "Light",
    description: "Clean white theme (default)",
    colors: {
      backgroundSolid: "#f3f3f3",
      divider: "rgba(0, 0, 0, 0.0803)",
      accent: "#0078d4",
    },
  },
  {
    id: "dark",
    name: "Dark",
    description: "Comfortable dark mode",
    colors: {
      backgroundSolid: "#2d2d2d",
      divider: "rgba(255, 255, 255, 0.1)",
      accent: "#60cdff",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "Warm cream tones, easy on the eyes",
    colors: {
      backgroundSolid: "#fdf6e3",
      divider: "rgba(101, 123, 131, 0.2)",
      accent: "#268bd2",
    },
  },
];

function createThemeState() {
  // Load saved theme from localStorage
  const savedTheme = typeof localStorage !== "undefined"
    ? (localStorage.getItem("theme") as ThemeId | null)
    : null;

  let currentThemeId = $state<ThemeId>(savedTheme || "light");

  const currentTheme = $derived(
    availableThemes.find((t) => t.id === currentThemeId) || availableThemes[0]
  );

  function setTheme(themeId: ThemeId) {
    currentThemeId = themeId;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("theme", themeId);
    }
    applyTheme(themeId);
  }

  function applyTheme(themeId: ThemeId) {
    // Simply set the data-theme attribute - CSS handles the rest
    document.documentElement.setAttribute("data-theme", themeId);
  }

  function initTheme() {
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
      return availableThemes;
    },
    setTheme,
    initTheme,
  };
}

export const themeStore = createThemeState();

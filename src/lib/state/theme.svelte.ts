/**
 * Theme state management using Svelte 5 runes.
 * Issue: tauri-explorer-l7lv
 */

export type ThemeId = "light" | "dark" | "solarized-light";

interface ThemeColors {
  // Accent colors
  accent: string;
  accentLight: string;
  accentDark: string;

  // Text colors
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnAccent: string;

  // Background colors
  backgroundSolid: string;
  backgroundMica: string;
  backgroundAcrylic: string;
  backgroundCard: string;
  backgroundCardSecondary: string;

  // Surface colors
  surfaceStroke: string;
  surfaceStrokeFlyout: string;
  divider: string;

  // Control colors
  controlFill: string;
  controlFillSecondary: string;
  controlFillTertiary: string;
  controlFillDisabled: string;

  // Subtle fills
  subtleFill: string;
  subtleFillSecondary: string;
  subtleFillTertiary: string;

  // Strokes
  controlStroke: string;
  controlStrokeSecondary: string;

  // Focus
  focusStrokeOuter: string;
  focusStrokeInner: string;

  // System colors
  systemCritical: string;
  systemSuccess: string;
  systemCaution: string;

  // Shadows
  shadowFlyout: string;
  shadowDialog: string;
  shadowTooltip: string;
}

interface Theme {
  id: ThemeId;
  name: string;
  colors: ThemeColors;
}

// Light theme (default) - Windows 11 style
const lightTheme: Theme = {
  id: "light",
  name: "Light",
  colors: {
    accent: "#0078d4",
    accentLight: "#60cdff",
    accentDark: "#005a9e",

    textPrimary: "#1a1a1a",
    textSecondary: "#5d5d5d",
    textTertiary: "#8a8a8a",
    textOnAccent: "#ffffff",

    backgroundSolid: "#f3f3f3",
    backgroundMica: "rgba(243, 243, 243, 0.85)",
    backgroundAcrylic: "rgba(255, 255, 255, 0.7)",
    backgroundCard: "rgba(255, 255, 255, 0.7)",
    backgroundCardSecondary: "rgba(249, 249, 249, 0.5)",

    surfaceStroke: "rgba(0, 0, 0, 0.0578)",
    surfaceStrokeFlyout: "rgba(0, 0, 0, 0.0326)",
    divider: "rgba(0, 0, 0, 0.0803)",

    controlFill: "rgba(255, 255, 255, 0.7)",
    controlFillSecondary: "rgba(249, 249, 249, 0.5)",
    controlFillTertiary: "rgba(249, 249, 249, 0.3)",
    controlFillDisabled: "rgba(249, 249, 249, 0.3)",

    subtleFill: "transparent",
    subtleFillSecondary: "rgba(0, 0, 0, 0.0373)",
    subtleFillTertiary: "rgba(0, 0, 0, 0.0241)",

    controlStroke: "rgba(0, 0, 0, 0.0578)",
    controlStrokeSecondary: "rgba(0, 0, 0, 0.1622)",

    focusStrokeOuter: "#000000",
    focusStrokeInner: "#ffffff",

    systemCritical: "#c42b1c",
    systemSuccess: "#0f7b0f",
    systemCaution: "#9d5d00",

    shadowFlyout: "0 8px 16px rgba(0, 0, 0, 0.14)",
    shadowDialog: "0 32px 64px rgba(0, 0, 0, 0.24), 0 2px 21px rgba(0, 0, 0, 0.18)",
    shadowTooltip: "0 4px 8px rgba(0, 0, 0, 0.14)",
  },
};

// Dark theme - Windows 11 style
const darkTheme: Theme = {
  id: "dark",
  name: "Dark",
  colors: {
    accent: "#60cdff",
    accentLight: "#98ecff",
    accentDark: "#0078d4",

    textPrimary: "#ffffff",
    textSecondary: "#c5c5c5",
    textTertiary: "#9d9d9d",
    textOnAccent: "#000000",

    backgroundSolid: "#202020",
    backgroundMica: "rgba(32, 32, 32, 0.9)",
    backgroundAcrylic: "rgba(44, 44, 44, 0.96)",
    backgroundCard: "rgba(255, 255, 255, 0.0512)",
    backgroundCardSecondary: "rgba(255, 255, 255, 0.0326)",

    surfaceStroke: "rgba(255, 255, 255, 0.0698)",
    surfaceStrokeFlyout: "rgba(255, 255, 255, 0.093)",
    divider: "rgba(255, 255, 255, 0.0837)",

    controlFill: "rgba(255, 255, 255, 0.0605)",
    controlFillSecondary: "rgba(255, 255, 255, 0.0837)",
    controlFillTertiary: "rgba(255, 255, 255, 0.0326)",
    controlFillDisabled: "rgba(255, 255, 255, 0.0419)",

    subtleFill: "transparent",
    subtleFillSecondary: "rgba(255, 255, 255, 0.0605)",
    subtleFillTertiary: "rgba(255, 255, 255, 0.0419)",

    controlStroke: "rgba(255, 255, 255, 0.093)",
    controlStrokeSecondary: "rgba(255, 255, 255, 0.0698)",

    focusStrokeOuter: "#ffffff",
    focusStrokeInner: "#000000",

    systemCritical: "#ff99a4",
    systemSuccess: "#6ccb5f",
    systemCaution: "#fce100",

    shadowFlyout: "0 8px 16px rgba(0, 0, 0, 0.26)",
    shadowDialog: "0 32px 64px rgba(0, 0, 0, 0.32), 0 2px 21px rgba(0, 0, 0, 0.24)",
    shadowTooltip: "0 4px 8px rgba(0, 0, 0, 0.26)",
  },
};

// Solarized Light theme - warm, easy on the eyes
const solarizedLightTheme: Theme = {
  id: "solarized-light",
  name: "Solarized Light",
  colors: {
    accent: "#268bd2", // Solarized blue
    accentLight: "#2aa198", // Solarized cyan
    accentDark: "#073642", // Solarized base02

    textPrimary: "#657b83", // Solarized base00
    textSecondary: "#839496", // Solarized base0
    textTertiary: "#93a1a1", // Solarized base1
    textOnAccent: "#fdf6e3", // Solarized base3

    backgroundSolid: "#fdf6e3", // Solarized base3
    backgroundMica: "rgba(253, 246, 227, 0.92)",
    backgroundAcrylic: "rgba(238, 232, 213, 0.85)", // Solarized base2
    backgroundCard: "rgba(238, 232, 213, 0.6)",
    backgroundCardSecondary: "rgba(238, 232, 213, 0.4)",

    surfaceStroke: "rgba(101, 123, 131, 0.15)",
    surfaceStrokeFlyout: "rgba(101, 123, 131, 0.1)",
    divider: "rgba(101, 123, 131, 0.2)",

    controlFill: "rgba(238, 232, 213, 0.7)",
    controlFillSecondary: "rgba(238, 232, 213, 0.5)",
    controlFillTertiary: "rgba(238, 232, 213, 0.3)",
    controlFillDisabled: "rgba(238, 232, 213, 0.3)",

    subtleFill: "transparent",
    subtleFillSecondary: "rgba(101, 123, 131, 0.08)",
    subtleFillTertiary: "rgba(101, 123, 131, 0.05)",

    controlStroke: "rgba(101, 123, 131, 0.2)",
    controlStrokeSecondary: "rgba(101, 123, 131, 0.3)",

    focusStrokeOuter: "#268bd2",
    focusStrokeInner: "#fdf6e3",

    systemCritical: "#dc322f", // Solarized red
    systemSuccess: "#859900", // Solarized green
    systemCaution: "#b58900", // Solarized yellow

    shadowFlyout: "0 8px 16px rgba(0, 43, 54, 0.12)",
    shadowDialog: "0 32px 64px rgba(0, 43, 54, 0.2), 0 2px 21px rgba(0, 43, 54, 0.14)",
    shadowTooltip: "0 4px 8px rgba(0, 43, 54, 0.12)",
  },
};

const themes: Record<ThemeId, Theme> = {
  light: lightTheme,
  dark: darkTheme,
  "solarized-light": solarizedLightTheme,
};

function createThemeState() {
  // Load saved theme from localStorage
  const savedTheme = typeof localStorage !== "undefined"
    ? (localStorage.getItem("theme") as ThemeId | null)
    : null;

  let currentThemeId = $state<ThemeId>(savedTheme || "light");

  const currentTheme = $derived(themes[currentThemeId]);

  function setTheme(themeId: ThemeId) {
    currentThemeId = themeId;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("theme", themeId);
    }
    applyTheme(themes[themeId]);
  }

  function applyTheme(theme: Theme) {
    const root = document.documentElement;
    const colors = theme.colors;

    root.style.setProperty("--accent", colors.accent);
    root.style.setProperty("--accent-light", colors.accentLight);
    root.style.setProperty("--accent-dark", colors.accentDark);

    root.style.setProperty("--text-primary", colors.textPrimary);
    root.style.setProperty("--text-secondary", colors.textSecondary);
    root.style.setProperty("--text-tertiary", colors.textTertiary);
    root.style.setProperty("--text-on-accent", colors.textOnAccent);

    root.style.setProperty("--background-solid", colors.backgroundSolid);
    root.style.setProperty("--background-mica", colors.backgroundMica);
    root.style.setProperty("--background-acrylic", colors.backgroundAcrylic);
    root.style.setProperty("--background-card", colors.backgroundCard);
    root.style.setProperty("--background-card-secondary", colors.backgroundCardSecondary);

    root.style.setProperty("--surface-stroke", colors.surfaceStroke);
    root.style.setProperty("--surface-stroke-flyout", colors.surfaceStrokeFlyout);
    root.style.setProperty("--divider", colors.divider);

    root.style.setProperty("--control-fill", colors.controlFill);
    root.style.setProperty("--control-fill-secondary", colors.controlFillSecondary);
    root.style.setProperty("--control-fill-tertiary", colors.controlFillTertiary);
    root.style.setProperty("--control-fill-disabled", colors.controlFillDisabled);

    root.style.setProperty("--subtle-fill", colors.subtleFill);
    root.style.setProperty("--subtle-fill-secondary", colors.subtleFillSecondary);
    root.style.setProperty("--subtle-fill-tertiary", colors.subtleFillTertiary);

    root.style.setProperty("--control-stroke", colors.controlStroke);
    root.style.setProperty("--control-stroke-secondary", colors.controlStrokeSecondary);

    root.style.setProperty("--focus-stroke-outer", colors.focusStrokeOuter);
    root.style.setProperty("--focus-stroke-inner", colors.focusStrokeInner);

    root.style.setProperty("--system-critical", colors.systemCritical);
    root.style.setProperty("--system-success", colors.systemSuccess);
    root.style.setProperty("--system-caution", colors.systemCaution);

    root.style.setProperty("--shadow-flyout", colors.shadowFlyout);
    root.style.setProperty("--shadow-dialog", colors.shadowDialog);
    root.style.setProperty("--shadow-tooltip", colors.shadowTooltip);
  }

  function initTheme() {
    applyTheme(currentTheme);
  }

  return {
    get currentThemeId() {
      return currentThemeId;
    },
    get currentTheme() {
      return currentTheme;
    },
    get availableThemes() {
      return Object.values(themes);
    },
    setTheme,
    initTheme,
  };
}

export const themeStore = createThemeState();

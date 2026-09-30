import type { NativeWindowState, QualificationCase } from "./types";

/** The closed child is gone; only the visible main window and one hidden spare may remain. */
export function nativeWindowsCleanAfterClose(
  states: readonly NativeWindowState[],
  mainLabel: string,
  closedLabel: string,
): boolean {
  return states.length >= 1 && states.length <= 2 &&
    states.filter(({ label, visible }) => label === mainLabel && visible).length === 1 &&
    !states.some(({ label }) => label === closedLabel) &&
    states.every(({ label, visible }) => label === mainLabel || !visible);
}

/** A forced fresh launch has exactly one handle absent before the launch. */
export function selectFreshWindowHandle(
  before: readonly string[],
  after: readonly string[],
): string | null {
  const existing = new Set(before);
  const created = after.filter((handle) => !existing.has(handle));
  return created.length === 1 ? created[0] : null;
}

/**
 * Bounded pairwise coverage, not a Cartesian product. `required` means the row
 * is release acceptance; browser-only and unavailable recovery rows remain
 * visible so a report cannot accidentally present them as native proof.
 */
export const NATIVE_QUALIFICATION_MATRIX: readonly QualificationCase[] = [
  {
    id: "linux-window-workspace-churn",
    risk: "window-workspace-churn",
    platforms: ["linux"],
    scenario:
      "Create and close native WebKitGTK windows while alternating two real scratch workspaces.",
    userVisibleOutcome:
      "Every surviving window renders the requested workspace path and a usable file listing.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "window-workspace",
  },
  {
    id: "windows-window-workspace-churn",
    risk: "window-workspace-churn",
    platforms: ["windows"],
    scenario:
      "Create and close native WebView2 windows while alternating two real scratch workspaces.",
    userVisibleOutcome:
      "Every surviving window renders the requested workspace path and a usable file listing.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "window-workspace",
  },
  {
    id: "native-plugin-churn",
    risk: "plugin-churn",
    platforms: ["linux", "windows"],
    scenario:
      "Enable, invoke, and disable the bundled demo plugin around interrupted palette sessions.",
    userVisibleOutcome:
      "The demo command appears when enabled, shows its success toast, and disappears when disabled.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "plugin-churn",
  },
  {
    id: "linux-theme-accessibility",
    risk: "theme-accessibility",
    platforms: ["linux"],
    scenario:
      "Toggle theme through the keyboard-only command palette under WebKitGTK.",
    userVisibleOutcome:
      "The first keyboard invocation changes the rendered theme and the labelled palette remains operable.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "windows-theme-accessibility",
    risk: "theme-accessibility",
    platforms: ["windows"],
    scenario:
      "Toggle theme through the keyboard-only command palette under WebView2.",
    userVisibleOutcome:
      "The first keyboard invocation changes the rendered theme and the labelled palette remains operable.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "native-preview-pair",
    risk: "preview",
    platforms: ["linux", "windows"],
    scenario:
      "Alternate real Markdown and plain-text files while workspace and plugin state churns.",
    userVisibleOutcome:
      "Markdown headings and exact plain-text content render in the native preview pane after selection.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "preview-native-input",
  },
  {
    id: "native-zoom-pair",
    risk: "dpi-zoom",
    platforms: ["linux", "windows"],
    scenario:
      "Exercise 80, 100, and 150 percent application zoom while recording the runner display scale.",
    userVisibleOutcome:
      "The visible explorer and keyboard palette remain inside the viewport and usable at each zoom level.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "theme-accessibility-zoom",
  },
  {
    id: "native-keyboard-input",
    risk: "native-input",
    platforms: ["linux", "windows"],
    scenario:
      "Interrupt navigation with Escape and refresh, then select a real file using native key events.",
    userVisibleOutcome:
      "The active file row visibly receives selection and the explorer remains responsive to shortcuts.",
    proof: "native-webdriver",
    required: true,
    soakScenario: "preview-native-input",
  },
  {
    id: "macos-startup-measurement",
    risk: "window-workspace-churn",
    platforms: ["macos"],
    scenario:
      "Measure cold startup and warm activation from the built application on a real macOS runner.",
    userVisibleOutcome:
      "The native process reaches its startup markers, remains alive, and records cold and warm timing samples.",
    proof: "real-macos-process",
    required: true,
  },
  {
    id: "expanded-browser-combinations",
    risk: "theme-accessibility",
    platforms: ["linux", "windows", "macos"],
    scenario:
      "Exercise additional theme, reduced-motion, preview, and viewport combinations in browser Playwright.",
    userVisibleOutcome:
      "Selected combinations render their expected labels, previews, focus state, and viewport containment.",
    proof: "browser-only",
    required: false,
  },
  {
    id: "platform-recovery-adapters",
    risk: "recovery",
    platforms: ["linux", "windows", "macos"],
    scenario:
      "Qualify each platform recovery adapter only after that recovery capability is implemented.",
    userVisibleOutcome:
      "Implemented recovery restores a usable explorer without presenting unimplemented behavior as required.",
    proof: "not-implemented",
    required: false,
  },
] as const;

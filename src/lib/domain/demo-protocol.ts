/**
 * The site demo's host bridge protocol (version 1): the postMessage envelope
 * between the marketing page (host) and the embedded app, and how a host
 * page's custom colour theme and an "opened" file are described. Documented
 * for host authors in `overhaul/bridge/README.md`. Pure and framework-free.
 */
import type { DemoMedia } from "./demo-fixture";
import { buildTheme } from "./theme-from-palette";

export const DEMO_PROTOCOL = "tauri-explorer";
export const DEMO_PROTOCOL_VERSION = 1;

/** Everything the host may send before the app boots. */
export interface DemoInit {
  fixture?: unknown;
  assetBase?: string;
  user?: string;
  settings?: Record<string, unknown>;
  keybindings?: Record<string, string | null>;
  startPath?: string;
}

export type DemoHostMessage =
  | { type: "init"; init: DemoInit }
  | { type: "request"; id: string | number; method: string; params: unknown[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate a host message; null for anything that is not protocol v1. */
export function parseHostMessage(data: unknown): DemoHostMessage | null {
  if (!isRecord(data) || data.tx !== DEMO_PROTOCOL || data.v !== DEMO_PROTOCOL_VERSION) return null;
  if (data.type === "init") {
    const init: DemoInit = {};
    if ("fixture" in data) init.fixture = data.fixture;
    if (typeof data.assetBase === "string") init.assetBase = data.assetBase;
    if (typeof data.user === "string") init.user = data.user;
    if (isRecord(data.settings)) init.settings = data.settings;
    if (isRecord(data.keybindings)) {
      init.keybindings = Object.fromEntries(Object.entries(data.keybindings)
        .filter((entry): entry is [string, string | null] => typeof entry[1] === "string" || entry[1] === null));
    }
    if (typeof data.startPath === "string" && data.startPath.startsWith("/")) init.startPath = data.startPath;
    return { type: "init", init };
  }
  if (data.type === "request" && (typeof data.id === "string" || typeof data.id === "number") && typeof data.method === "string") {
    return { type: "request", id: data.id, method: data.method, params: Array.isArray(data.params) ? data.params : [] };
  }
  return null;
}

export function appMessage(type: "hello" | "event" | "response", body: Record<string, unknown>): Record<string, unknown> {
  return { tx: DEMO_PROTOCOL, v: DEMO_PROTOCOL_VERSION, type, ...body };
}

/** A host page's custom colour theme: `v` is [paper, panel, ink, ink2, accent, folder]. */
export interface DemoCustomTheme {
  name: string;
  dark: boolean;
  v: [string, string, string, string, string, string];
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseCustomTheme(value: unknown): DemoCustomTheme | null {
  if (!isRecord(value) || !Array.isArray(value.v) || value.v.length !== 6) return null;
  if (!value.v.every((c) => typeof c === "string" && HEX.test(c))) return null;
  // The name lands inside a CSS string: keep only characters that cannot end it.
  const cleaned = typeof value.name === "string" ? value.name.replace(/["'\\<>{};\n\r]/g, "").trim().slice(0, 60) : "";
  const name = cleaned || "Custom";
  return { name, dark: value.dark === true, v: value.v as DemoCustomTheme["v"] };
}

export function customThemeId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `site-${slug || "custom"}`;
}

/** Least alpha of a custom theme's panel layer: about a built-in dark
 *  theme's card (#1789). */
export const CUSTOM_PANEL_MIN_ALPHA = 0.5;

const channels = (hex: string): [number, number, number] => {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c).slice(1) : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};

/**
 * The translucent layer that, painted over `paper`, shows exactly `panel`:
 * the least alpha (from `minAlpha`) whose colour stays inside sRGB.
 *
 * Every theme's panels are translucent cards over its base (the stack the
 * window material fades, #1757). A host's panel colour given as an opaque
 * card hid the material entirely: the window stayed solid at every
 * Translucency Opacity (#1789). Over its paper this layer looks the same.
 */
export function panelLayerOver(paper: string, panel: string, minAlpha = CUSTOM_PANEL_MIN_ALPHA): string {
  const p = channels(paper);
  const q = channels(panel);
  const floor = Math.min(1, Math.max(0, minAlpha));
  const least = q.reduce((a, qc, i) => {
    const pc = p[i];
    if (qc > pc) return Math.max(a, (qc - pc) / (255 - pc));
    if (qc < pc) return Math.max(a, (pc - qc) / pc);
    return a;
  }, floor);
  // Rounded up, so the colour derived from it stays in gamut.
  const alpha = Math.min(1, Math.ceil(least * 1000 - 1e-9) / 1000);
  const rgb = q.map((qc, i) => Math.round(Math.min(255, Math.max(0, p[i] + (qc - p[i]) / alpha)) * 100) / 100);
  return `rgba(${rgb.join(", ")}, ${alpha})`;
}

/**
 * Override rules layered after a generated base theme: the six host colours
 * set the surfaces, text, accent and folder tokens directly.
 */
export function customThemeOverrides(id: string, theme: DemoCustomTheme): string {
  const [paper, panel, ink, ink2, accent, folder] = theme.v;
  const panelLayer = panelLayerOver(paper, panel);
  return `[data-theme="${id}"] {
  --theme-description: "Custom colours from the page";
  color-scheme: ${theme.dark ? "dark" : "light"};
  --background-solid: ${paper};
  --theme-background-image: none;
  --background-card: ${panelLayer};
  --background-card-secondary: ${panelLayer};
  --miller-bg: ${panel};
  --text-primary: ${ink};
  --text-secondary: ${ink2};
  --accent: ${accent};
  --focus-stroke-outer: ${accent};
  --icon-folder: ${folder};
}
`;
}

/**
 * A complete theme stylesheet for a host colour theme: the palette generator
 * fills every token from the six colours (surface first), then the host's
 * exact colours override the tokens they name.
 */
export function buildCustomThemeCss(id: string, theme: DemoCustomTheme): string | null {
  const [paper, panel, ink, ink2, accent, folder] = theme.v;
  const base = buildTheme([paper, accent, folder, panel, ink, ink2], id, theme.name);
  return base ? `${base.css}\n${customThemeOverrides(id, theme)}` : null;
}

export type DemoOpenKind = "markdown" | "text" | "csv" | "image" | "video" | "audio" | "pdf" | "binary";

const TYPE_HINTS: Record<string, DemoOpenKind> = {
  md: "markdown", txt: "text", csv: "csv", code: "text", svelte: "text", audio: "audio",
  img: "image", image: "image", video: "video", pdf: "pdf", app: "binary", file: "binary",
};
const AUDIO = /\.(mp3|flac|wav|ogg|oga|m4a|aac|opus|aiff?)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv|m4v|avi)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|heic|tiff?)$/i;

/** What kind of viewer the host should open a file in. */
export function demoOpenKind(name: string, input: { text: string | null; media: DemoMedia | undefined; typeHint?: string }): DemoOpenKind {
  if (input.media) return input.media.kind;
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  if (/\.(csv|tsv)$/i.test(name)) return "csv";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (AUDIO.test(name)) return "audio";
  if (VIDEO.test(name)) return "video";
  if (IMAGE.test(name)) return "image";
  const hinted = input.typeHint ? TYPE_HINTS[input.typeHint] : undefined;
  if (hinted) return hinted;
  return input.text !== null ? "text" : "binary";
}

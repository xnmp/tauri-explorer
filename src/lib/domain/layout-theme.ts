/**
 * Layout themes (#1306): pure catalog, metadata, resolution and fallback.
 *
 * A layout theme is a stylesheet that restyles the application's panel
 * chrome — spacing, panel surfaces, borders, rounding, row density —
 * independently of the colour theme. Three are built in (Default, Floating
 * Islands, Hairline Ledger); users add more as `.css` files in
 * `<config>/layouts/`. The stylesheet contract (region hooks, variables,
 * precedence) is documented in `docs/layout-themes.md`.
 *
 * Model (base theme + variables + stable hooks, as Obsidian themes and
 * UserCSS metadata headers do it):
 *
 * - Every layout has a built-in BASE. Default is the application's own
 *   chrome with no layout stylesheet; the other built-ins are stylesheets
 *   written only against the contract. A user layout names its base with
 *   `@extends` and its CSS cascades after the base, so it can override base
 *   variables or rules without repeating them.
 * - The base also decides the ARRANGEMENT the application renders: Floating
 *   Islands hoists Miller columns into their own island when the sidebar is
 *   hidden and widens split dividers into gaps. That is structure, not paint,
 *   so it is owned here, not by CSS.
 * - Metadata lives in a leading block comment (`@name`, `@description`,
 *   `@extends`). A user layout's id is its file name, which always ends in
 *   `.css`, so it can never collide with a built-in id.
 *
 * Pure and framework-free: no DOM, no state imports.
 */

import {
  DEFAULT_LAYOUT_ID,
  FLOATING_ISLANDS_LAYOUT_ID,
  HAIRLINE_LEDGER_LAYOUT_ID,
  isBuiltinLayoutId,
  type BuiltinLayoutId,
} from "./layout-theme-ids";

export { DEFAULT_LAYOUT_ID, FLOATING_ISLANDS_LAYOUT_ID, HAIRLINE_LEDGER_LAYOUT_ID, isBuiltinLayoutId };
export type { BuiltinLayoutId };

/** Structural arrangement the application renders for a layout. */
export type LayoutArrangement = "flat" | "islands";

export interface LayoutThemeInfo {
  /** Built-in id, or the user file name (`compact.css`). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "builtin" | "user";
  /** Built-in layout whose stylesheet (if any) cascades first. */
  readonly base: BuiltinLayoutId;
  readonly arrangement: LayoutArrangement;
}

/** Why a user layout file could not be used. */
export type LayoutLoadFailure =
  | "invalid-filename"
  | "unreadable"
  | "empty"
  | "too-large"
  | "unterminated-comment"
  | "no-rules";

/** Why the requested layout is not the one applied. */
export type LayoutFallbackReason = LayoutLoadFailure | "missing" | "load-failed";

/** Largest layout stylesheet accepted. Layout CSS is small; anything larger is
 *  almost certainly the wrong file and would stall style recalculation. The
 *  native listing enforces the same limit before reading (`config.rs`). */
export const MAX_LAYOUT_CSS_BYTES = 512 * 1024;

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;

export const BUILTIN_LAYOUT_THEMES: readonly LayoutThemeInfo[] = [
  {
    id: DEFAULT_LAYOUT_ID,
    name: "Default",
    description: "Panels sit edge to edge on the window, divided by hairlines.",
    source: "builtin",
    base: DEFAULT_LAYOUT_ID,
    arrangement: "flat",
  },
  {
    id: FLOATING_ISLANDS_LAYOUT_ID,
    name: "Floating Islands",
    description: "Panels float as rounded islands over the window backdrop.",
    source: "builtin",
    base: FLOATING_ISLANDS_LAYOUT_ID,
    arrangement: "islands",
  },
  {
    id: HAIRLINE_LEDGER_LAYOUT_ID,
    name: "Hairline Ledger",
    description: "Square, dense panels ruled by 1px hairlines, with monospaced metadata.",
    source: "builtin",
    base: HAIRLINE_LEDGER_LAYOUT_ID,
    arrangement: "flat",
  },
];

function builtin(id: BuiltinLayoutId): LayoutThemeInfo {
  return BUILTIN_LAYOUT_THEMES.find((theme) => theme.id === id)!;
}

/** Header metadata. Absent keys are undefined. */
export interface LayoutMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly extends?: string;
}

/**
 * Read the leading metadata comment of a layout stylesheet.
 *
 * Returns `{}` when the file does not start with a block comment (metadata is
 * optional) and `null` when the leading comment never closes — the browser
 * would then treat the entire file as a comment, so the layout is unusable.
 */
export function parseLayoutMetadata(css: string): LayoutMetadata | null {
  const text = css.replace(/^﻿/, "").trimStart();
  if (!text.startsWith("/*")) return {};
  const end = text.indexOf("*/", 2);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (const rawLine of text.slice(2, end).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\*?\s?/, "").trim();
    const match = /^@([a-z][a-z-]*)\s+(.+)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    // First occurrence wins, so a later stray line cannot silently rename it.
    if (!(key in fields)) fields[key] = match[2].trim();
  }
  return {
    name: clip(fields.name, MAX_NAME_LENGTH),
    description: clip(fields.description, MAX_DESCRIPTION_LENGTH),
    extends: fields.extends,
  };
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Plain file name ending in `.css`, no path separators or traversal. */
export function isLayoutFilename(filename: unknown): filename is string {
  return (
    typeof filename === "string" &&
    filename.length > 4 &&
    filename.length <= 255 &&
    filename.endsWith(".css") && // lowercase, as the native listing and watcher match
    !/[\\/]/.test(filename) &&
    !filename.startsWith(".") &&
    !filename.includes("\0")
  );
}

/** "my-compact_layout.css" -> "My Compact Layout" */
export function layoutNameFromFilename(filename: string): string {
  const stem = filename.replace(/\.css$/i, "").replace(/[-_.]+/g, " ").trim();
  if (!stem) return filename;
  return stem.replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toUpperCase());
}

export type UserLayoutParse =
  | { readonly ok: true; readonly theme: LayoutThemeInfo; readonly css: string }
  | { readonly ok: false; readonly filename: string; readonly reason: LayoutLoadFailure };

const encoder = new TextEncoder();

/** Validate one user layout file and derive its catalog entry. */
export function parseUserLayout(filename: unknown, css: unknown): UserLayoutParse {
  const name = typeof filename === "string" ? filename : String(filename);
  if (!isLayoutFilename(filename)) return { ok: false, filename: name, reason: "invalid-filename" };
  if (typeof css !== "string") return { ok: false, filename, reason: "unreadable" };
  if (css.trim().length === 0) return { ok: false, filename, reason: "empty" };
  // Cheap bound first: UTF-8 never encodes a UTF-16 unit in fewer than one
  // byte, so a string this long is too large without encoding it.
  if (css.length > MAX_LAYOUT_CSS_BYTES || encoder.encode(css).length > MAX_LAYOUT_CSS_BYTES) {
    return { ok: false, filename, reason: "too-large" };
  }
  const metadata = parseLayoutMetadata(css);
  if (metadata === null) return { ok: false, filename, reason: "unterminated-comment" };
  const base = builtin(isBuiltinLayoutId(metadata.extends) ? metadata.extends : DEFAULT_LAYOUT_ID);
  return {
    ok: true,
    css,
    theme: {
      id: filename,
      name: metadata.name ?? layoutNameFromFilename(filename),
      description: metadata.description ?? "",
      source: "user",
      base: base.id as BuiltinLayoutId,
      arrangement: base.arrangement,
    },
  };
}

/** One entry of the native `list_user_layouts` result. */
export interface UserLayoutFile {
  readonly filename: string;
  /** null when the file exists but was not read (see `error`). */
  readonly css: string | null;
  readonly error?: "too-large" | "unreadable" | null;
}

export interface LayoutCatalog {
  /** Built-ins first, then usable user layouts sorted by name. */
  readonly themes: readonly LayoutThemeInfo[];
  /** User layout CSS by id. */
  readonly userCss: ReadonlyMap<string, string>;
  /** User files that exist but cannot be used, by file name. */
  readonly failures: ReadonlyMap<string, LayoutLoadFailure>;
}

export const BUILTIN_LAYOUT_CATALOG: LayoutCatalog = {
  themes: BUILTIN_LAYOUT_THEMES,
  userCss: new Map(),
  failures: new Map(),
};

/** Build the catalog from the native listing. Tolerates malformed entries. */
export function buildLayoutCatalog(files: unknown): LayoutCatalog {
  if (!Array.isArray(files)) return BUILTIN_LAYOUT_CATALOG;
  const user: LayoutThemeInfo[] = [];
  const userCss = new Map<string, string>();
  const failures = new Map<string, LayoutLoadFailure>();
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const { filename, css, error } = file as Partial<UserLayoutFile>;
    if (typeof filename !== "string" || userCss.has(filename) || failures.has(filename)) continue;
    const parsed = error === "too-large" || error === "unreadable"
      ? { ok: false as const, filename, reason: error }
      : parseUserLayout(filename, css);
    if (parsed.ok) {
      user.push(parsed.theme);
      userCss.set(parsed.theme.id, parsed.css);
    } else {
      failures.set(parsed.filename, parsed.reason);
    }
  }
  user.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { themes: [...BUILTIN_LAYOUT_THEMES, ...user], userCss, failures };
}

/** Mark a user layout unusable after the fact (its CSS parsed to no rules). */
export function withLayoutFailure(
  catalog: LayoutCatalog,
  id: string,
  reason: LayoutLoadFailure,
): LayoutCatalog {
  if (!catalog.userCss.has(id)) return catalog;
  const userCss = new Map(catalog.userCss);
  userCss.delete(id);
  return {
    themes: catalog.themes.filter((theme) => theme.id !== id),
    userCss,
    failures: new Map(catalog.failures).set(id, reason),
  };
}

export interface LayoutFallback {
  readonly requested: string;
  readonly reason: LayoutFallbackReason;
}

export interface LayoutResolution {
  /** The layout to apply. Always usable. */
  readonly theme: LayoutThemeInfo;
  /** Present when the requested layout could not be applied. */
  readonly fallback: LayoutFallback | null;
}

/**
 * Resolve a requested layout id against the catalog.
 *
 * Anything that cannot be applied — an unknown id, a deleted file, a file
 * that failed validation — resolves to Default, with the reason reported so
 * the UI can explain it. The request itself is never rewritten here: a file
 * that is temporarily missing (moved, mid-save) must come back once it
 * reappears, exactly like colour themes (#599).
 */
export function resolveLayoutTheme(catalog: LayoutCatalog, requested: unknown): LayoutResolution {
  const fallbackTheme = builtin(DEFAULT_LAYOUT_ID);
  if (typeof requested !== "string" || requested.length === 0) {
    return { theme: fallbackTheme, fallback: null };
  }
  const theme = catalog.themes.find((candidate) => candidate.id === requested);
  if (theme) return { theme, fallback: null };
  const reason = catalog.failures.get(requested) ?? "missing";
  return { theme: fallbackTheme, fallback: { requested, reason } };
}

/** Whether a fallback differs from the last one reported, so a notice is
 *  shown once per failure rather than on every reload of the same state. */
export function isNewLayoutFallback(previous: LayoutFallback | null, next: LayoutFallback | null): boolean {
  if (!next) return false;
  return previous?.requested !== next.requested || previous.reason !== next.reason;
}

/** Details row height the virtualized list and its rows share. */
export const DEFAULT_DETAILS_ROW_HEIGHT = 32;
export const MIN_DETAILS_ROW_HEIGHT = 20;
export const MAX_DETAILS_ROW_HEIGHT = 64;

/**
 * Parse the `--layout-row-height` custom property into a whole CSS-pixel row
 * height. Only plain `px` lengths (or unitless numbers) are honoured;
 * anything else — empty, `auto`, `2em`, garbage — keeps the default, because
 * virtualization needs an exact number before rows exist to measure.
 */
export function parseLayoutRowHeight(raw: unknown): number {
  if (typeof raw !== "string") return DEFAULT_DETAILS_ROW_HEIGHT;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(raw);
  if (!match) return DEFAULT_DETAILS_ROW_HEIGHT;
  const value = Math.round(Number(match[1]));
  if (!Number.isFinite(value)) return DEFAULT_DETAILS_ROW_HEIGHT;
  return Math.min(MAX_DETAILS_ROW_HEIGHT, Math.max(MIN_DETAILS_ROW_HEIGHT, value));
}

/** Human-readable explanation of a fallback, for settings and notices. */
export function describeLayoutFallback(reason: LayoutFallbackReason): string {
  switch (reason) {
    case "missing":
      return "the file was not found in the layouts folder";
    case "invalid-filename":
      return "the file name is not a plain .css name";
    case "unreadable":
      return "the file could not be read as text";
    case "empty":
      return "the file is empty";
    case "too-large":
      return "the file is larger than 512 KiB";
    case "unterminated-comment":
      return "its leading comment is never closed";
    case "no-rules":
      return "it contains no CSS rules";
    case "load-failed":
      return "its stylesheet could not be loaded";
  }
}

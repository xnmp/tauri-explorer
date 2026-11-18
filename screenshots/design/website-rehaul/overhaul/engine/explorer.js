/* Tauri Explorer: an in-browser simulation of the app, running on an in-memory filesystem.
   Classic script (works from file://, no modules, no build step). Exposes window.TX; the API is in README.md beside
   this file. Distilled from peel-mock/index-v3-grow.html: the simulation is kept, the marketing stage is gone. */
(function () {
"use strict";
const TX = window.TX = window.TX || {};
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const reduce = () => RM.matches;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const U = id => `<use href="#tx-${id}"/>`;   // every sprite symbol is namespaced tx-

/* ================= static metadata: themes, layouts, icon sets, parts ================= */
// The colour values are the app's own built-in themes (window, secondary surface, text, muted text, accent, folder).
// "Ink Wash" is the site's own look, and stands in for a theme a user has written themselves.
const COLOURS = [
  { id: "ink-wash", name: "Ink Wash", note: "this page" },
  { id: "light", name: "Light", v: ["#f5f5f7", "#ebebf0", "#1d1d1f", "#5d5d5d", "#0066cc", "#e8a800"] },
  { id: "dark", name: "Dark", dark: true, v: ["#1c1c1e", "#262628", "#e8e8ed", "#afafb4", "#4cc2f4", "#ffc83d"] },
  { id: "solarized-light", name: "Solarized Light", v: ["#fdf6e3", "#eee8d5", "#002b36", "#073642", "#268bd2", "#b58900"] },
  { id: "ocean-blue", name: "Ocean Blue", dark: true, v: ["#0a1a2e", "#193248", "#e8f0f5", "#a8c4d4", "#5eb7e0", "#f0d060"] },
  { id: "tahoe", name: "Tahoe", v: ["#e8ecf8", "#e1e8fc", "#1a1a2e", "#4a4a6a", "#4a7cff", "#5ab4f5"] },
  { id: "hacker", name: "Hacker", dark: true, mono: true, v: ["#0a0a0a", "#0c120d", "#00ff41", "#00cc33", "#00ff41", "#00ff41"] },
  { id: "desert", name: "Desert", dark: true, v: ["#333333", "#424242", "#ffffff", "#f5deb3", "#87ceff", "#cc7832"] },
  { id: "aurora", name: "Aurora", dark: true, v: ["#0d1117", "#161b22", "#e2e8f0", "#94a3b8", "#5de5d5", "#5de5d5"] },
  { id: "horizon", name: "Horizon", dark: true, v: ["#141620", "#1d2030", "#d5d8da", "#b0b4b8", "#e95678", "#fab795"] },
  { id: "catppuccin", name: "Catppuccin (Mocha)", dark: true, v: ["#1e1e2e", "#2a2b3c", "#cdd6f4", "#bac2de", "#cba6f7", "#f9e2af"] },
  { id: "nord", name: "Nord", dark: true, v: ["#2e3440", "#3b4252", "#eceff4", "#d8dee9", "#88c0d0", "#ebcb8b"] },
  { id: "gruvbox", name: "Gruvbox", dark: true, v: ["#282828", "#32302f", "#ebdbb2", "#c8b99d", "#fe8019", "#fabd2f"] },
];
const INK_WASH = ["#F0EBE3", "#F3F0EA", "#1D2320", "#4E5652", "#0E7C72", "#5B9FE0"];
const LAYOUTS = [
  { id: "default", name: "Default", note: "flat, edge to edge" },
  { id: "floating-islands", name: "Floating Islands", note: "rounded panels over the backdrop" },
  { id: "soft-cards", name: "Soft Cards", note: "opaque cards, no shadow" },
  { id: "compact", name: "Compact", note: "shorter bars and rows" },
  { id: "hairline-ledger", name: "Hairline Ledger", note: "square, dense, hairlines" },
];
const ICONSETS = [   // names and descriptions as the app lists them
  { id: "material", name: "Material", note: "Colorful language logos and file symbols" },
  { id: "classic", name: "Classic", note: "Familiar folders and labeled documents" },
  { id: "minimal", name: "Minimal", note: "Quiet outlines and monochrome file symbols" },
  { id: "catppuccin", name: "Catppuccin", note: "Soft pastel symbols, with light and dark palettes" },
  { id: "default", name: "Follow Color Theme", note: "Use the color theme's suggested icons; Material otherwise" },
];
// panel parts take room in the window; feature parts switch on an ability and its affordances
const PARTS = [
  { id: "address", kind: "panel", name: "Address Bar", short: "Address bar", desc: "Click any crumb to jump there, or press Ctrl+L and type a path.", glyph: `<rect class="f" x="3.5" y="3.5" width="17" height="3.2" rx="1.4"/>` },
  { id: "sidebar", kind: "panel", name: "Sidebar", short: "Sidebar", desc: "Bookmarks, drives and the Recycle Bin. Drag a file onto the bin to delete it.", glyph: `<rect class="f" x="3.5" y="3.5" width="5" height="11" rx="1.4"/>` },
  { id: "miller", kind: "panel", name: "Miller Columns", short: "Columns", desc: "The parent folder stays in view, so you always know where you are.", glyph: `<rect class="f" x="3.5" y="3.5" width="3.6" height="11" rx="1.2"/><rect class="f" x="8.4" y="3.5" width="3.6" height="11" rx="1.2"/>` },
  { id: "status", kind: "panel", name: "Status Bar", short: "Status bar", desc: "Item count, selection and Git branch, at a glance along the bottom.", glyph: `<rect class="f" x="3.5" y="12.2" width="17" height="2.3" rx="1.1"/>` },
  { id: "views", kind: "feature", name: "Views", short: "Views", desc: "Details, List or Tiles: the same folder three ways.", glyph: `<rect class="f" x="3.5" y="3.5" width="4.6" height="4.6" rx="1.2"/><rect class="f" x="9.7" y="3.5" width="4.6" height="4.6" rx="1.2"/><rect class="f" x="15.9" y="3.5" width="4.6" height="4.6" rx="1.2"/><path class="l" d="M4.4 11h15.2M4.4 14h15.2"/>` },
  { id: "preview", kind: "panel", name: "Preview", short: "Preview", desc: "Images, PDF, video, CSV and Markdown, right beside your files. Folders show what is inside.", glyph: `<rect class="f" x="14.5" y="3.5" width="6" height="11" rx="1.4"/>` },
  { id: "tabs", kind: "panel", name: "Tabs", short: "Tabs", desc: "One folder per tab. Drag a file onto a tab to move it there.", glyph: `<rect class="f" x="3.5" y="3.5" width="5.4" height="2.2" rx="1"/><rect class="f" x="10" y="3.5" width="5.4" height="2.2" rx="1" opacity=".45"/>` },
  { id: "split", kind: "panel", name: "Split Panes", short: "Split", desc: "Two panes side by side, each with its own address bar and columns. Drag files across.", glyph: `<rect class="f" x="3.5" y="3.5" width="7.6" height="11" rx="1.4"/><rect class="f" x="12.9" y="3.5" width="7.6" height="11" rx="1.4"/>` },
  { id: "peek", kind: "feature", name: "Folder Peek", short: "Folder Peek", desc: "Open a folder right in the list, without leaving where you are. It springs open under a dragged file.", glyph: `<path class="l" d="M5 5.6h9M8.2 9h9M8.2 12.4h9"/>` },
  { id: "search", kind: "feature", name: "Search", short: "Search", desc: "Quick Open jumps to a file by name; Search in Files looks inside every file.", glyph: `<circle class="o" cx="10.5" cy="8.4" r="3.6" style="fill:none;stroke-width:1.8"/><path class="l" d="m13.4 11.2 3.6 3.4"/>` },
  { id: "terminal", kind: "panel", name: "Terminal", short: "Terminal", desc: "A shell docked under your files that changes directory as you browse.", glyph: `<rect class="f" x="3.5" y="8.6" width="17" height="5.9" rx="1.4"/>` },
  { id: "git", kind: "feature", name: "Git", short: "Git", desc: "Repository badges, the branch in the status bar, and a commit graph that takes over the pane.", glyph: `<path class="l" d="M7 5v8M7 9c0-3 10-1 10-4.2"/><circle class="f" cx="7" cy="4.6" r="1.9"/><circle class="f" cx="7" cy="13.4" r="1.9"/><circle class="f" cx="17" cy="4.6" r="1.9"/>` },
  { id: "plugin", kind: "feature", name: "Plugins", short: "Plugins", desc: "A plugin can add menu actions, columns, icons, previews and whole views. AI image editing is one of them.", glyph: `<rect class="f" x="4" y="9" width="5.2" height="5.2" rx="1.2"/><rect class="f" x="10.4" y="9" width="5.2" height="5.2" rx="1.2"/><rect class="f" x="4" y="2.8" width="5.2" height="5.2" rx="1.2"/><rect class="f" x="14.4" y="2.2" width="5.2" height="5.2" rx="1.2" transform="rotate(45 17 4.8)"/>` },
  { id: "palette", kind: "feature", name: "Command Palette", short: "Commands", desc: "Every action the app can do, in one list.", glyph: `<path class="l" d="m6 6.2 3 2.8-3 2.8M11.4 12h6.4"/>` },
  { id: "themes", kind: "feature", name: "Themes", short: "Themes", desc: "Colour themes repaint everything. Layout themes rearrange it. Icon themes redraw it.", glyph: `<circle class="o" cx="12" cy="9" r="5.4" style="fill:none;stroke-width:1.5"/><path class="f" d="M12 3.6a5.4 5.4 0 0 1 0 10.8z"/>` },
  { id: "hotkeys", kind: "feature", name: "Shortcuts", short: "Shortcuts", desc: "Rebind anything. Shortcuts name themselves when pressed.", glyph: `<rect class="o" x="4.6" y="4" width="14.8" height="10" rx="2.4" style="fill:none;stroke-width:1.5"/><path class="l" d="M9.4 9h5.2"/>` },
];
const PART_IDS = PARTS.map(p => p.id);
const VIEWS = ["details", "list", "tiles"];
const THEMEVARS = ["--tx-paper", "--tx-paper-hi", "--tx-ink", "--tx-ink-2", "--tx-ink-3", "--tx-hair", "--tx-teal", "--tx-teal-2", "--tx-mint", "--tx-app", "--tx-app-side", "--tx-app-line", "--tx-app-sel", "--tx-term-bg", "--tx-folder", "--tx-ink-rgb", "--tx-paper-rgb", "--tx-paper-hi-rgb", "--tx-accent-rgb", "--tx-shadow-rgb", "--tx-on-accent", "--tx-sans", "--tx-display"];

TX.themes = COLOURS.map(t => ({ id: t.id, name: t.name, note: t.note || (t.dark ? "dark" : "light"), dark: !!t.dark, swatch: (t.v || INK_WASH).slice() }));
TX.layouts = LAYOUTS.map(l => ({ ...l }));
TX.iconsets = ICONSETS.map(i => ({ ...i }));
TX.parts = PARTS.map(p => ({ ...p }));

/* setups round-trip through a URL-safe string: base64url of the JSON (plain JSON is accepted on the way in, too) */
function b64e(s) { let bin = ""; for (const x of new TextEncoder().encode(s)) bin += String.fromCharCode(x); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64d(s) { const t = String(s).trim().replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
TX.encodeSetup = setup => b64e(JSON.stringify(setup || {}));
TX.decodeSetup = str => {
  if (!str) return null;
  if (typeof str === "object") return str;
  for (const parse of [s => JSON.parse(b64d(s)), s => JSON.parse(s)]) { try { const v = parse(str); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch (_) { /* try the next form */ } }
  return null;
};

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="tx-i-folder" viewBox="0 0 18 18"><path fill="currentColor" d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z"/><path fill="currentColor" opacity=".6" d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6.5H2V5.5Z"/></symbol>
  <symbol id="tx-i-folder-lg" viewBox="0 0 48 48"><path fill="currentColor" opacity=".85" d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z"/><path fill="currentColor" d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V20Z"/></symbol>
  <symbol id="tx-i-folder-classic" viewBox="0 0 48 48"><g transform="translate(0 1.5)" fill="#000" opacity=".2"><path d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z"/><path d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V20Z"/></g><path fill="currentColor" opacity=".85" d="M2 10C2 7.2 3.79 5 6 5H14.34C15.4 5 16.42 5.5 17.17 6.5L20 10H42C44.21 10 46 12.2 46 15V38.75C46 41.5 44.21 43.75 42 43.75H6C3.79 43.75 2 41.5 2 38.75V10Z"/><path fill="currentColor" d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V41.25C46 43.3 44.66 45 43 45H5C3.34 45 2 43.3 2 41.25V20Z"/><path fill="#fff" opacity=".25" d="M2 20C2 17.9 3.34 16.25 5 16.25H43C44.66 16.25 46 17.9 46 20V21.25H2V20Z"/></symbol>
  <symbol id="tx-i-folder-o" viewBox="0 0 18 18"><path fill="none" stroke="currentColor" stroke-width="1.25" d="M3 6.5H15V13C15 13.8284 14.3284 14.5 13.5 14.5H4.5C3.67157 14.5 3 13.8284 3 13V6.5Z"/><path fill="none" stroke="currentColor" stroke-width="1.25" d="M3 5.5C3 4.67 3.67 4 4.5 4H7L9 6H13.5C14.33 6 15 6.67 15 7.5"/></symbol>
  <symbol id="tx-i-doc-o" viewBox="0 0 18 18"><path fill="none" stroke="currentColor" stroke-width="1.25" d="M5 2.5H10.5L14.5 6.5V15C14.5 15.2761 14.2761 15.5 14 15.5H5C4.72386 15.5 4.5 15.2761 4.5 15V3C4.5 2.72386 4.72386 2.5 5 2.5Z"/><path fill="none" stroke="currentColor" stroke-width="1.25" d="M10.5 2.5V6.5H14.5"/></symbol>
  <!-- the app's Material and Catppuccin icon packs (src/lib/components/icons/*-sprite.svg); Catppuccin is MIT, (c) Catppuccin and thang-nm -->
  <symbol id="tx-mi-markdown" viewBox="0 0 48 48" fill="none"><rect x="2" y="8" width="44" height="33" rx="5" fill="var(--icon-pack-tint, #2384e8)"></rect><path d="M8 33V16l7 7 7-7v17M34 15v14m-6-4 6 7 6-7" stroke="#fff" stroke-width="4" stroke-linejoin="miter"></path></symbol>
  <symbol id="tx-mi-text" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #8a9bb5)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #c5d2e1)"></path><path d="M15 23h18M15 30h18M15 37h11" stroke="#fff" stroke-width="3" stroke-linecap="round"></path></symbol>
  <symbol id="tx-mi-pdf" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #ea3751)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #ff8a9b)"></path><path d="M15 36c9-15 12-29 7-23-4 6 3 17 13 18 7 0-5-7-15 0-12 8-10 12-5 5Z" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="tx-mi-spreadsheet" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #23bd66)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #14773f)"></path><path d="M26 22h11v16H26Zm-6 0v16M26 29h11M26 36h11" stroke="#fff" stroke-width="2"></path><rect x="1" y="17" width="24" height="25" rx="3" fill="var(--icon-pack-tint, #14773f)"></rect><text x="13" y="35" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="18" fill="#fff">X</text></symbol>
  <symbol id="tx-mi-rust" viewBox="0 0 48 48" fill="none"><path d="m19 2 4 3 5-3 3 5 6 1 1 6 5 3-2 6 3 5-5 4-1 6-6 1-4 5-5-2-5 2-4-5-6-1-1-6-5-4 3-5-2-6 5-3 1-6 6-1Z" fill="var(--icon-pack-tint, #f5683a)"></path><circle cx="24" cy="24" r="14" fill="var(--icon-pack-tint, #bd482d)"></circle><text x="24" y="34" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="900" fill="#fff">R</text></symbol>
  <symbol id="tx-mi-typescript" viewBox="0 0 48 48" fill="none"><rect x="3" y="3" width="42" height="42" rx="6" fill="var(--icon-pack-tint, #1976d2)"></rect><rect x="8" y="8" width="7" height="7" rx="1.5" fill="var(--icon-pack-tint, #29b6f6)"></rect><text x="41" y="39" text-anchor="end" font-family="Arial, sans-serif" font-weight="700" font-size="25" letter-spacing="-1.3" fill="#fff">TS</text></symbol>
  <symbol id="tx-mi-html" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #ef642e)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #ff9452)"></path><path d="m19 21-7 7 7 7m12-14 7 7-7 7m-5-16-4 18" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="tx-mi-css" viewBox="0 0 48 48" fill="none"><path d="m6 3 4 37 14 5 14-5 4-37Z" fill="var(--icon-pack-tint, #6557e8)"></path><path d="M24 6v35l11-4 3-31Z" fill="var(--icon-pack-tint, #8e81fc)"></path><path d="M15 13h18l-1 8H20l1 5h10l-1 7-6 2-7-2-.5-4" stroke="#fff" stroke-width="4" stroke-linejoin="miter"></path></symbol>
  <symbol id="tx-mi-json" viewBox="0 0 48 48" fill="none"><path d="M16 5h-3c-4 0-4 3-4 7v6c0 4-3 6-6 6 3 0 6 2 6 6v6c0 4 0 7 4 7h3M32 5h3c4 0 4 3 4 7v6c0 4 3 6 6 6-3 0-6 2-6 6v6c0 4 0 7-4 7h-3" stroke="var(--icon-pack-tint, #efb51b)" stroke-width="5" stroke-linejoin="round"></path><circle cx="24" cy="24" r="4" fill="var(--icon-pack-tint, #00bdca)"></circle></symbol>
  <symbol id="tx-mi-config" viewBox="0 0 48 48" fill="none"><path d="m19 2 4 3 5-3 3 5 6 1 1 6 5 3-2 6 3 5-5 4-1 6-6 1-4 5-5-2-5 2-4-5-6-1-1-6-5-4 3-5-2-6 5-3 1-6 6-1Z" fill="var(--icon-pack-tint, #778ca8)"></path><circle cx="24" cy="24" r="14" fill="var(--icon-pack-tint, #43bdd0)"></circle><circle cx="24" cy="24" r="7" fill="#fff"></circle></symbol>
  <symbol id="tx-mi-svelte" viewBox="0 0 48 48" fill="none"><path d="M35 5c-5-4-11-3-16 0L9 12c-7 5-8 12-3 18-1 5 0 10 5 14 5 3 11 3 16-1l12-8c7-5 7-12 2-18 1-5-1-9-6-12Z" fill="var(--icon-pack-tint, #ff5a22)"></path><path d="m31 12-15 10c-5 4-1 10 4 7l10-6c5-4 10 3 5 7L19 40" stroke="#fff" stroke-width="5" stroke-linecap="round"></path></symbol>
  <symbol id="tx-mi-audio" viewBox="0 0 48 48" fill="none"><path d="M18 12 43 4v30c0 11-17 12-17 3 0-6 7-9 12-6V15l-15 5v19c0 11-18 11-18 3 0-6 8-9 13-7Z" fill="var(--icon-pack-tint, #e637bb)"></path><path d="m18 12 25-8v10l-25 8Z" fill="var(--icon-pack-tint, #9b53ea)"></path></symbol>
  <symbol id="tx-mi-executable" viewBox="0 0 48 48" fill="none"><path d="m19 2 4 3 5-3 3 5 6 1 1 6 5 3-2 6 3 5-5 4-1 6-6 1-4 5-5-2-5 2-4-5-6-1-1-6-5-4 3-5-2-6 5-3 1-6 6-1Z" fill="var(--icon-pack-tint, #3e9cbf)"></path><circle cx="24" cy="24" r="14" fill="var(--icon-pack-tint, #5bd2b1)"></circle><path d="m20 15 13 9-13 9Z" fill="#fff"></path></symbol>
  <symbol id="tx-mi-image" viewBox="0 0 48 48" fill="none"><rect x="3" y="4" width="42" height="40" rx="5" fill="var(--icon-pack-tint, #a867e8)"></rect><rect x="7" y="8" width="34" height="32" rx="2" fill="#553b87"></rect><circle cx="33" cy="16" r="5" fill="#fff2d8"></circle><path d="m7 32 12-14 12 14 5-6 5 7v7H7Z" fill="var(--icon-pack-tint, #ee53b7)"></path></symbol>
  <symbol id="tx-mi-code" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #3995be)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #81d8ec)"></path><path d="m19 21-7 7 7 7m12-14 7 7-7 7m-5-16-4 18" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="tx-mi-file" viewBox="0 0 48 48" fill="none"><path d="M10 3h20l12 12v27a3 3 0 0 1-3 3H10a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" fill="var(--icon-pack-tint, #8a9bb5)"></path><path d="M30 3v12h12Z" fill="var(--icon-pack-tint, #c5d2e1)"></path><path d="M15 23h18M15 30h18M15 37h11" stroke="#fff" stroke-width="3" stroke-linecap="round"></path></symbol>
  <symbol id="tx-ct-markdown" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-sapphire)" stroke-linecap="round" stroke-linejoin="round" d="m9.25 8.25 2.25 2.25 2.25-2.25M3.5 11V5.5l2.04 3 1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08" /> </symbol>
  <symbol id="tx-ct-text" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-text)" stroke-linecap="round" stroke-linejoin="round"> <path d="M13.5 6.5v6a2 2 0 01-2 2h-7a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h4.01" /> <path d="m8.5 1.5 5 5h-4a1 1 0 01-1-1zm-3 10h5m-5-3h5m-5-3h1" /> </g> </symbol>
  <symbol id="tx-ct-pdf" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-red)" stroke-linecap="round" stroke-linejoin="round" d="M2.8 14.34c1.81-1.25 3.02-3.16 3.91-5.5.9-2.33 1.86-4.33 1.44-6.63-.06-.36-.57-.73-.83-.7-1.02.06-.95 1.21-.85 1.9.24 1.71 1.56 3.7 2.84 5.56 1.27 1.87 2.32 2.16 3.78 2.26.5.03 1.25-.14 1.37-.58.77-2.8-9.02-.54-12.28 2.08-.4.33-.86 1-.6 1.46.2.36.87.4 1.23.15h0Z" /> </symbol>
  <symbol id="tx-ct-spreadsheet" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-green)" stroke-linecap="round" stroke-linejoin="round"> <path d="M2.5 3.13c0-.77.86-1.63 1.62-1.63h9.76c.76 0 1.62.86 1.62 1.63v9.75c0 .76-.86 1.62-1.62 1.62H4.13c-.77 0-1.63-.86-1.63-1.62M.5 5.5l4 5m0-5-4 5" /> <path d="M7.5 5.5h5v5h-5zm2 0v5m-2-3h5" /> </g> </symbol>
  <symbol id="tx-ct-rust" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-peach)" stroke-linecap="round" stroke-linejoin="round"> <path d="M15.5 9.5Q8 13.505.5 9.5l1-1-1-2 2-.5V4.5h2l.5-2 1.5 1 1.5-2 1.5 2 1.5-1 .5 2h2V6l2 .5-1 2z" /> <path d="M6.5 7.5a1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1 1 1 0 011 1m5 0a1 1 0 01-1 1 1 1 0 01-1-1 1 1 0 011-1 1 1 0 011 1M4 11.02c-.67.37-1.5.98-1.5 2.23s1.22 1.22 2 1.25v-2M12 11c.67.37 1.5 1 1.5 2.25s-1.22 1.22-2 1.25v-2" /> </g> </symbol>
  <symbol id="tx-ct-typescript" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-blue)" stroke-linecap="round" stroke-linejoin="round"> <path d="M4 1.5h8A2.5 2.5 0 0114.5 4v8a2.5 2.5 0 01-2.5 2.5H4A2.5 2.5 0 011.5 12V4A2.5 2.5 0 014 1.5" /> <path d="M12.5 8.75c0-.69-.54-1.25-1.2-1.25h-.6c-.66 0-1.2.56-1.2 1.25S10.04 10 10.7 10h.6c.66 0 1.2.56 1.2 1.25s-.54 1.25-1.2 1.25h-.6c-.66 0-1.2-.56-1.2-1.25m-3-3.75v5M5 7.5h3" /> </g> </symbol>
  <symbol id="tx-ct-html" viewBox="0 0 16 16"> <g fill="none" stroke-linecap="round" stroke-linejoin="round"> <path stroke="var(--vscode-ctp-peach)" d="M1.5 1.5h13L13 13l-5 2-5-2z" /> <path stroke="var(--vscode-ctp-text)" d="M11 4.5H5l.25 3h5.5l-.25 3-2.5 1-2.5-1-.08-1" /> </g> </symbol>
  <symbol id="tx-ct-css" viewBox="0 0 16 16"> <g fill="none" stroke-linecap="round" stroke-linejoin="round"> <path stroke="var(--vscode-ctp-blue)" d="M1.5 1.5h13L13 13l-5 2-5-2z" /> <path stroke="var(--vscode-ctp-text)" d="M5 4.5h6l-.5 6-2.5 1-2.5-1-.08-1m1.08-2h4" /> </g> </symbol>
  <symbol id="tx-ct-json" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-yellow)" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5H4c-.75 0-1.5.75-1.5 1.5v2c0 1.1-1 2-1.83 2 .83 0 1.83.9 1.83 2v2c0 .75.75 1.5 1.5 1.5h.5m7-11h.5c.75 0 1.5.75 1.5 1.5v2c0 1.1 1 2 1.83 2-.83 0-1.83.9-1.83 2v2c0 .74-.75 1.5-1.5 1.5h-.5m-6.5-3a.5.5 0 100-1 .5.5 0 000 1m3 0a.5.5 0 100-1 .5.5 0 000 1m3 0a.5.5 0 100-1 .5.5 0 000 1" /> </symbol>
  <symbol id="tx-ct-config" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-overlay1)" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.711" d="m7.997 9.694a1.726 1.695 0 1 0 0-3.39 1.726 1.695 0 0 0 0 3.39m3.021-6.78 3.021 5.085-3.021 5.085h-6.042l-3.021-5.085 3.021-5.085z" /> </symbol>
  <symbol id="tx-ct-svelte" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-peach)" stroke-linecap="round" stroke-linejoin="round"> <path d="m 12.86,6.72 c 0,0 1.39,-1.98 0.08,-3.87 C 11.28625,0.7625 9.44,1.6 9.44,1.6 c 0,0 -3.29,1.75 -5.11,2.99 -1.4,1 -2.24,2.26 -1.03,4.37 1.22,2.1 4.58,1.21 4.58,1.21" /> <path d="M3.14 9.28s-1.39 1.98-.08 3.87c1.31 1.9 3.5 1.24 3.5 1.24s3.29-1.74 5.11-2.98c1.4-1 2.24-2.26 1.03-4.37-1.22-2.1-4.58-1.21-4.58-1.21M6.3 6.96l4.14-2.56m-4.92 7.25L9.66 9.1" /> </g> </symbol>
  <symbol id="tx-ct-audio" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-maroon)" stroke-linecap="round" stroke-linejoin="round"> <path d="M5.5 12.5a2 2 0 01-2 2 2 2 0 01-2-2 2 2 0 012-2 2 2 0 012 2m9-2a2 2 0 01-2 2 2 2 0 01-2-2 2 2 0 012-2 2 2 0 012 2" /> <path d="M5.5 12.5V5c0-.54.44-1.21 1.35-1.5l6.3-2c.9 0 1.35.88 1.35 1.5v7.58m-9-3.08 9-3" /> </g> </symbol>
  <symbol id="tx-ct-executable" viewBox="0 0 16 16"> <g fill="none" stroke="var(--vscode-ctp-text)" stroke-linecap="round" stroke-linejoin="round"> <path d="M3 2.5h10c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 011.5 13V4c0-.83.67-1.5 1.5-1.5m-1.5 3h13" /> <path d="m6.5 8-2 2 2 2m3-4 2 2-2 2" /> </g> </symbol>
  <symbol id="tx-ct-image" viewBox="0 0 16 16"> <g fill="none" stroke-linecap="round" stroke-linejoin="round"> <path stroke="var(--vscode-ctp-yellow)" d="M11.5 6A1.5 1.5 0 0110 7.5 1.5 1.5 0 018.5 6 1.5 1.5 0 0110 4.5 1.5 1.5 0 0111.5 6" /> <path stroke="var(--vscode-ctp-green)" d="M7.5 13.5 11 10c.5-.5 1.5-.5 2 0l1.5 1.5" /> <path stroke="var(--vscode-ctp-green)" d="m1.5 9.5 2-2C4 7 5 7 5.5 7.5l4 4" /> <path stroke="var(--vscode-ctp-sapphire)" d="M3 2.5h10c.83 0 1.5.67 1.5 1.5v8c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 011.5 12V4c0-.83.67-1.5 1.5-1.5" /> </g> </symbol>
  <symbol id="tx-ct-code" viewBox="0 0 16 16"> <g fill="none" stroke-linecap="round" stroke-linejoin="round"> <path stroke="var(--vscode-ctp-peach)" d="M1.5 1.5h13L13 13l-5 2-5-2z" /> <path stroke="var(--vscode-ctp-text)" d="M11 4.5H5l.25 3h5.5l-.25 3-2.5 1-2.5-1-.08-1" /> </g> </symbol>
  <symbol id="tx-ct-file" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-text)" stroke-linecap="round" stroke-linejoin="round" d="M13.5 6.5v6a2 2 0 01-2 2h-7a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h4.01m-.01 0 5 5h-4a1 1 0 01-1-1z" /> </symbol>
  <symbol id="tx-ct-folder" viewBox="0 0 16 16"> <path fill="none" stroke="var(--vscode-ctp-text)" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 01.5 12V3.5a1 1 0 011-1h5a1 1 0 011 1v1" /> </symbol>
  <symbol id="tx-i-page" viewBox="0 0 24 24"><path style="fill:var(--tx-app)" stroke="currentColor" stroke-width="1.4" d="M6 2.8h8l4.5 4.5v13a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z"/><path fill="currentColor" d="M14 2.8v4.5h4.5z" opacity=".35"/><path stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8.5 12h7M8.5 15h7M8.5 18h4.5"/></symbol>
  <symbol id="tx-i-code" viewBox="0 0 24 24"><path style="fill:var(--tx-app)" stroke="currentColor" stroke-width="1.4" d="M6 2.8h8l4.5 4.5v13a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="m10 12-2.4 2.5L10 17m4-5 2.4 2.5L14 17"/></symbol>
  <symbol id="tx-i-image" viewBox="0 0 24 24"><path style="fill:var(--tx-app)" stroke="currentColor" stroke-width="1.4" d="M6 2.8h8l4.5 4.5v13a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z"/><path fill="currentColor" d="m7 19 3.4-4.6 2.3 3 1.6-2 2.7 3.6z"/><circle cx="10" cy="10.5" r="1.5" fill="currentColor"/></symbol>
  <symbol id="tx-i-film" viewBox="0 0 24 24"><path style="fill:var(--tx-app)" stroke="currentColor" stroke-width="1.4" d="M6 2.8h8l4.5 4.5v13a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z"/><path fill="currentColor" d="M9.6 11.2v6.1c0 .4.4.6.7.4l4.8-3.05a.5.5 0 0 0 0-.84l-4.8-3.05c-.3-.2-.7 0-.7.44z"/></symbol>
  <symbol id="tx-i-play" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.55)"/><path fill="#fff" d="M9.5 7.6v8.8c0 .5.5.8.9.5l6.6-4.4a.6.6 0 0 0 0-1l-6.6-4.4c-.4-.3-.9 0-.9.5z"/></symbol>
  <symbol id="tx-i-chev" viewBox="0 0 10 10"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m3.5 1.8 3.2 3.2-3.2 3.2"/></symbol>
  <symbol id="tx-i-drive" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="17" cy="12" r="1.2" fill="currentColor"/></symbol>
  <symbol id="tx-i-trash" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2c.1.9.8 1.6 1.7 1.6h5.8c.9 0 1.6-.7 1.7-1.6L17.5 7"/></symbol>
  <symbol id="tx-i-star" viewBox="0 0 24 24"><path fill="currentColor" d="m12 3.6 2.5 5.3 5.8.7-4.3 4 1.1 5.8L12 16.6l-5.1 2.8L8 13.6l-4.3-4 5.8-.7z"/></symbol>
  <symbol id="tx-i-home" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/></symbol>
  <symbol id="tx-i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" fill="currentColor" opacity=".14"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m7.8 12.4 2.8 2.8 5.6-6"/></symbol>
  <symbol id="tx-i-dl" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/></symbol>
  <symbol id="tx-i-gh" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.5a9.7 9.7 0 0 0-3.07 18.9c.49.09.66-.21.66-.47v-1.66c-2.7.59-3.27-1.3-3.27-1.3-.44-1.12-1.08-1.42-1.08-1.42-.88-.6.07-.59.07-.59.97.07 1.48 1 1.48 1 .87 1.48 2.27 1.05 2.82.8.09-.63.34-1.05.62-1.3-2.15-.24-4.42-1.08-4.42-4.8 0-1.06.38-1.93 1-2.6-.1-.25-.43-1.24.1-2.58 0 0 .81-.26 2.66.99a9.2 9.2 0 0 1 4.84 0c1.85-1.25 2.66-.99 2.66-.99.53 1.34.2 2.33.1 2.58.62.67 1 1.54 1 2.6 0 3.73-2.28 4.55-4.44 4.79.35.3.66.89.66 1.8v2.67c0 .26.17.57.67.47A9.7 9.7 0 0 0 12 2.5z"/></symbol>
  <symbol id="tx-i-fold" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5l8 4.5 8-4.5M12 13v7"/></symbol>
  <symbol id="tx-i-note" viewBox="0 0 24 24"><path style="fill:var(--tx-app)" stroke="currentColor" stroke-width="1.4" d="M6 2.8h8l4.5 4.5v13a.9.9 0 0 1-.9.9H6a.9.9 0 0 1-.9-.9V3.7c0-.5.4-.9.9-.9z"/><path fill="currentColor" d="M10.2 18.2a1.6 1.6 0 1 1-1.6-1.6c.2 0 .4 0 .6.1V11l5-1.1v5.9a1.6 1.6 0 1 1-1.6-1.6c.2 0 .4 0 .6.1v-3l-3 .7z"/></symbol>
  <symbol id="tx-i-app" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="currentColor"/><path fill="none" style="stroke:var(--tx-app)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 8.2v6.6m-3-3 3 3 3-3"/></symbol>
  <symbol id="tx-i-branch" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="7.5" r="2"/><path d="M7 7.5v9M17 9.5c0 4.5-10 2.5-10 7"/></g></symbol>
  <symbol id="tx-i-cmd" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m7 8 4 4-4 4m6 0h4"/></symbol>
  <symbol id="tx-i-spark" viewBox="0 0 24 24"><path fill="currentColor" d="M12 3.5c.5 3.9 2.4 6.1 6.5 6.6-4.1.6-6 2.8-6.5 6.7-.5-3.9-2.4-6.1-6.5-6.7 4.1-.5 6-2.7 6.5-6.6zM18.5 15c.2 1.6 1 2.5 2.5 2.7-1.5.2-2.3 1.1-2.5 2.8-.2-1.7-1-2.6-2.5-2.8 1.5-.2 2.3-1.1 2.5-2.7z"/></symbol>
  <symbol id="tx-i-plus" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M12 5v14M5 12h14"/></symbol>
  <symbol id="tx-i-arrow" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14m-6-6 6 6-6 6"/></symbol>
  <symbol id="tx-i-peel" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.6-5.9M4 4.5v4.2h4.2"/></symbol>
</svg>`;
function injectSprite() {
  if (document.getElementById("tx-sprite")) return;
  const d = document.createElement("div");
  d.innerHTML = SPRITE;
  const s = d.firstElementChild;
  s.id = "tx-sprite";
  document.body.prepend(s);
}

let current = null;
TX.mount = function mount(container, opts = {}) {
  if (!container || container.nodeType !== 1) throw new Error("TX.mount(container, opts): container must be an element");
  if (current) current.destroy();
  const def = opts.fs || (window.TX_FS && window.TX_FS.default);
  if (!def || !def.tree) throw new Error("TX.mount: no filesystem. Pass opts.fs, e.g. TX_FS.default");
  injectSprite();
  const themeRoot = opts.themeRoot || document.documentElement;
  const ASSETS = opts.assetBase ?? "../peel-mock/assets/";
  const asset = n => ASSETS + n;
  const cleanups = [];
  const docOn = (t, f, o) => { document.addEventListener(t, f, o); cleanups.push(() => document.removeEventListener(t, f, o)); };
  const listeners = {};
  const emit = (ev, data) => { for (const fn of (listeners[ev] || []).slice()) { try { fn(data); } catch (err) { console.error(err); } } };

  /* ================= the file system (in memory, loaded from the TX_FS format) ================= */
  const TRASH = "/.recycle-bin";
  const segs = p => p.split("/").filter(Boolean);
  const nameOf = p => segs(p).at(-1) ?? "";
  const parentOf = p => p === "/" ? null : "/" + segs(p).slice(0, -1).join("/");
  const join = (d, n) => (d === "/" ? "" : d) + "/" + n;
  const norm = p => { const out = []; for (const s of String(p).split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); } return "/" + out.join("/"); };
  const under = (p, d) => p === d || p.startsWith(d === "/" ? "/" : d + "/");
  const KINDOF = { md: "md", markdown: "md", txt: "txt", log: "txt", m3u: "txt", pdf: "pdf", csv: "csv", tsv: "csv", rs: "code", ts: "code", tsx: "code", js: "code", mjs: "code", json: "code", toml: "code", yaml: "code", yml: "code", ini: "code", conf: "code", html: "code", css: "code", py: "code", sh: "code", c: "code", h: "code", go: "code", svelte: "svelte", flac: "audio", mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", appimage: "app", exe: "app", deb: "app", dmg: "app", webp: "img", png: "img", jpg: "img", jpeg: "img", gif: "img", svg: "img", avif: "img", mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video" };
  const VIDEO_RE = /\.(mp4|webm|mov|m4v)(\?.*)?$/i;
  const extOf = n => (n.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const inferKind = name => KINDOF[extOf(name)] || (/^\./.test(name) ? "txt" : "file");
  const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`;
  const textSize = t => fmtSize(new TextEncoder().encode(t).length);
  function loadNode(x) {
    const n = { n: String(x.name ?? ""), d: x.date || "" };
    if (x.kind === "dir" || (x.kind !== "file" && Array.isArray(x.kids))) { n.k = "folder"; n.kids = (x.kids || []).filter(Boolean).map(loadNode); return n; }
    n.k = x.type || (x.src ? (VIDEO_RE.test(x.src) ? "video" : "img") : inferKind(n.n));
    if (x.text != null) n.text = String(x.text);
    // a film keeps its file in `vid`, so everything that treats `src` as a picture (plugins, thumbnails, theme from image) leaves it alone
    if (x.src) { if (n.k === "video") n.vid = x.src; else n.src = x.src; }
    if (n.k === "video" && x.poster) n.poster = String(x.poster);
    if (x.duration) n.dur = String(x.duration);
    if (x.px) n.px = String(x.px).replace(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i, "$1 × $2");
    n.s = typeof x.size === "number" ? fmtSize(x.size) : x.size || (n.text != null ? textSize(n.text) : "0 B");
    return n;
  }
  const root = loadNode({ ...def.tree, name: "", kind: "dir" });
  function nodeAt(p) { let n = root; for (const s of segs(p)) { n = n.kids?.find(c => c.n === s); if (!n) return null; } return n; }
  const isDir = p => !!p && !!nodeAt(p)?.kids;
  if (!nodeAt(TRASH)) root.kids.push({ n: ".recycle-bin", k: "folder", d: "", kids: [] });
  const byName = (a, b) => (!!b.kids - !!a.kids) || a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: "base" });
  function freeName(d, name, tag = " copy") {
    const taken = new Set(nodeAt(d).kids.map(k => k.n));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; ; i++) { const c = tag ? `${base}${tag}${i > 1 ? " " + i : ""}${ext}` : `${base} ${i + 1}${ext}`; if (!taken.has(c)) return c; }
  }
  for (const t of def.trash || []) {
    if (!t || !t.node) continue;
    const n = loadNode(t.node);
    n.orig = n.n; n.from = norm(t.from || "/"); if (t.deleted) n.deleted = t.deleted;
    n.n = freeName(TRASH, n.n, "");
    nodeAt(TRASH).kids.push(n);
  }
  for (const [p, r] of Object.entries(def.repos || {})) {   // a repository's data travels with its folder, through renames and moves
    const n = nodeAt(norm(p));
    if (n && n.kids && r) { n.repo = r.branch || "main"; n.git = JSON.parse(JSON.stringify(r)); }
  }
  const state = { on: new Set(), hidden: false };
  const shown = (d, n) => d === TRASH || !n.n.startsWith(".") || (state.hidden && !(d === "/" && n.n === ".recycle-bin"));
  const list = p => (nodeAt(p)?.kids || []).filter(n => shown(p, n)).sort(byName);
  const UNITS = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  const bytesOf = n => { if (n.kids) return -1 + n.kids.length * 1e-6; const m = String(n.s || "").match(/([\d.]+)\s*(B|KB|MB|GB)/i); return m ? +m[1] * UNITS[m[2].toUpperCase()] : 0; };
  const whenOf = n => { const d = String(n.d || ""); if (/^just now$/i.test(d)) return Infinity; const t = Date.parse(d); return isNaN(t) ? -Infinity : t; };
  const SORTBY = { name: (a, b) => a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: "base" }), size: (a, b) => bytesOf(a) - bytesOf(b), modified: (a, b) => { const x = whenOf(a), y = whenOf(b); return x === y ? 0 : x < y ? -1 : 1; } };
  const colh = (s = { key: "name", dir: 1 }) => [["name", "Name"], ["size", "Size"], ["modified", "Modified"]].map(([k, label]) =>
    `<button type="button" data-sort="${k}"${s.key === k ? ` aria-sort="${s.dir > 0 ? "ascending" : "descending"}"` : ""}>${label}${s.key === k ? `<i aria-hidden="true">${s.dir > 0 ? "▲" : "▼"}</i>` : ""}</button>`).join("");
  const sizeOf = n => { if (!n.kids) return n.s; const c = n.kids.filter(k => !k.n.startsWith(".") || state.hidden).length; return `${c} item${c === 1 ? "" : "s"}`; };

  const USERS = Array.isArray(def.users) ? def.users : [];
  const homeOf = u => u && u.home && isDir(norm(u.home)) ? norm(u.home) : "/";
  let user = USERS.find(u => u.id === opts.user) || USERS[0] || null;
  let HOME = homeOf(user);
  const tilde = p => HOME === "/" ? p : p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
  const untilde = s => s === "~" ? HOME : s.startsWith("~/") ? norm(HOME + s.slice(1)) : s;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const title = p => p === HOME ? "Home" : p === TRASH ? "Recycle Bin" : p === "/" ? "System" : /^\/(media|mnt)\/[^/]+$/.test(p) ? cap(nameOf(p)) : nameOf(p);
  function repoRoot(p) { for (let q = p; q; q = parentOf(q)) if (nodeAt(q)?.repo) return q; return null; }
  const repoOf = p => { const r = repoRoot(p); return r ? nodeAt(r).repo : null; };
  function repoPaths() {
    const out = [];
    (function walk(d) { for (const n of nodeAt(d)?.kids || []) { if (!n.kids) continue; const p = join(d, n.n); if (p === TRASH) continue; if (n.repo) out.push(p); walk(p); } })("/");
    return out.sort((a, b) => under(b, HOME) - under(a, HOME));
  }
  const drives = () => ["/", ...["/media", "/mnt"].flatMap(m => (nodeAt(m)?.kids || []).filter(n => n.kids && !n.n.startsWith(".")).map(n => join(m, n.n)))];
  function walkFiles(d, fn) { for (const n of nodeAt(d)?.kids || []) { const p = join(d, n.n); if (p === TRASH) continue; if (n.kids) walkFiles(p, fn); else fn(p, n); } }

  /* every change is undoable, newest first */
  const undos = [];
  const changed = (op, path, to = null) => emit("fs-change", { op, path, to });
  function detach(p) { const kids = nodeAt(parentOf(p)).kids, i = kids.findIndex(k => k.n === nameOf(p)); return { n: kids.splice(i, 1)[0], i }; }
  const fs = {
    rename(p, name) {
      const n = nodeAt(p), old = n.n, d = parentOf(p);
      n.n = name;
      undos.push({ say: `Renamed back to ${old}`, undo: () => { n.n = old; remap(join(d, name), join(d, old)); return join(d, old); } });
      changed("rename", p, join(d, name));
      return join(d, name);
    },
    trash(p) {
      const from = parentOf(p), orig = nameOf(p), { n, i } = detach(p);
      n.n = freeName(TRASH, orig, ""); n.from = from; n.orig = orig; n.deleted = "Just now";
      nodeAt(TRASH).kids.unshift(n);
      undos.push({ say: `Restored ${orig}`, undo: () => { const bin = nodeAt(TRASH).kids; bin.splice(bin.indexOf(n), 1); n.n = orig; delete n.from; delete n.deleted; nodeAt(from).kids.splice(i, 0, n); return join(from, orig); } });
      changed("trash", p);
    },
    restore(p) {
      const n = nodeAt(p), binName = n.n, back = n.from, from = isDir(back) ? back : HOME, { i } = detach(p);
      n.n = freeName(from, n.orig || n.n, ""); delete n.from;
      nodeAt(from).kids.push(n);
      const np = join(from, n.n);
      undos.push({ say: `Moved ${n.n} back to the Recycle Bin`, undo: () => { detach(np); n.n = binName; n.from = back; nodeAt(TRASH).kids.splice(i, 0, n); return null; } });
      changed("restore", p, np);
      return np;
    },
    copy(src, d) {
      const n = structuredClone(nodeAt(src));
      n.n = freeName(d, n.n);
      nodeAt(d).kids.push(n);
      const p = join(d, n.n);
      undos.push({ say: `Removed ${n.n}`, undo: () => { detach(p); return null; } });
      changed("copy", src, p);
      return p;
    },
    move(src, d) {
      if (d === parentOf(src) || under(d, src)) return null;
      const from = parentOf(src), orig = nameOf(src), { n, i } = detach(src);
      n.n = freeName(d, orig, "");
      nodeAt(d).kids.push(n);
      const p = join(d, n.n);
      undos.push({ say: `Moved ${orig} back`, undo: () => { detach(p); n.n = orig; nodeAt(from).kids.splice(i, 0, n); remap(p, join(from, orig)); return join(from, orig); } });
      changed("move", src, p);
      return p;
    },
    add(d, node) {
      node.n = freeName(d, node.n, "");
      nodeAt(d).kids.push(node);
      const p = join(d, node.n);
      undos.push({ say: `Removed ${node.n}`, undo: () => { detach(p); return null; } });
      changed("add", p);
      return p;
    },
    write(p, text) {   // a shell redirect: replace a file's text, or create the file
      const n = nodeAt(p);
      if (!n) return fs.add(parentOf(p), { n: nameOf(p), k: inferKind(nameOf(p)), s: textSize(text), d: "Just now", text });
      const old = { text: n.text, s: n.s, d: n.d };
      Object.assign(n, { text, s: textSize(text), d: "Just now" });
      undos.push({ say: `Put ${n.n} back as it was`, undo: () => { Object.assign(n, old); if (old.text === undefined) delete n.text; return p; } });
      changed("write", p);
      return p;
    },
  };

  /* ================= themes: colour, layout, icons ================= */
  const THEMEKINDS = { colour: ["Switch Theme", COLOURS], layout: ["Switch Layout", LAYOUTS], icons: ["Switch Icon Theme", ICONSETS] };
  const theme = { colour: "ink-wash", layout: "default", icons: "material", custom: null };
  let settled = false;
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const hex = c => "#" + c.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
  // which pack is drawn: an explicit choice, or the one the colour theme suggests (Hacker asks for Minimal)
  const iconPack = () => theme.icons !== "default" ? theme.icons : theme.colour === "hacker" && !theme.custom ? "minimal" : "material";
  let paintT = 0;
  function paint(fade = true) {   // a colour theme is six colours; everything else is mixed from them
    const R = themeRoot, c = theme.custom || COLOURS.find(x => x.id === theme.colour) || COLOURS[0];
    THEMEVARS.forEach(k => R.style.removeProperty(k));
    R.dataset.txScheme = appEl.dataset.txScheme = c.dark ? "dark" : "light";
    appEl.dataset.layout = theme.layout;
    appEl.dataset.icons = iconPack();
    const set = {};
    if (c.v) {
      const [bg, side, text, muted, accent, folder] = c.v, dark = !!c.dark, hi = mix(bg, "#ffffff", dark ? .06 : .6), app = dark ? mix(bg, "#ffffff", .035) : mix(bg, "#ffffff", .72);
      Object.assign(set, { "--tx-paper": bg, "--tx-paper-hi": hi, "--tx-ink": text, "--tx-ink-2": muted, "--tx-ink-3": mix(muted, bg, .38),
        "--tx-hair": `rgba(${rgb(text)}, .14)`, "--tx-teal": accent, "--tx-teal-2": mix(accent, dark ? "#ffffff" : bg, dark ? .12 : .18), "--tx-mint": mix(bg, accent, .22),
        "--tx-app": app, "--tx-app-side": side, "--tx-app-line": mix(bg, text, dark ? .13 : .1), "--tx-app-sel": mix(app, accent, dark ? .24 : .16),
        "--tx-term-bg": mix(bg, side, .5), "--tx-folder": folder, "--tx-ink-rgb": rgb(text).join(", "), "--tx-paper-rgb": rgb(bg).join(", "), "--tx-paper-hi-rgb": rgb(hi).join(", "), "--tx-accent-rgb": rgb(accent).join(", "),
        "--tx-shadow-rgb": dark ? "0, 0, 0" : rgb(mix(text, "#000000", .3)).join(", "), "--tx-on-accent": dark ? bg : "#ffffff" });
      if (c.mono) { set["--tx-sans"] = "var(--tx-mono)"; set["--tx-display"] = "var(--tx-mono)"; }   // Hacker sets the whole app in monospace
    }
    for (const [k, v] of Object.entries(set)) R.style.setProperty(k, v);
    // Every colour cross-fades. Besides looking better, this is what makes it reliable: some engines (WebKitGTK among
    // them) do not repaint an element when only a custom property it inherits has changed, unless it is transitioning.
    if (fade && settled && !reduce()) { R.classList.add("tx-theming"); clearTimeout(paintT); paintT = setTimeout(() => R.classList.remove("tx-theming"), 560); }
  }
  function setTheme(kind, id, custom = null) {
    if (kind === "colour") theme.custom = custom;
    theme[kind] = id;
    paint(kind !== "layout");
    if (kind !== "colour") renderAll();
    emitSetup();
  }
  /* the picker previews each choice as you arrow through it; Enter keeps it, Esc puts things back */
  function openThemes(kind = "colour") {
    ensure("themes");
    const [label, items] = THEMEKINDS[kind], was = { id: theme[kind], custom: theme.custom };
    const swatch = t => kind !== "colour" ? "" : `<i class="tx-sw3">${(t.v || INK_WASH).filter((_, i) => i !== 1 && i !== 3 && i < 5).map(c => `<b style="background:${c}"></b>`).join("")}</i>`;
    const others = Object.keys(THEMEKINDS).filter(k => k !== kind);
    const pk = picker({
      label, hint: `${label}: arrow through to preview`, foot: `<span><kbd>↑</kbd><kbd>↓</kbd>&nbsp;preview</span><span><kbd>Enter</kbd>&nbsp;keep</span><span><kbd>Esc</kbd>&nbsp;put it back</span>`,
      results: v => {
        const qy = v.trim();
        const rows = items.map(t => ({ t, m: qy ? fuzzy(qy, t.name) : { score: 0 } })).filter(x => x.m).map(({ t, m }) => ({
          on: t.id === theme[kind] && !theme.custom, hover: () => setTheme(kind, t.id),
          html: `${swatch(t)}<span class="tx-nm">${hl(t.name, m.hits)}</span><small>${t.note || (kind === "colour" ? (t.dark ? "dark" : "light") : "")}</small>`,
          run: () => setTheme(kind, t.id),
        }));
        return qy ? rows : [...rows, { sec: "Also" }, ...others.map(k => ({ hover: () => setTheme(kind, was.id, was.custom), html: `${ICON("i-cmd")}<span class="tx-nm">${THEMEKINDS[k][0]}...</span>`, run: () => openThemes(k) }))];
      },
    });
    onDismiss = () => setTheme(kind, was.id, was.custom);
    return pk;
  }
  /* ================= the window: plain CSS layout, one slot per part ================= */
  const slot = (id, cls, inner) => `<div class="tx-slot ${cls}" data-slot="${id}"><div class="tx-face">${inner}</div></div>`;
  const group = (g, a, m, pane) => `<div class="tx-group" data-group="${g}">${slot(a, "tx-h", `<div class="tx-m-addr" data-face="${a}" data-pane="${g}"></div>`)}<div class="tx-row">${slot(m, "tx-v", `<div class="tx-m-mill" data-face="${m}" data-pane="${g}"></div>`)}${slot(pane, "tx-pane", `<div class="tx-pane-host" data-host="${g}" tabindex="0" aria-label="${g === "main" ? "Files" : "Second pane"}"></div>`)}</div></div>`;
  const PLUGFACE = `<div class="tx-m-plug"><div class="tx-ttl">Edit image<span>AI</span><button type="button" class="tx-x" data-ai="close" aria-label="Close">×</button></div><input class="tx-prompt" data-ai-prompt value="Add a red-crowned crane flying through the mist" aria-label="Describe the change"><div class="tx-pair"><div><img data-ai-from alt=""></div><svg aria-hidden="true">${U("i-chev")}</svg><div data-ai-to></div></div><button type="button" class="tx-gen" data-ai="go">Generate</button></div><div class="tx-m-plugs" data-plug-list></div>`;
  const appEl = document.createElement("div");
  appEl.className = "tx-app tx-instant";
  appEl.innerHTML = slot("tabs", "tx-h", `<div class="tx-m-tabs" data-face="tabs"></div>`)
    + `<div class="tx-body">${slot("sidebar", "tx-v", `<div class="tx-m-side" data-face="sidebar"></div>`)}<div class="tx-panes">${group("main", "address", "miller", "pane")}${group("split", "address2", "miller2", "pane2")}</div>${slot("preview", "tx-v", `<div class="tx-m-prev" data-face="preview"></div>`)}</div>`
    + slot("terminal", "tx-h", `<div class="tx-m-term" data-face="terminal"></div>`)
    + slot("status", "tx-h", `<div class="tx-m-stat" data-face="status"></div>`)
    + `<div class="tx-dialog tx-off" data-dlg="plugins" role="dialog" aria-label="Plugins" inert>${PLUGFACE}</div><div class="tx-overlay"></div>`;
  container.textContent = "";
  container.append(appEl);
  const q = s => appEl.querySelector(s);
  const face = id => q(`[data-face="${id}"]`);
  const overlay = q(".tx-overlay"), dialog = q(".tx-dialog");
  function instantly(fn) { appEl.classList.add("tx-instant"); try { fn(); } finally { void appEl.offsetWidth; appEl.classList.remove("tx-instant"); } }

  /* ================= icons ================= */
  const KIND = { folder: ["i-folder", "var(--tx-folder)"], md: ["i-page", "#5C6B73"], txt: ["i-page", "#868C88"], pdf: ["i-page", "#D64545"], csv: ["i-page", "#2E9E5B"], code: ["i-code", "#D9822B"], svelte: ["i-code", "#E05D3A"], audio: ["i-note", "#8A63D2"], app: ["i-app", "#0E7C72"], img: ["i-image", "#8A63D2"], video: ["i-film", "#C2410C"] };
  const FOLDERSYM = { minimal: "i-folder-o", catppuccin: "ct-folder", classic: "i-folder-classic" };
  const EXT = { md: "markdown", markdown: "markdown", txt: "text", log: "text", m3u: "text", pdf: "pdf", csv: "spreadsheet", tsv: "spreadsheet", rs: "rust", ts: "typescript", tsx: "typescript", html: "html", css: "css", json: "json", toml: "config", yaml: "config", yml: "config", ini: "config", conf: "config", svelte: "svelte", flac: "audio", mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", appimage: "executable", exe: "executable", deb: "executable", webp: "image", png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", avif: "image" };
  const identity = n => EXT[extOf(n.n || "")] || { md: "markdown", txt: "text", pdf: "pdf", csv: "spreadsheet", code: "code", svelte: "svelte", audio: "audio", app: "executable", img: "image" }[n.k] || "file";
  function icon(n, big) {
    if (n.k === "video") {   // a film shows its poster once the poster is known to load; until then, or without one, a film glyph
      if (n.poster && mediaState(n.poster) === "ok") return big ? `<span class="tx-vthumb"><img src="${esc(n.poster)}" alt="" loading="lazy">${ICON("i-play", "tx-vplay")}</span>` : `<img class="tx-thumb" src="${esc(n.poster)}" alt="">`;
      const film = iconPack() === "minimal" ? ["i-doc-o", "var(--tx-ink-2)"] : KIND.video;
      return `<span class="tx-icw"><svg class="tx-ic" style="color:${film[1]}">${U(film[0])}</svg></span>`;
    }
    if (n.src) return big ? `<img src="${esc(n.src)}" alt="" loading="lazy">` : `<img class="tx-thumb" src="${esc(n.src)}" alt="">`;
    const pack = iconPack(), folder = !!n.kids || n.k === "folder", k = KIND[n.k] ? n.k : "txt", git = !!n.repo && state.on.has("git");
    // Material and Catppuccin are the app's own sprites; Minimal is its two outlines; Classic keeps plain documents
    const [sym, color, cls = ""] = folder ? [FOLDERSYM[pack] || (big ? "i-folder-lg" : "i-folder"), git ? "#f05033" : "var(--tx-folder)", pack === "catppuccin" ? " tx-ctp" : ""]   // a repository folder wears the Git colour
      : pack === "material" ? ["mi-" + identity(n), "inherit"]
      : pack === "catppuccin" ? ["ct-" + identity(n), "var(--ctp-text)", " tx-ctp"]
      : pack === "minimal" ? ["i-doc-o", "var(--tx-ink-2)"]
      : KIND[k];
    return `<span class="tx-icw"><svg class="tx-ic${cls}"${cls ? ` fill="none"` : ""} style="color:${color}">${U(sym)}</svg>${git ? `<i class="tx-gb" title="Git repository"></i>` : ""}</span>`;
  }
  const ICON = (sym, cls = "tx-ic") => { const f = sym === "i-folder" && FOLDERSYM[iconPack()]; return `<svg class="${cls}${f === "ct-folder" ? ` tx-ctp" fill="none` : ""}">${U(f || sym)}</svg>`; };

  /* ================= panes ================= */
  const mkState = (path, x = {}) => ({ path, view: "details", sel: null, open: new Set(), back: [], fwd: [], ...x });
  let tabs = [], tabIndex = 0;
  const visits = new Map(), recents = [];
  let clip = [], dragSrc = null, dragAll = [];
  const noteRecent = p => { const i = recents.indexOf(p); if (i >= 0) recents.splice(i, 1); recents.unshift(p); recents.length = Math.min(recents.length, 8); };
  const ros = [];

  function createPane(name) {
    const P = { name, st: null, items: [], cols: 1, rows: 1, keepScroll: false };
    const peekOn = () => state.on.has("peek") && P.st.path !== TRASH && P.st.view === "details";
    // selection: sel is the one the preview and the keys follow; multi holds the rest of a marquee, Ctrl or Shift selection
    const multi = () => P.st.multi ??= new Set();
    const isSel = p => P.st.sel === p || multi().has(p);
    const cls = e => `${isSel(e.p) ? " tx-sel" : ""}${e.depth ? " tx-peeked" : ""}`;
    // Details column headers sort the pane; folders stay above files, as in the app
    const ordered = d => {
      const xs = list(d), s = P.st.sort;
      if (!s || (s.key === "name" && s.dir > 0)) return xs;
      const by = SORTBY[s.key] || SORTBY.name;
      return xs.slice().sort((a, b) => (!!b.kids - !!a.kids) || s.dir * (by(a, b) || 0) || byName(a, b));
    };
    P.sortBy = key => {
      if (!SORTBY[key]) return;
      const s = P.st.sort || { key: "name", dir: 1 };
      P.st.sort = { key, dir: s.key === key ? -s.dir : key === "name" ? 1 : -1 };   // size and date start largest/newest first
      P.keepScroll = true; P.render();
    };
    const mark = () => P.host.querySelectorAll("[data-row]").forEach(r => r.classList.toggle("tx-sel", isSel(r.dataset.row)));
    P.picked = () => { const m = [...multi()].filter(x => nodeAt(x)); return m.length ? m : P.st.sel ? [P.st.sel] : []; };
    P.group = p => multi().size > 1 && multi().has(p) ? P.picked() : p ? [p] : [];   // what an action on p covers
    P.setMulti = (paths, primary = null) => {
      const m = multi(), next = new Set(paths);
      primary = primary && next.has(primary) ? primary : [...next].at(-1) ?? null;
      if (primary === P.st.sel && next.size === m.size && [...next].every(x => m.has(x))) return;
      P.st.multi = next; P.st.sel = primary;
      mark(); sync();
    };
    function tree() {
      const out = [];
      (function walk(d, depth) {
        for (const n of ordered(d)) {
          const p = join(d, n.n), open = !!n.kids && peekOn() && P.st.open.has(p);
          out.push({ p, n, depth, open });
          if (open) walk(p, depth + 1);
        }
      })(P.st.path, 0);
      return out;
    }
    P.render = () => {
      const host = P.host;
      if (!isDir(P.st.path)) { let x = P.st.path; while (x && !isDir(x)) x = parentOf(x); P.st.path = x || "/"; }
      if (P.st.sel && !nodeAt(P.st.sel)) P.st.sel = null;
      for (const x of multi()) if (!nodeAt(x)) multi().delete(x);
      if (!P.st.sel) P.st.sel = [...multi()].at(-1) ?? null;
      const none = list(P.st.path).length ? "" : `<div class="tx-empty">${P.st.path === TRASH ? "The Recycle Bin is empty" : "This folder is empty"}</div>`;
      if (P.st.graph && !nodeAt(P.st.graph)?.repo) P.st.graph = null;
      if (P.st.graph) {   // the commit graph takes the pane over
        const top = host.querySelector(".tx-gscroll")?.scrollTop || 0;
        P.items = []; P.keepScroll = false; host.innerHTML = graphHTML(P.st);
        const sc = host.querySelector(".tx-gscroll"), el = sc?.querySelector(".tx-crow.tx-sel");
        if (sc) { sc.scrollTop = top; if (el) { if (el.offsetTop < sc.scrollTop) sc.scrollTop = el.offsetTop; else if (el.offsetTop + el.offsetHeight > sc.scrollTop + sc.clientHeight) sc.scrollTop = el.offsetTop + el.offsetHeight - sc.clientHeight + 8; } }
        return;
      }
      let html;
      if (P.st.view === "list") {   // names only, flowing down each column and then across
        P.items = ordered(P.st.path).map(n => ({ p: join(P.st.path, n.n), n, depth: 0 }));
        P.rows = Math.max(1, Math.floor((host.clientHeight - 12) / ((theme.layout === "compact" ? 22 : 27) + 1)));
        html = `<div class="tx-pv tx-listv"><div class="tx-scroll"><div class="tx-lgrid" style="--rows:${P.rows}">${P.items.map((e, i) => `<div class="tx-c-row${cls(e)}" data-row="${esc(e.p)}" data-i="${i}" draggable="true"><span class="tx-nm">${icon(e.n)}<span class="tx-fn">${esc(e.n.n)}</span></span></div>`).join("")}</div>${none}</div></div>`;
      } else if (P.st.view === "tiles") {
        const tw = 108;   // the app's medium tile: a 64px icon in a column at least 108px wide
        P.cols = Math.max(1, Math.floor((host.clientWidth - 16 + 6) / (tw + 6)));
        P.items = ordered(P.st.path).map(n => ({ p: join(P.st.path, n.n), n, depth: 0 }));
        html = `<div class="tx-pv tx-tilesv"><div class="tx-scroll"><div class="tx-tgrid" style="--cols:${P.cols};--tw:${tw}px">${P.items.map((e, i) => `<div class="tx-tile${cls(e)}" data-row="${esc(e.p)}" data-i="${i}" draggable="true"><div class="tx-tv">${icon(e.n, true)}</div><div class="tx-tn tx-fn">${esc(e.n.n)}</div></div>`).join("")}</div>${none}</div></div>`;
      } else {
        P.items = tree();
        const caret = e => e.n.kids && peekOn() ? `<button class="tx-caret" type="button" tabindex="-1" aria-expanded="${e.open}" aria-label="${e.open ? "Close" : "Peek into"} ${esc(e.n.n)}" data-caret="${esc(e.p)}"><svg>${U("i-chev")}</svg></button>` : `<span class="tx-nocaret"></span>`;
        html = `<div class="tx-pv tx-details"><div class="tx-colh">${colh(P.st.sort)}</div><div class="tx-scroll">${P.items.map((e, i) => `<div class="tx-c-row${cls(e)}${P.fresh?.has(parentOf(e.p)) ? " tx-enter" : ""}" data-row="${esc(e.p)}" data-i="${i}" style="--d:${e.depth};--k:${i}"${e.depth ? " data-depth" : ""} draggable="true"><span class="tx-nm">${caret(e)}${icon(e.n)}<span class="tx-fn">${esc(e.n.n)}</span></span><span class="tx-sz">${sizeOf(e.n)}</span><span class="tx-dt">${esc(fmtDate(e.n.d))}</span></div>`).join("")}${none}</div></div>`;
        P.fresh = null;
      }
      const old = host.querySelector(".tx-scroll"), keep = old ? [old.scrollTop, old.scrollLeft] : [0, 0];
      host.innerHTML = html;
      const sc = host.querySelector(".tx-scroll");
      if (sc && P.keepScroll) [sc.scrollTop, sc.scrollLeft] = keep;
      P.keepScroll = true;
    };
    P.setView = (v, animate = true) => {   // rows glide from where they were to where the new view puts them
      const was = P.st.graph;
      P.st.graph = null;
      if (P.st.view === v && !was) return;
      const first = new Map();
      if (animate && !reduce() && !was) P.host.querySelectorAll("[data-row]").forEach(r => first.set(r.dataset.row, r.getBoundingClientRect()));
      P.st.view = v; P.keepScroll = false;
      P.render(); sync();
      if (P === main) emitSetup();
      const k = P.host.getBoundingClientRect().width / P.host.offsetWidth || 1;
      P.host.querySelectorAll("[data-row]").forEach((r, i) => {
        const a = first.get(r.dataset.row);
        if (!a) return;
        const b = r.getBoundingClientRect(), dx = (a.left - b.left) / k, dy = (a.top - b.top) / k;
        if (Math.abs(dx) + Math.abs(dy) < 1) return;
        r.animate([{ transform: `translate(${dx}px, ${dy}px)`, opacity: .5 }, { transform: "none", opacity: 1 }], { duration: 460, easing: "cubic-bezier(.22, .8, .18, 1)", delay: Math.min(i * 9, 140), fill: "backwards" });
      });
    };
    P.toggleOpen = p => {
      if (P.st.open.has(p)) { for (const x of [...P.st.open]) if (under(x, p)) P.st.open.delete(x); }
      else { P.st.open.add(p); if (!reduce()) P.fresh = new Set([p]); }
      P.render();
    };
    P.select = (p, o = {}) => {
      const prev = P.st.sel;
      P.st.sel = p; multi().clear();
      if (p && nodeAt(p) && !isDir(p)) noteRecent(p);
      // mark rows in place: replacing the clicked row between the two clicks of a double-click swallows the dblclick
      if (p === null || P.items.some(e => e.p === p)) P.host.querySelectorAll("[data-row]").forEach(r => r.classList.toggle("tx-sel", r.dataset.row === p));
      else P.render();
      if (o.reveal) P.reveal();
      sync();
      if (p && p !== prev && nodeAt(p) && !isDir(p)) emit("open", { path: p, how: "select", pane: P.name });
    };
    P.go = (p, how = "push") => {
      if (!isDir(p)) { toast(`${title(p)} isn't there any more`); return; }
      if (P.st.graph) { P.st.graph = null; if (p === P.st.path) { P.render(); sync(); return; } }
      if (p === P.st.path) return;
      if (how === "push") { P.st.back.push(P.st.path); P.st.fwd = []; }
      P.st.path = p; P.st.sel = null; multi().clear(); P.keepScroll = false;
      visits.set(p, (visits.get(p) || 0) + 1);
      P.render(); sync();
      emit("navigate", { path: p, pane: P.name });
    };
    P.open = p => {
      if (isDir(p)) return P.go(p);
      const n = nodeAt(p);
      if (n?.k === "video") { P.select(p); emit("open", { path: p, how: "open", pane: P.name }); return film.open(p); }   // a film plays in the viewer
      const shows = !!n && (n.text != null || !!n.src);   // something the preview can show opens there
      if (shows) ensure("preview");
      P.select(p); emit("open", { path: p, how: "open", pane: P.name });
      if (!shows) toast(`Opened ${nameOf(p)} in its default app`);
    };
    P.up = () => {
      const from = P.st.path;
      if (from === TRASH) return P.go(HOME);
      const to = parentOf(from);
      if (!to) return;
      P.go(to); P.select(from, { reveal: true });
    };
    P.back = () => { const p = P.st.back.pop(); if (!p) return; P.st.fwd.push(P.st.path); P.go(p, "none"); };
    P.fwd = () => { const p = P.st.fwd.pop(); if (!p) return; P.st.back.push(P.st.path); P.go(p, "none"); };
    P.reveal = () => {
      const el = P.host.querySelector(".tx-sel"), sc = P.host.querySelector(".tx-scroll");
      if (!el || !sc) return;
      const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect(), k = sc.offsetHeight / (s.height || 1);
      if (r.top < s.top) sc.scrollTop -= (s.top - r.top) * k + 4;
      else if (r.bottom > s.bottom) sc.scrollTop += (r.bottom - s.bottom) * k + 4;
      if (r.left < s.left) sc.scrollLeft -= (s.left - r.left) * k + 6;
      else if (r.right > s.right) sc.scrollLeft += (r.right - s.right) * k + 6;
    };
    P.key = k => {
      if (P.st.graph) {
        const cs = graphCommits(P.st.graph), at = cs.findIndex(c => c.hash === P.st.commit);
        const to = clamp(at + ({ ArrowDown: 1, ArrowUp: -1, Home: -1e9, End: 1e9 }[k] || 0), 0, cs.length - 1);
        if (cs[to] && to !== at) { P.st.commit = cs[to].hash; P.st.gfile = null; P.render(); }
        return;
      }
      const n = P.items.length;
      if (!n) return;
      const i = P.items.findIndex(e => e.p === P.st.sel), cur = P.items[i], tiles = P.st.view === "tiles", lst = P.st.view === "list";
      if (!tiles && !lst && cur && (k === "ArrowRight" || k === "ArrowLeft")) {      // tree keys, as in VS Code
        if (k === "ArrowRight" && cur.n.kids && peekOn()) {
          if (!cur.open) return P.toggleOpen(cur.p);
          if (P.items[i + 1]?.depth > cur.depth) P.select(P.items[i + 1].p, { reveal: true });
          return;
        }
        if (k === "ArrowLeft") { if (cur.open) return P.toggleOpen(cur.p); if (cur.depth) P.select(parentOf(cur.p), { reveal: true }); }
        return;
      }
      const step = { ArrowDown: tiles ? P.cols : 1, ArrowUp: tiles ? -P.cols : -1, ArrowRight: lst ? P.rows : 1, ArrowLeft: lst ? -P.rows : -1, Home: -n, End: n }[k];
      const j = i < 0 ? (step > 0 ? 0 : n - 1) : clamp(i + step, 0, n - 1);
      P.select(P.items[j].p, { reveal: true });
    };
    P.rename = (p = P.st.sel) => {
      if (!p || under(p, TRASH)) return;
      const span = P.host.querySelector(`[data-row="${CSS.escape(p)}"] .tx-fn`);
      if (!span) return;
      const old = nameOf(p);
      span.innerHTML = `<input class="tx-ren" value="${esc(old)}" aria-label="New name" spellcheck="false">`;
      const inp = span.firstChild, dot = old.lastIndexOf(".");
      inp.focus();
      inp.setSelectionRange(0, dot > 0 && !isDir(p) ? dot : old.length);
      let done = false;
      const finish = (ok, later = false) => {
        if (done) return;
        done = true;
        const v = inp.value.trim();
        if (ok && v && v !== old) {
          if (v.includes("/")) toast("Names can't contain /");
          else if (nodeAt(join(parentOf(p), v))) toast(`${v} already exists here`);
          else { const np = fs.rename(p, v); remap(p, np); toast(`Renamed to ${v}`, true); }
        }
        // a blur can come from the pane re-rendering underneath the input; redrawing inside that removal throws
        if (later) queueMicrotask(() => { renderAll(); if (P.host.contains(document.activeElement) || document.activeElement === document.body) focusPane(P); });
        else { renderAll(); focusPane(P); }
      };
      inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
      inp.addEventListener("blur", () => finish(true, true));
      for (const ev of ["click", "dblclick", "pointerdown"]) inp.addEventListener(ev, e => e.stopPropagation());
    };
    P.attach = host => {
      P.host = host;
      /* drag select: a press on a name or icon drags the file, a press anywhere else in the list draws a marquee */
      host.addEventListener("pointerdown", e => {
        setActive(P);
        const sc = e.target.closest(".tx-scroll");
        if (!sc || e.button !== 0 || e.pointerType === "touch" || e.target.closest(".tx-icw, .tx-thumb, .tx-tv, .tx-caret, input")) return;
        const fn = e.target.closest(".tx-fn");   // the name's box runs the width of its column; only its text counts as the name
        if (fn) { const rg = document.createRange(); rg.selectNodeContents(fn); const b = rg.getBoundingClientRect(); if (e.clientX >= b.left - 6 && e.clientX <= b.right + 6) return; }
        if (e.target === sc && e.offsetX > sc.clientWidth) return;   // the scrollbar
        const add = e.ctrlKey || e.metaKey || e.shiftKey;
        P.mq = { id: e.pointerId, x: e.clientX, y: e.clientY, sc, top: sc.scrollTop, base: add ? P.picked() : [], live: false };
      });
      host.addEventListener("pointermove", e => {
        const m = P.mq;
        if (!m || e.pointerId !== m.id) return;
        if (!m.live) {
          if (Math.hypot(e.clientX - m.x, e.clientY - m.y) < 5) return;
          m.live = true;
          host.setPointerCapture(m.id);
          m.band = document.createElement("div"); m.band.className = "tx-marquee";
          host.append(m.band);
        }
        const hr = host.getBoundingClientRect(), sr = m.sc.getBoundingClientRect(), k = hr.width / host.offsetWidth || 1;   // the host page may scale the window
        const y0 = m.y - (m.sc.scrollTop - m.top) * k;   // the press point scrolls with the list
        const L = clamp(Math.min(m.x, e.clientX), sr.left, sr.right), R = clamp(Math.max(m.x, e.clientX), sr.left, sr.right);
        const T = clamp(Math.min(y0, e.clientY), sr.top, sr.bottom), B = clamp(Math.max(y0, e.clientY), sr.top, sr.bottom);
        Object.assign(m.band.style, { left: (L - hr.left) / k + "px", top: (T - hr.top) / k + "px", width: (R - L) / k + "px", height: (B - T) / k + "px" });
        const hit = [...host.querySelectorAll("[data-row]")].filter(r => { const b = r.getBoundingClientRect(); return b.left < R && b.right > L && b.top < B && b.bottom > T; }).map(r => r.dataset.row);
        P.setMulti([...m.base, ...hit], hit.at(e.clientY < y0 ? 0 : -1));
      });
      const endMarquee = e => {
        const m = P.mq;
        if (!m || e.pointerId !== m.id) return;
        P.mq = null;
        if (!m.live) return;
        m.band.remove();
        P.swallow = true; setTimeout(() => P.swallow = false);   // the click that ends a marquee selects nothing new
      };
      host.addEventListener("pointerup", endMarquee);
      host.addEventListener("pointercancel", endMarquee);
      host.addEventListener("click", e => {
        if (P.swallow) return;
        const cm = e.target.closest("[data-commit]");
        if (cm) { if (P.st.commit !== cm.dataset.commit) { P.st.commit = cm.dataset.commit; P.st.gfile = null; } P.render(); return; }
        const gf = e.target.closest("[data-gfile]");
        if (gf) { P.st.gfile = gf.dataset.gfile; P.render(); return; }
        if (e.target.closest("[data-graph-close]")) { P.st.graph = null; P.render(); sync(); return; }
        const c = e.target.closest("[data-caret]");
        if (c) return P.toggleOpen(c.dataset.caret);
        const h = e.target.closest("[data-sort]");
        if (h) return P.sortBy(h.dataset.sort);
        const r = e.target.closest("[data-row]"), p = r?.dataset.row;
        if (r && (e.ctrlKey || e.metaKey)) { const m = new Set(P.picked()); m.has(p) ? m.delete(p) : m.add(p); P.setMulti(m, m.has(p) ? p : null); }
        else if (r && e.shiftKey && P.st.sel) {
          const i = P.items.findIndex(x => x.p === P.st.sel), j = P.items.findIndex(x => x.p === p);
          P.setMulti(P.items.slice(Math.min(i, j), Math.max(i, j) + 1).map(x => x.p), P.st.sel);
        }
        else if (r) P.select(p);
        else if (e.target.closest(".tx-scroll")) P.select(null);
      });
      host.addEventListener("dblclick", e => { const r = e.target.closest("[data-row]"); if (r && !e.target.closest("[data-caret]")) P.open(r.dataset.row); });
      host.addEventListener("contextmenu", e => {
        e.preventDefault();
        setActive(P);
        const r = e.target.closest("[data-row]");
        if (r && P.group(r.dataset.row).length < 2) P.select(r.dataset.row);
        showMenu(e.clientX, e.clientY, r ? r.dataset.row : null, P);
      });
      host.addEventListener("dragstart", e => {
        const r = e.target.closest("[data-row]");
        if (!r || P.mq) return e.preventDefault();   // a marquee in progress is not a file drag
        dragSrc = r.dataset.row;
        dragAll = P.group(dragSrc);
        activeP = P; if (dragAll.length < 2) P.select(dragSrc);
        e.dataTransfer.setData("text/plain", nameOf(dragSrc));
        e.dataTransfer.effectAllowed = "copyMove";
      });
      const ro = new ResizeObserver(() => { if (P.st && !P.st.graph && P.st.view !== "details" && !P.host.querySelector(".tx-ren")) { cancelAnimationFrame(P.ro); P.ro = requestAnimationFrame(P.render); } });
      ro.observe(host); ros.push(ro);
    };
    return P;
  }
  const main = createPane("main"), split = createPane("split");
  let activeP = main;
  const active = () => activeP === split && state.on.has("split") ? split : main;
  const allStates = () => [...tabs, split.st];
  function setActive(P) { if (activeP !== P) { activeP = P; sync(); } }
  function focusPane(P = active()) { P.host?.focus({ preventScroll: true }); }
  function remap(from, to) {
    const fix = p => p && under(p, from) ? to + p.slice(from.length) : p;
    for (const st of allStates()) {
      st.path = fix(st.path); st.sel = fix(st.sel); st.graph = fix(st.graph);
      st.open = new Set([...st.open].map(fix)); st.back = st.back.map(fix); st.fwd = st.fwd.map(fix);
      if (st.multi) st.multi = new Set([...st.multi].map(fix));
    }
    recents.forEach((p, i) => recents[i] = fix(p));
  }
  function renderAll() { main.render(); split.render(); sync(); }

  /* where a user starts: tabs, the second pane, recent files and frequent folders all come from their filesystem */
  const startOf = path => { const p = path ? norm(untilde(String(path))) : HOME; return isDir(p) ? p : nodeAt(p) ? parentOf(p) : HOME; };
  function homeFiles() { return allPaths().map(p => [p, nodeAt(p)]).filter(([p, n]) => !n.kids && !segs(p).some(s => s.startsWith("."))); }
  function initialTabs(start, paths) {
    const want = paths ? paths.map(p => norm(untilde(String(p)))) : [start, repoPaths().find(p => under(p, HOME)), join(HOME, "Downloads")];
    const out = [...new Set(want.filter(isDir))].slice(0, 4);
    if (!out.includes(start)) out.unshift(start);
    return out.map(p => mkState(p));
  }
  function resetPlaces(start, tabPaths) {
    film.close();
    tabs = initialTabs(start, tabPaths); tabIndex = 0;
    main.st = tabs[0]; main.keepScroll = false;
    split.st = mkState(start); split.keepScroll = false; splitShown = false;
    activeP = main;
    const files = homeFiles();
    recents.length = 0;
    recents.push(...files.filter(([, n]) => n.text != null || n.src).slice(0, 4).map(([p]) => p));
    visits.clear();
    list(HOME).filter(n => n.kids).slice(0, 5).forEach((n, i) => visits.set(join(HOME, n.n), 9 - i * 2));
  }
  /* ================= faces that follow the active pane ================= */
  function renderTabs() {
    face("tabs").innerHTML = tabs.map((t, i) => `<button type="button" class="tx-tb${i === tabIndex ? " tx-on" : ""}" data-tab="${i}">${ICON(t.path === TRASH ? "i-trash" : "i-folder")}<span>${esc(title(t.path))}</span><i data-close="${i}" aria-label="Close tab">×</i></button>`).join("")
      + `<button type="button" class="tx-tb tx-add" data-newtab aria-label="New tab">+</button><span class="tx-wc">–▢✕</span>`;
  }
  let addrEditing = false;
  function crumbs(p) {
    if (p === TRASH) return [{ p, t: "Recycle Bin" }];
    const base = HOME !== "/" && under(p, HOME) ? HOME : "/";
    const out = [{ p: base, t: title(base) }];
    let x = base;
    for (const s of segs(p.slice(base === "/" ? 0 : base.length))) { x = join(x, s); out.push({ p: x, t: s }); }
    return out;
  }
  const BARS = () => [[main, "address", "miller"], [split, "address2", "miller2"]];   // each pane's own bar and column
  function renderAddress() {
    for (const [P, id] of BARS()) {
      if (addrEditing === id) continue;
      const st = P.st, c = crumbs(st.path);
      face(id).innerHTML = `<button type="button" class="tx-nv" data-nav="back" ${st.back.length ? "" : "disabled"} aria-label="Back">‹</button><button type="button" class="tx-nv" data-nav="fwd" ${st.fwd.length ? "" : "disabled"} aria-label="Forward">›</button><button type="button" class="tx-nv" data-nav="up" ${parentOf(st.path) ? "" : "disabled"} aria-label="Up one folder">↑</button>`
        + `<div class="tx-crumbs" title="Click to type a path (${keymap.address || "Focus Address Bar"})">${c.map((x, i) => `<button type="button" class="tx-cr${i === c.length - 1 ? " tx-last" : ""}" data-go="${esc(x.p)}">${i === 0 ? ICON(x.p === HOME ? "i-home" : x.p === TRASH ? "i-trash" : "i-drive") : ""}${esc(x.t)}</button>`).join(`<svg class="tx-sep">${U("i-chev")}</svg>`)}</div>`
        + `<button type="button" class="tx-find" data-qo${state.on.has("search") ? "" : " hidden"}>Go to file ${kbd("quickOpen")}</button>`;
    }
  }
  function sideGroups() {
    const own = Array.isArray(user?.bookmarks) ? user.bookmarks.map(p => norm(untilde(String(p)))).filter(isDir) : null;
    const marks = own || [HOME, ...list(HOME).filter(n => n.kids && !n.n.startsWith(".")).slice(0, 7).map(n => join(HOME, n.n))];
    return [["Quick access", marks.map(p => [p, p === HOME ? "Home" : title(p), p === HOME ? "i-home" : "i-folder"])], ["Drives", drives().map(p => [p, title(p), "i-drive"])], ["Other", [[TRASH, "Recycle Bin", "i-trash"]]]];
  }
  function renderSidebar() {
    const cur = active().st.path, bin = list(TRASH).length;
    face("sidebar").innerHTML = sideGroups().map(([h, items]) => `<h4>${h}</h4>` + items.map(([p, t, sym]) => `<button type="button" class="tx-si${cur === p ? " tx-sel" : ""}" data-go="${esc(p)}">${ICON(sym, sym === "i-folder" || sym === "i-home" ? "tx-ic" : "tx-ic tx-g")}${esc(t)}${p === TRASH && bin ? `<em>${bin}</em>` : ""}</button>`).join("")).join("");
  }
  function renderMiller() {   // one column per pane: the parent folder, with the current one picked
    for (const [P, , id] of BARS()) {
      const p = P.st.path, d = parentOf(p) ?? "/";
      face(id).innerHTML = `<div><div class="tx-hd">${esc(d === "/" ? "/" : nameOf(d))}</div>${list(d).filter(n => n.kids).map(n => { const x = join(d, n.n); return `<button type="button" class="tx-mr${x === p ? " tx-sel" : ""}" data-go="${esc(x)}">${ICON("i-folder")}<span>${esc(n.n)}</span><em>›</em></button>`; }).join("")}</div>`;
    }
  }
  function mdHTML(t) {
    return t.split("\n").map(l => l.startsWith("## ") ? `<h4>${esc(l.slice(3))}</h4>` : l.startsWith("# ") ? `<h3>${esc(l.slice(2))}</h3>` : l.startsWith("- ") ? `<ul><li>${esc(l.slice(2))}</li></ul>` : l ? `<p>${esc(l)}</p>` : "").join("");
  }
  /* ================= films =================
     A node with type "video" (or a src ending .mp4/.webm/.mov/.m4v) keeps its file in n.vid and an optional n.poster.
     Media files are asked for once each: a missing one costs a single failed request, never one per render. */
  const media = new Map();   // url -> "ok" | "bad" | "wait"
  let mediaQueued = false;
  function mediaState(url, kind = "img") {
    if (!url) return "bad";
    const known = media.get(url);
    if (known) return known;
    media.set(url, "wait");
    const done = ok => {
      if (media.get(url) !== "wait") return;
      media.set(url, ok ? "ok" : "bad");
      if (mediaQueued) return;
      mediaQueued = true;
      requestAnimationFrame(() => { mediaQueued = false; if (!appEl.querySelector("input.tx-ren")) renderAll(); });   // never under a rename in progress
    };
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata"; v.muted = true;
      v.addEventListener("loadedmetadata", () => { done(true); v.removeAttribute("src"); v.load(); }, { once: true });
      v.addEventListener("error", () => done(false), { once: true });
      v.src = url;
    } else { const i = new Image(); i.onload = () => done(true); i.onerror = () => done(false); i.src = url; }
    return "wait";
  }
  const posterOf = n => n.poster && mediaState(n.poster) === "ok" ? n.poster : "";
  function previewFilm(box, n, path) {
    const ok = mediaState(n.vid, "video") === "ok", poster = posterOf(n);
    const meta = `<strong>${esc(n.n)}</strong><dl><dt>Size</dt><dd>${sizeOf(n)}</dd>${n.dur ? `<dt>Length</dt><dd>${esc(n.dur)}</dd>` : ""}${n.px ? `<dt>Dimensions</dt><dd>${esc(n.px)}</dd>` : ""}<dt>Modified</dt><dd>${esc(fmtDate(n.d))}</dd></dl>`;
    const cur = box.querySelector(":scope > video.tx-pvid");
    if (ok && cur && cur.dataset.path === path) {   // the same film: keep the element (and wherever it is in playback), refresh only the details
      while (cur.nextSibling) cur.nextSibling.remove();
      cur.insertAdjacentHTML("afterend", meta);
      if (poster && !cur.getAttribute("poster")) cur.setAttribute("poster", poster);
      return;
    }
    film.previewGone();
    box.innerHTML = (ok ? `<video class="tx-pvid" data-path="${esc(path)}" src="${esc(n.vid)}"${poster ? ` poster="${esc(poster)}"` : ""} controls playsinline preload="metadata"></video>`
      : poster ? `<img src="${esc(poster)}" alt="">` : `<div class="tx-big">${icon(n)}</div>`) + meta;
  }
  // The viewer: the film fills the app window and plays (with sound: opening follows a click or a key press).
  // Esc or the close control leaves; Space pauses; F asks for real full screen. Closing always stops playback.
  const film = (() => {
    let el = null, vid = null, path = null;
    const FULL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>`;
    const fallback = n => { const poster = posterOf(n); return poster ? `<img src="${esc(poster)}" alt="">` : `<div class="tx-film-none">${icon(n, true)}</div>`; };
    function open(p) {
      const n = nodeAt(p);
      if (!n || n.k !== "video") return;
      close();
      previewGone();
      path = p;
      const playable = mediaState(n.vid, "video") !== "bad", poster = posterOf(n);
      el = document.createElement("div");
      el.className = "tx-film"; el.tabIndex = -1;
      el.setAttribute("role", "dialog"); el.setAttribute("aria-label", n.n);
      el.innerHTML = `<div class="tx-film-bar"><span>${esc(n.n)}</span>${document.fullscreenEnabled ? `<button type="button" data-film="full" aria-label="Full screen" title="Full screen (F)">${FULL}</button>` : ""}<button type="button" data-film="close" aria-label="Close" title="Close (Esc)">×</button></div>`
        + `<div class="tx-film-stage">${playable ? `<video src="${esc(n.vid)}"${poster ? ` poster="${esc(poster)}"` : ""} controls playsinline preload="auto"></video>` : fallback(n)}</div>`;
      appEl.append(el);
      vid = el.querySelector("video");
      if (vid) {
        vid.addEventListener("error", () => { media.set(n.vid, "bad"); if (el && vid) { vid.removeAttribute("src"); vid.closest(".tx-film-stage").innerHTML = fallback(n); vid = null; } }, { once: true });
        const tried = vid.play();
        tried?.catch?.(err => { if (err?.name === "NotAllowedError" && vid) { vid.muted = true; vid.play().catch(() => {}); } });   // sound refused: play silently, controls can unmute
      }
      appEl.classList.add("tx-filming");
      el.focus({ preventScroll: true });
      requestAnimationFrame(() => el?.classList.add("tx-in"));
      emit("film", { path: p, open: true });
    }
    function close() {
      if (!el) return;
      const was = path, box = el;
      if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
      if (document.fullscreenElement && box.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
      box.remove();
      el = vid = path = null;
      appEl.classList.remove("tx-filming");
      focusPane();
      emit("film", { path: was, open: false });
    }
    function toggle() { if (!vid) return; if (vid.paused) vid.play().catch(() => {}); else vid.pause(); }
    function full() { if (!el || !document.fullscreenEnabled) return; if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else el.requestFullscreen?.().catch(() => {}); }
    function key(e) {
      const k = e.key, onButton = e.target?.closest?.("button");
      if (k === "Escape") { e.preventDefault(); close(); return; }
      if ((k === " " || k === "Enter") && onButton) return;   // the focused control does its own thing
      if (k === " " || k === "k" || k === "K") { e.preventDefault(); toggle(); return; }
      if ((k === "f" || k === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); full(); return; }
      if (vid && (k === "ArrowLeft" || k === "ArrowRight")) { e.preventDefault(); vid.currentTime = Math.max(0, vid.currentTime + (k === "ArrowLeft" ? -5 : 5)); return; }
      if (k !== "Tab") e.preventDefault();   // the explorer behind the film does not take keys meanwhile
    }
    function previewGone() { const v = face("preview")?.querySelector("video.tx-pvid"); if (v && !v.paused) v.pause(); }
    appEl.addEventListener("click", e => { const b = e.target.closest?.("[data-film]"); if (!b || !el?.contains(b)) return; if (b.dataset.film === "close") close(); else full(); });
    return { open, close, key, previewGone, isOpen: () => !!el, path: () => path };
  })();
  function renderPreview() {
    const P = active(), n = P.st.sel && nodeAt(P.st.sel), box = face("preview");
    if (!n) {
      film.previewGone();
      const d = nodeAt(P.st.path);
      box.innerHTML = `<div class="tx-big">${icon(P.st.path === TRASH ? { k: "txt" } : { k: "folder" })}</div><strong>${esc(title(P.st.path))}</strong><dl><dt>Contains</dt><dd>${sizeOf(d)}</dd></dl><span class="tx-note">Select a file to preview it.</span>`;
      return;
    }
    if (n.k === "video") return previewFilm(box, n, P.st.sel);
    film.previewGone();
    const kids = n.kids && list(P.st.sel);   // a folder previews as its contents, like the app's own folder preview
    const body = kids ? (kids.length ? `<div class="tx-flist">${kids.map(c => `<div class="tx-fi">${icon(c)}<span>${esc(c.n)}</span></div>`).join("")}</div>` : `<div class="tx-big tx-note">This folder is empty</div>`)
      : n.src ? `<img src="${esc(n.src)}" alt="">`
      : n.k === "csv" && n.text ? `<div class="tx-doc"><table>${n.text.split("\n").map(r => `<tr>${r.split(",").map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`
      : n.k === "md" && n.text ? `<div class="tx-doc">${mdHTML(n.text)}</div>`
      : n.text ? `<pre class="tx-doc">${esc(n.text)}</pre>`
      : `<div class="tx-big">${icon(n)}</div>`;
    box.innerHTML = `${body}<strong>${esc(n.n)}</strong><dl><dt>${n.kids ? "Contains" : "Size"}</dt><dd>${sizeOf(n)}</dd>${n.px ? `<dt>Dimensions</dt><dd>${esc(n.px)}</dd>` : ""}<dt>Modified</dt><dd>${esc(fmtDate(n.d))}</dd>${n.from ? `<dt>From</dt><dd>${esc(tilde(n.from))}</dd>` : ""}${n.deleted ? `<dt>Deleted</dt><dd>${esc(fmtDate(n.deleted))}</dd>` : ""}</dl>`;
  }
  function renderStatus() {
    const P = active(), c = list(P.st.path).length, s = P.st.sel && nodeAt(P.st.sel), r = state.on.has("git") && repoOf(P.st.path), k = P.picked().length;
    face("status").innerHTML = `<span>${c} item${c === 1 ? "" : "s"}${k > 1 ? ` · <b>${k} selected</b>` : s ? ` · <b>1 selected</b> · ${esc(s.n)} · ${sizeOf(s)}` : ""}</span><span class="tx-br">${r ? `${ICON("i-branch")}${esc(r)}` : esc(tilde(P.st.path))}</span>`;
  }
  function sync() {
    renderTabs(); renderAddress(); renderSidebar(); renderMiller(); renderPreview(); renderStatus(); renderTerm();
    const two = state.on.has("split");
    main.host.classList.toggle("tx-act", two && active() === main);
    split.host.classList.toggle("tx-act", two && active() === split);
  }
  function switchTab(i) {
    if (i === tabIndex && main.st === tabs[i]) return;
    tabIndex = i; main.st = tabs[i]; main.keepScroll = false; main.render(); activeP = main; sync();
    emit("navigate", { path: main.st.path, pane: "main" });
  }
  function newTab() { ensure("tabs"); tabs.push(mkState(HOME)); switchTab(tabs.length - 1); }
  const stepTab = d => { if (tabs.length > 1) switchTab((tabIndex + d + tabs.length) % tabs.length); };
  function closeTab(i) {
    if (tabs.length === 1) return toast("The last tab stays open");
    tabs.splice(i, 1);
    if (i < tabIndex || tabIndex >= tabs.length) tabIndex = Math.max(0, tabIndex - 1);
    main.st = tabs[tabIndex]; main.keepScroll = false; main.render(); sync();
  }

  /* ================= terminal: a small shell over the same filesystem and undo history ================= */
  const term = { cwd: HOME, prev: null, seen: null, hist: [], hi: 0, draft: "", out: null, inp: null, ps: null };
  const SPECIAL = /[\s'"\\$`!*?;&|<>()]/;
  const shq = s => SPECIAL.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;   // quote a word for echoing
  const promptHTML = p => { const r = repoOf(p); return `<b>${esc(tilde(p))}</b>${r ? ` <i>(${esc(r)})</i>` : ""} $`; };
  function termBuild() {
    const box = face("terminal");
    box.innerHTML = `<div class="tx-t-out" role="log"></div><div class="tx-t-line"><span class="tx-t-ps"></span><input class="tx-t-in" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Terminal input"></div>`;
    term.out = box.querySelector(".tx-t-out"); term.ps = box.querySelector(".tx-t-ps"); term.inp = box.querySelector(".tx-t-in");
    box.addEventListener("mouseup", () => { if (!String(getSelection())) term.inp.focus({ preventScroll: true }); });
    term.inp.addEventListener("keydown", termKey);
  }
  function tprint(html, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.innerHTML = html;
    term.out.append(d);
    while (term.out.childElementCount > 400) term.out.firstElementChild.remove();
  }
  const scrollTerm = () => { const b = face("terminal"); b.scrollTop = b.scrollHeight; };
  const echoCmd = (cwd, line) => tprint(`${promptHTML(cwd)} <span class="tx-t-cmd">${esc(line)}</span>`);
  function renderTerm() {
    if (!term.inp) return;
    // the real app's direction of sync: the pane drives the shell, never the other way round
    const pane = active().st.path;
    if (term.seen !== pane) {
      const first = term.seen === null;
      term.seen = pane;
      if (!first && pane !== TRASH && pane !== term.cwd && isDir(pane)) { echoCmd(term.cwd, `cd ${shq(tilde(pane))}`); term.prev = term.cwd; term.cwd = pane; scrollTerm(); }
    }
    if (!isDir(term.cwd)) { let c = term.cwd; while (c && !isDir(c)) c = parentOf(c); term.cwd = c || "/"; }
    term.ps.innerHTML = promptHTML(term.cwd);
  }
  const TERM_KEYS = new Set(["quickOpen", "palette", "prevTab", "nextTab", "toggleTerminal"]);
  function termKey(e) {
    // the terminal owns every key except Quick Open, the Command Palette, previous/next tab and the terminal-toggle chord
    const combo = comboOf(e);
    if (combo) {
      if (pending) {
        const c = cmdFor(pending + " " + combo);
        chordClear();
        if (c && c.id === "toggleTerminal") { e.preventDefault(); e.stopPropagation(); return exec(c, "key"); }
      } else {
        const c = cmdFor(combo);
        if (c && TERM_KEYS.has(c.id)) { e.preventDefault(); e.stopPropagation(); return exec(c, "key"); }
        if (keymap.toggleTerminal?.startsWith(combo + " ")) { e.preventDefault(); e.stopPropagation(); return chordStart(combo); }
      }
    }
    e.stopPropagation();
    const inp = term.inp, k = e.key, ctrl = (e.ctrlKey || e.metaKey) && !e.altKey, lk = k.toLowerCase();
    const toEnd = () => requestAnimationFrame(() => inp.setSelectionRange(inp.value.length, inp.value.length));
    if (k === "Enter") { e.preventDefault(); const line = inp.value; inp.value = ""; runLine(line); }
    else if (k === "Tab") { e.preventDefault(); complete(); }
    else if (k === "ArrowUp") { e.preventDefault(); if (term.hi === term.hist.length) term.draft = inp.value; if (term.hi > 0) { term.hi--; inp.value = term.hist[term.hi]; toEnd(); } }
    else if (k === "ArrowDown") { e.preventDefault(); if (term.hi < term.hist.length) { term.hi++; inp.value = term.hi === term.hist.length ? term.draft : term.hist[term.hi]; toEnd(); } }
    else if (ctrl && lk === "c" && !e.shiftKey) { if (String(getSelection()) || inp.selectionStart !== inp.selectionEnd) return; e.preventDefault(); echoCmd(term.cwd, inp.value + "^C"); inp.value = ""; term.hi = term.hist.length; scrollTerm(); }
    else if (ctrl && lk === "l") { e.preventDefault(); term.out.textContent = ""; }
    else if (ctrl && lk === "u") { e.preventDefault(); inp.value = inp.value.slice(inp.selectionStart); inp.setSelectionRange(0, 0); }
    else if (ctrl && lk === "a") { e.preventDefault(); inp.setSelectionRange(0, 0); }
    else if (ctrl && lk === "e") { e.preventDefault(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
  function runLine(line) {
    echoCmd(term.cwd, line);
    const t = line.trim();
    if (t && term.hist.at(-1) !== t) term.hist.push(t);
    term.hi = term.hist.length; term.draft = "";
    if (t) { try { execLine(t); } catch (err) { tprint(esc(`sh: ${err?.message || err}`), "tx-t-err"); console.error(err); } }
    term.ps.innerHTML = promptHTML(term.cwd);
    scrollTerm();
  }
  function tokenize(s) {
    const out = [];
    let cur = "", has = false, quoted = false, qc = null;
    const push = () => {
      if (has) out.push(!quoted && (cur === "~" || cur.startsWith("~/")) ? untilde(cur) : cur);   // ~ expands only when unquoted
      cur = ""; has = false; quoted = false;
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (qc) { if (c === qc) qc = null; else if (qc === '"' && c === "\\" && /["\\$`]/.test(s[i + 1] || "")) cur += s[++i]; else cur += c; continue; }
      if (c === "'" || c === '"') { if (!has) quoted = true; qc = c; has = true; continue; }
      if (c === "\\") { if (i + 1 < s.length) { if (!has) quoted = true; cur += s[++i]; has = true; } continue; }
      if (c === " " || c === "\t") { push(); continue; }
      if (c === ";") { push(); out.push({ op: ";" }); continue; }
      if (c === "&" && s[i + 1] === "&") { push(); out.push({ op: "&&" }); i++; continue; }
      if (c === "|") { push(); out.push({ op: "|" }); if (s[i + 1] === "|") i++; continue; }
      if (c === ">") { push(); if (s[i + 1] === ">") { out.push({ op: ">>" }); i++; } else out.push({ op: ">" }); continue; }
      cur += c; has = true;
    }
    if (qc) return { error: `unexpected EOF while looking for matching \`${qc}'` };
    push();
    return { tokens: out };
  }
  function execLine(text) {
    const tk = tokenize(text);
    if (tk.error) return tprint(esc(`sh: ${tk.error}`), "tx-t-err");
    if (tk.tokens.some(t => t.op === "|")) return tprint("sh: pipes are not supported in this shell", "tx-t-err");
    let cmd = [], ok = true, skip = false;
    const flush = () => { if (cmd.length && !skip) ok = runArgv(cmd); cmd = []; };
    for (const t of tk.tokens) {
      if (t.op === ";") { flush(); skip = false; }
      else if (t.op === "&&") { flush(); skip = skip || !ok; }
      else cmd.push(t);
    }
    flush();
  }
  const plain = h => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; };
  function runArgv(tokens) {
    let redirect = null;
    const argv = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.op === ">" || t.op === ">>") {
        if (typeof tokens[i + 1] !== "string") { tprint("sh: syntax error near unexpected token `newline'", "tx-t-err"); return false; }
        redirect = { file: tokens[++i], append: t.op === ">>" };
      } else argv.push(t);
    }
    if (!argv.length) return true;
    const [name, ...args] = argv, fn = SH[name];
    if (!fn) { tprint(esc(`${name}: command not found`), "tx-t-err"); return false; }
    const buf = [];
    const io = {
      failed: false, mutated: false,
      out: (t, cls) => redirect ? buf.push(String(t)) : tprint(esc(t), cls),
      html: h => redirect ? buf.push(plain(h)) : tprint(h),
      err: t => { tprint(esc(t), "tx-t-err"); io.failed = true; },
    };
    fn(args, io);
    if (redirect && !io.failed) {
      const p = resolve(redirect.file), n = nodeAt(p);
      if (n?.kids) io.err(`sh: ${redirect.file}: Is a directory`);
      else if (!isDir(parentOf(p)) || under(p, TRASH)) io.err(`sh: ${redirect.file}: No such file or directory`);
      else { const text = buf.length ? buf.join("\n") + "\n" : ""; fs.write(p, redirect.append && n?.text ? n.text + text : text); io.mutated = true; }
    }
    if (io.mutated) renderAll();
    return !io.failed;
  }
  const resolve = a => { if (a == null || a === "") return term.cwd; const x = untilde(a); return norm(x.startsWith("/") ? x : term.cwd + "/" + x); };
  const relOut = p => under(p, term.cwd) && p !== term.cwd ? p.slice(term.cwd === "/" ? 1 : term.cwd.length + 1) : tilde(p);
  function flagsOf(args, name, allowed, io) {
    const f = new Set(), rest = [];
    let done = false;
    for (const a of args) {
      if (done || !a.startsWith("-") || a === "-" || /^-\d+$/.test(a)) { rest.push(a); continue; }
      if (a === "--") { done = true; continue; }
      if (a.startsWith("--")) { if (allowed.includes(a)) f.add(a); else { io.err(`${name}: unrecognized option '${a}'`); return null; } continue; }
      for (const ch of a.slice(1)) { if (!allowed.includes(ch)) { io.err(`${name}: invalid option -- '${ch}'`); return null; } f.add(ch); }
    }
    return { f, rest };
  }
  const nameCls = n => n.kids ? "tx-t-dir" : n.k === "app" ? "tx-t-exe" : n.k === "img" ? "tx-t-img" : "";
  const markAll = (line, needle, ci) => {
    if (!needle) return esc(line);
    const hay = ci ? line.toLowerCase() : line;
    let out = "", at = 0, i;
    while ((i = hay.indexOf(needle, at)) >= 0) { out += esc(line.slice(at, i)) + `<mark>${esc(line.slice(i, i + needle.length))}</mark>`; at = i + needle.length; }
    return out + esc(line.slice(at));
  };
  const mkDir = name => ({ n: name, k: "folder", d: "Just now", kids: [] });
  const inBin = p => p === TRASH || under(p, TRASH);
  const HELP = [
    ["ls [-a] [-l] [path…]", "list a folder"], ["cd [path]", "change directory (the file pane stays put)"], ["pwd", "print the working directory"],
    ["cat <file…>", "print files"], ["head [-n N] <file…>", "first lines of a file"], ["tail [-n N] <file…>", "last lines of a file"],
    ["tree [-a] [path]", "draw a folder as a tree"], ["find [path] <name>", "find by name (substring)"], ["grep [-r] [-i] [-n] <text> [path…]", "search inside files"],
    ["mkdir [-p] <dir…>", "make folders"], ["touch <file…>", "make empty files"], ["mv <src…> <dest>", "move or rename"], ["cp [-r] <src…> <dest>", "copy"],
    ["rm [-r] [-f] <path…>", "move to the Recycle Bin (Ctrl+Z in the pane undoes it)"], ["open <path>", "show a folder in the pane, or preview a file"],
    ["echo <text> [> file]", "print, or write a file"], ["git log|status|branch|show", "inside a repository"], ["history · clear · whoami · exit", ""],
  ];
  const SH = {
    help(a, io) { HELP.forEach(([c, d]) => io.html(`<b>${esc(c.padEnd(36))}</b>${esc(d)}`)); },
    pwd(a, io) { io.out(term.cwd); },
    whoami(a, io) { io.out(user?.id || "user"); },
    echo(a, io) { io.out(a.filter(x => x !== "-n").join(" ")); },
    clear() { term.out.textContent = ""; },
    history(a, io) { term.hist.forEach((h, i) => io.out(`${String(i + 1).padStart(5)}  ${h}`)); },
    exit() { setPart("terminal", false); },
    cd(a, io) {
      const arg = a[0] ?? "~", p = arg === "-" ? term.prev : resolve(arg);
      if (arg === "-" && !p) return io.err("cd: OLDPWD not set");
      if (!nodeAt(p)) return io.err(`cd: ${arg}: No such file or directory`);
      if (!isDir(p)) return io.err(`cd: ${arg}: Not a directory`);
      if (arg === "-") io.out(tilde(p));
      term.prev = term.cwd; term.cwd = p;
    },
    ls(args, io) {
      const o = flagsOf(args, "ls", ["a", "A", "l", "h", "1"], io); if (!o) return;
      const all = o.f.has("a") || o.f.has("A"), long = o.f.has("l"), targets = o.rest.length ? o.rest : ["."];
      targets.forEach((a, ti) => {
        const p = resolve(a), n = nodeAt(p);
        if (!n) return io.err(`ls: cannot access '${a}': No such file or directory`);
        if (targets.length > 1 && n.kids) io.out(`${ti ? "\n" : ""}${a}:`);
        let kids = n.kids ? n.kids.filter(k => all || !k.n.startsWith(".")).sort(byName) : [n];
        if (n.kids && o.f.has("a")) kids = [{ n: ".", kids: [], d: n.d }, { n: "..", kids: [], d: "" }, ...kids];
        const nm = k => `<span class="${nameCls(k)}">${esc(shq(k === n && !n.kids ? a : k.n))}</span>`;
        if (long) {
          const owner = user?.id || "user", sw = Math.max(4, ...kids.map(k => (k.kids ? "-" : k.s || "").length)), dw = Math.max(1, ...kids.map(k => (k.d || "").length));
          if (n.kids) io.out(`total ${kids.length}`);
          kids.forEach(k => io.html(esc(`${k.kids ? "drwxr-xr-x" : k.k === "app" ? "-rwxr-xr-x" : "-rw-r--r--"} ${owner} ${(k.kids ? "-" : k.s || "").padStart(sw)} ${(k.d || "").padEnd(dw)} `) + nm(k)));
        } else if (kids.length) io.html(kids.map(nm).join("  "));
      });
    },
    cat(args, io) {
      const o = flagsOf(args, "cat", ["n"], io); if (!o) return;
      if (!o.rest.length) return io.err("cat: missing file operand (reading standard input is not supported here)");
      for (const a of o.rest) {
        const n = nodeAt(resolve(a));
        if (!n) io.err(`cat: ${a}: No such file or directory`);
        else if (n.kids) io.err(`cat: ${a}: Is a directory`);
        else if (n.text == null) io.out(`[binary file, ${n.s}. Try: open ${shq(a)}]`, "tx-t-dim");
        else n.text.replace(/\n$/, "").split("\n").forEach((l, i) => io.out(o.f.has("n") ? `${String(i + 1).padStart(6)}  ${l}` : l));
      }
    },
    head(args, io) { headTail(args, io, "head"); },
    tail(args, io) { headTail(args, io, "tail"); },
    tree(args, io) {
      const o = flagsOf(args, "tree", ["a", "d"], io); if (!o) return;
      const a = o.rest[0] ?? ".", n = nodeAt(resolve(a));
      if (!n) return io.err(`${a} [error opening dir]`);
      if (!n.kids) return io.out(a);
      let dirs = 0, files = 0, lines = 0;
      io.html(`<span class="tx-t-dir">${esc(a)}</span>`);
      (function walk(nd, pre, depth) {
        const kids = nd.kids.filter(k => (o.f.has("a") || !k.n.startsWith(".")) && (!o.f.has("d") || k.kids)).sort(byName);
        kids.forEach((k, i) => {
          const last = i === kids.length - 1;
          if (lines++ < 300) io.html(`${esc(pre + (last ? "└── " : "├── "))}<span class="${nameCls(k)}">${esc(k.n)}</span>`);
          if (k.kids) { dirs++; if (depth < 8) walk(k, pre + (last ? "    " : "│   "), depth + 1); } else files++;
        });
      })(n, "", 1);
      if (lines > 300) io.out(`… and ${lines - 300} more`, "tx-t-dim");
      io.out(`\n${dirs} director${dirs === 1 ? "y" : "ies"}, ${files} file${files === 1 ? "" : "s"}`);
    },
    find(args, io) {
      let pat = null, type = null;
      const rest = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-name" || a === "-iname") pat = args[++i] ?? "";
        else if (a === "-type") type = args[++i];
        else rest.push(a);
      }
      const looksPath = a => /^(\.{1,2}|~)(\/|$)|^\//.test(a);
      let rootArg = ".";
      if (rest.length === 1) { if (looksPath(rest[0]) && pat === null) rootArg = rest[0]; else if (pat === null) pat = rest[0]; else rootArg = rest[0]; }
      else if (rest.length >= 2) { rootArg = rest[0]; if (pat === null) pat = rest[1]; }
      const rp = resolve(rootArg);
      if (!isDir(rp)) return io.err(`find: '${rootArg}': No such file or directory`);
      const needle = (pat || "").replace(/[*?]/g, "").toLowerCase();
      let count = 0;
      (function walk(d, shown) {
        for (const k of nodeAt(d).kids.slice().sort(byName)) {
          const p = join(d, k.n), s = shown + "/" + k.n;
          if (p === TRASH) continue;
          if ((!needle || k.n.toLowerCase().includes(needle)) && (!type || (type === "d") === !!k.kids)) { if (count++ < 200) io.html(esc(shown + "/") + `<span class="${nameCls(k)}">${markAll(k.n, needle, true)}</span>`); }
          if (k.kids) walk(p, s);
        }
      })(rp, rootArg.replace(/\/+$/, ""));
      if (count > 200) io.out(`… and ${count - 200} more`, "tx-t-dim");
      if (!count) io.failed = true;
    },
    grep(args, io) {
      const o = flagsOf(args, "grep", ["r", "R", "i", "n", "l", "c"], io); if (!o) return;
      const [pat, ...paths] = o.rest;
      if (!pat) return io.err("usage: grep [-r] [-i] [-n] [-l] <text> [path…]");
      const rec = o.f.has("r") || o.f.has("R"), ci = o.f.has("i");
      const targets = paths.length ? paths : rec ? ["."] : null;
      if (!targets) return io.err("grep: no file given (reading standard input is not supported here; try grep -r)");
      const files = [];
      for (const a of targets) {
        const p = resolve(a), n = nodeAt(p);
        if (!n) { io.err(`grep: ${a}: No such file or directory`); continue; }
        if (n.kids) { if (!rec) { io.err(`grep: ${a}: Is a directory`); continue; } walkFiles(p, (fp, fn) => files.push([fp, fn])); }
        else files.push([p, n]);
      }
      const many = rec || files.length > 1, needle = ci ? pat.toLowerCase() : pat;
      let hits = 0;
      for (const [fp, fn] of files) {
        if (fn.text == null) continue;
        let fc = 0;
        fn.text.split("\n").forEach((line, i) => {
          if ((ci ? line.toLowerCase() : line).indexOf(needle) < 0) return;
          fc++; hits++;
          if (o.f.has("l") || o.f.has("c") || hits > 300) return;
          io.html(`${many ? `<b>${esc(relOut(fp))}</b><span class="tx-t-dim">:</span>` : ""}${o.f.has("n") ? `<i>${i + 1}</i><span class="tx-t-dim">:</span>` : ""}${markAll(line, needle, ci)}`);
        });
        if (fc && o.f.has("l")) io.out(relOut(fp));
        if (o.f.has("c")) io.out(`${many ? relOut(fp) + ":" : ""}${fc}`);
      }
      if (hits > 300) io.out(`… and ${hits - 300} more lines`, "tx-t-dim");
      if (!hits) io.failed = true;   // like grep: no match is a quiet failure
    },
    mkdir(args, io) {
      const o = flagsOf(args, "mkdir", ["p", "v"], io); if (!o) return;
      if (!o.rest.length) return io.err("mkdir: missing operand");
      let made = 0;
      for (const a of o.rest) {
        const p = resolve(a);
        if (nodeAt(p)) { if (!o.f.has("p") || !isDir(p)) io.err(`mkdir: cannot create directory '${a}': File exists`); continue; }
        if (inBin(p)) { io.err(`mkdir: cannot create directory '${a}': Permission denied`); continue; }
        const chain = [];
        let c = p;
        while (c && !nodeAt(c)) { chain.unshift(c); c = parentOf(c); }
        if (!isDir(c)) { io.err(`mkdir: cannot create directory '${a}': Not a directory`); continue; }
        if (chain.length > 1 && !o.f.has("p")) { io.err(`mkdir: cannot create directory '${a}': No such file or directory`); continue; }
        for (const x of chain) { fs.add(parentOf(x), mkDir(nameOf(x))); made++; if (o.f.has("v")) io.out(`mkdir: created directory '${relOut(x)}'`); }
      }
      batch(made, `Removed ${made} folders`);
      io.mutated = made > 0;
    },
    touch(args, io) {
      if (!args.length) return io.err("touch: missing file operand");
      let made = 0;
      for (const a of args) {
        const p = resolve(a), n = nodeAt(p);
        if (n) { n.d = "Just now"; io.mutated = true; continue; }
        if (!isDir(parentOf(p)) || inBin(p)) { io.err(`touch: cannot touch '${a}': No such file or directory`); continue; }
        fs.add(parentOf(p), { n: nameOf(p), k: inferKind(nameOf(p)), s: "0 B", d: "Just now", text: "" });
        made++;
      }
      batch(made, `Removed ${made} files`);
      if (made) io.mutated = true;
    },
    mv(args, io) { transfer(args, io, "mv"); },
    cp(args, io) { transfer(args, io, "cp"); },
    rm(args, io) {
      const o = flagsOf(args, "rm", ["r", "R", "f", "v", "i", "d"], io); if (!o) return;
      if (!o.rest.length) return o.f.has("f") ? undefined : io.err("rm: missing operand");
      const rec = o.f.has("r") || o.f.has("R"), done = [];
      for (const a of o.rest) {
        const p = resolve(a), n = nodeAt(p);
        if (!n) { if (!o.f.has("f")) io.err(`rm: cannot remove '${a}': No such file or directory`); continue; }
        if (p === "/") { io.err("rm: it is dangerous to operate recursively on '/'"); continue; }
        if (inBin(p)) { io.err(`rm: cannot remove '${a}': it is already in the Recycle Bin`); continue; }
        if (n.kids && !rec && !(o.f.has("d") && !n.kids.length)) { io.err(`rm: cannot remove '${a}': Is a directory`); continue; }
        if (done.some(x => under(p, x))) continue;
        fs.trash(p); done.push(p);
        if (o.f.has("v")) io.out(`removed '${a}'`);
      }
      if (!done.length) return;
      batch(done.length, `Restored ${done.length} items`);
      io.mutated = true;
      toast(`Moved ${many(done, nameOf(done[0]))} to the Recycle Bin`, true);
    },
    open(args, io) {
      if (!args.length) return io.err("open: missing operand");
      const a = args[0], p = resolve(a), n = nodeAt(p);
      if (!n) return io.err(`open: ${a}: No such file or directory`);
      const P = active();
      if (n.kids) return P.go(p);
      ensure("preview");
      if (P.st.path !== parentOf(p)) P.go(parentOf(p));
      P.select(p, { reveal: true });
    },
    git(args, io) {
      const rp = repoRoot(term.cwd);
      if (!rp) return io.err("fatal: not a git repository (or any of the parent directories): .git");
      const g = nodeAt(rp).git || {}, cs = g.commits || [], br = g.branch || nodeAt(rp).repo || "main";
      const [sub, ...rest] = args;
      if (sub === "log") {
        const one = rest.includes("--oneline");
        let n = Infinity;
        rest.forEach((x, i) => { if (/^-\d+$/.test(x)) n = +x.slice(1); else if (x === "-n") n = +rest[i + 1]; });
        cs.slice(0, n).forEach((c, i) => {
          const refs = (c.refs || []).map(r => i === 0 && r === br ? `HEAD -> ${r}` : r);
          if (i === 0 && !refs.some(r => r.startsWith("HEAD"))) refs.unshift("HEAD");
          const deco = refs.length ? ` <i>(${esc(refs.join(", "))})</i>` : "";
          if (one) return io.html(`<span class="tx-t-hash">${esc(String(c.hash).slice(0, 7))}</span>${deco} ${esc(subjectOf(c.msg))}`);
          io.html(`<span class="tx-t-hash">commit ${esc(c.hash)}</span>${deco}`);
          if ((c.parents || []).length > 1) io.out(`Merge: ${c.parents.map(h => String(h).slice(0, 7)).join(" ")}`);
          io.out(`Author: ${c.author || "unknown"}`); io.out(`Date:   ${c.date || ""}`); io.out(""); String(c.msg || "").split("\n").forEach(l => io.out(`    ${l}`)); io.out("");
        });
      } else if (sub === "status") {
        io.out(`On branch ${br}`);
        const ch = Array.isArray(g.changes) ? g.changes : [];
        if (!ch.length) { io.out(`Your branch is up to date with 'origin/${br}'.`); io.out(""); io.out("nothing to commit, working tree clean"); return; }
        io.out("Changes not staged for commit:");
        ch.forEach(c => io.html(`        <span class="${c.status === "A" ? "tx-t-add" : "tx-t-del"}">${esc(({ A: "new file:   ", D: "deleted:    " })[c.status] || "modified:   ")}${esc(c.path)}</span>`));
      } else if (sub === "branch") {
        const others = [...new Set(cs.flatMap(c => c.refs || []).filter(r => r !== br && !r.startsWith("origin/") && !/^v\d/.test(r) && !r.startsWith("tag:")))];
        io.html(`* <span class="tx-t-add">${esc(br)}</span>`);
        others.forEach(r => io.out(`  ${r}`));
      } else if (sub === "show") {
        const want = rest.find(x => !x.startsWith("-")), c = want ? cs.find(x => String(x.hash).startsWith(want)) : cs[0];
        if (!c) return io.err(`fatal: ambiguous argument '${want}': unknown revision`);
        io.html(`<span class="tx-t-hash">commit ${esc(c.hash)}</span>`); io.out(`Author: ${c.author || "unknown"}`); io.out(`Date:   ${c.date || ""}`); io.out(""); String(c.msg || "").split("\n").forEach(l => io.out(`    ${l}`)); io.out("");
        for (const f of c.files || []) {
          if (!f.diff) { io.out(`${f.status || "M"}  ${f.path}`); continue; }
          f.diff.split("\n").forEach(l => io.html(`<span class="${/^\+(?!\+\+)/.test(l) ? "tx-t-add" : /^-(?!--)/.test(l) ? "tx-t-del" : /^@@/.test(l) ? "tx-t-hash" : "tx-t-dim"}">${esc(l)}</span>`));
        }
      } else io.err(sub ? `git: '${sub}' is not supported in this shell. Try: log [--oneline], status, branch, show` : "usage: git log [--oneline] | status | branch | show [hash]");
    },
  };
  function headTail(args, io, name) {
    let n = 10;
    const files = [];
    for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === "-n") n = parseInt(args[++i], 10); else if (/^-n\d+$/.test(a)) n = +a.slice(2); else if (/^-\d+$/.test(a)) n = +a.slice(1); else files.push(a); }
    if (!Number.isFinite(n) || n < 0) return io.err(`${name}: invalid number of lines`);
    if (!files.length) return io.err(`${name}: missing file operand`);
    files.forEach((a, i) => {
      const nd = nodeAt(resolve(a));
      if (files.length > 1) io.out(`${i ? "\n" : ""}==> ${a} <==`);
      if (!nd) io.err(`${name}: cannot open '${a}' for reading: No such file or directory`);
      else if (nd.kids) io.err(`${name}: error reading '${a}': Is a directory`);
      else if (nd.text == null) io.out(`[binary file, ${nd.s}]`, "tx-t-dim");
      else { const ls = nd.text.split("\n"); (name === "head" ? ls.slice(0, n) : ls.slice(Math.max(0, ls.length - n))).forEach(l => io.out(l)); }
    });
  }
  function transfer(args, io, name) {   // mv and cp share their argument rules
    const o = flagsOf(args, name, name === "cp" ? ["r", "R", "f", "v", "a"] : ["f", "v", "n"], io); if (!o) return;
    const r = o.rest;
    if (r.length < 2) return io.err(r.length ? `${name}: missing destination file operand after '${r[0]}'` : `${name}: missing file operand`);
    const dst = r.at(-1), srcs = r.slice(0, -1), dp = resolve(dst), intoDir = isDir(dp);
    if (!intoDir && srcs.length > 1) return io.err(`${name}: target '${dst}' is not a directory`);
    let ops = 0;
    for (const a of srcs) {
      const sp = resolve(a), sn = nodeAt(sp);
      if (!sn) { io.err(`${name}: cannot stat '${a}': No such file or directory`); continue; }
      const target = intoDir ? join(dp, nameOf(sp)) : dp, tparent = parentOf(target);
      if (name === "cp" && sn.kids && !(o.f.has("r") || o.f.has("R") || o.f.has("a"))) { io.err(`cp: -r not specified; omitting directory '${a}'`); continue; }
      if (target === sp) { io.err(`${name}: '${a}' and '${relOut(target)}' are the same file`); continue; }
      if (under(target, sp)) { io.err(`${name}: cannot ${name === "mv" ? "move" : "copy"} '${a}' to a subdirectory of itself, '${dst}'`); continue; }
      if (nodeAt(target)) { io.err(`${name}: cannot overwrite '${relOut(target)}': File exists`); continue; }
      if (!isDir(tparent)) { io.err(`${name}: cannot ${name === "mv" ? "move" : "create"} '${dst}': No such file or directory`); continue; }
      if (inBin(sp) || inBin(target)) { io.err(`${name}: the Recycle Bin is managed by the app (use rm, or Restore in the pane)`); continue; }
      let np;
      if (name === "mv") {
        np = sp;
        if (tparent !== parentOf(sp)) { np = fs.move(sp, tparent); remap(sp, np); ops++; }
        if (nameOf(np) !== nameOf(target)) { const rp = fs.rename(np, nameOf(target)); remap(np, rp); np = rp; ops++; }
      } else {
        np = fs.copy(sp, tparent); ops++;
        if (nameOf(np) !== nameOf(target)) { np = fs.rename(np, nameOf(target)); ops++; }
      }
      if (o.f.has("v")) io.out(`'${a}' -> '${relOut(np)}'`);
    }
    batch(ops, name === "mv" ? `Moved ${srcs.length === 1 ? nameOf(resolve(srcs[0])) : srcs.length + " items"} back` : `Removed ${srcs.length === 1 ? "the copy" : "the copies"}`);
    io.mutated = ops > 0;
  }
  function complete() {
    const inp = term.inp, pos = inp.selectionStart ?? inp.value.length, before = inp.value.slice(0, pos), after = inp.value.slice(pos);
    const raw = before.match(/((?:\\.|[^\s\\;&|><])*)$/)[1], start = before.length - raw.length;
    const lead = before.slice(0, start), isCmd = !lead.trim() || /(;|&&)\s*$/.test(lead);
    const word = raw.replace(/\\(.)/g, "$1");
    let cands;
    if (isCmd) cands = Object.keys(SH).filter(c => c.startsWith(word)).map(c => ({ ins: c, label: c, dir: false }));
    else {
      const cut = word.lastIndexOf("/"), dirPart = cut >= 0 ? word.slice(0, cut + 1) : "", pre = word.slice(cut + 1);
      const dp = resolve(dirPart || ".");
      if (!isDir(dp)) return;
      cands = nodeAt(dp).kids.filter(k => k.n.startsWith(pre) && (pre.startsWith(".") || !k.n.startsWith("."))).sort(byName).map(k => ({ ins: dirPart + k.n, label: k.n + (k.kids ? "/" : ""), dir: !!k.kids }));
    }
    if (!cands.length) return;
    const escW = s => s.replace(/([\s'"\\$`!*?;&|<>()])/g, "\\$1");
    let ins;
    if (cands.length === 1) ins = escW(cands[0].ins) + (cands[0].dir ? "/" : " ");
    else {
      let cp = cands[0].ins;
      for (const c of cands) while (!c.ins.startsWith(cp)) cp = cp.slice(0, -1);
      if (cp.length > word.length) ins = escW(cp);
      else { echoCmd(term.cwd, inp.value); tprint(cands.map(c => `<span class="${c.dir ? "tx-t-dir" : ""}">${esc(c.label)}</span>`).join("  ")); scrollTerm(); return; }
    }
    inp.value = lead + ins + after;
    inp.setSelectionRange(lead.length + ins.length, lead.length + ins.length);
  }
  /* ================= overlays: palettes, menus, suggestions, toasts (inside the window) ================= */
  const relRect = r => { const a = appEl.getBoundingClientRect(), k = a.width / appEl.offsetWidth || 1; return { left: (r.left - a.left) / k, top: (r.top - a.top) / k, right: (r.right - a.left) / k, bottom: (r.bottom - a.top) / k, width: r.width / k, height: r.height / k }; };
  const overlayOpen = () => !!overlay.querySelector(".tx-pal, .tx-menu:not(.tx-sugg)");
  let onDismiss = null;   // a picker that previews its choices puts things back if it is closed without one
  function closeOverlays() { overlay.querySelectorAll(".tx-pal, .tx-menu").forEach(el => el.remove()); const f = onDismiss; onDismiss = null; f?.(); }
  let toastT = 0;
  function toast(msg, undoable) {
    overlay.querySelector(".tx-toast")?.remove();
    const el = document.createElement("div");
    el.className = "tx-toast"; el.setAttribute("role", "status");
    el.innerHTML = `<span>${esc(msg)}</span>${undoable ? `<button type="button">Undo</button>` : ""}`;
    overlay.append(el);
    el.querySelector("button")?.addEventListener("click", () => { el.remove(); undo(); focusPane(); });
    clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 3400);
  }
  function fuzzy(qy, s) {
    qy = qy.toLowerCase(); const t = s.toLowerCase(), hits = [];
    let i = 0, score = 0, last = -2;
    for (let j = 0; j < t.length && i < qy.length; j++) {
      if (t[j] !== qy[i]) continue;
      score += (j === last + 1 ? 3 : 1) + (j === 0 || /[\s._\-/]/.test(t[j - 1]) ? 4 : 0);
      hits.push(j); last = j; i++;
    }
    return i === qy.length ? { score: score - t.length * .02, hits } : null;
  }
  const hl = (s, hits) => [...s].map((c, i) => hits?.includes(i) ? `<mark>${esc(c)}</mark>` : esc(c)).join("");
  function allPaths() {
    const out = [], seen = new Set([HOME]);   // the whole tree, home first so its files rank first on ties
    const walk = d => { for (const n of list(d)) { const p = join(d, n.n); if (seen.has(p)) continue; seen.add(p); out.push(p); if (n.kids) walk(p); } };
    walk(HOME);
    if (HOME !== "/") walk("/");
    return out;
  }
  const fileItem = (p, hits) => ({ html: `${icon(nodeAt(p))}<span class="tx-nm">${hl(nameOf(p), hits)}</span><small>${esc(tilde(parentOf(p)))}</small>`, run: () => reveal(p) });
  function fileResults(qy) {
    qy = qy.trim();
    if (!qy) {
      const files = recents.filter(p => nodeAt(p) && !inBin(p)).slice(0, 5), folders = [...visits].filter(([p]) => isDir(p)).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
      return [{ sec: "Recent files" }, ...files.map(p => fileItem(p)), { sec: "Frequent folders" }, ...folders.map(p => fileItem(p))];
    }
    const scored = [];
    for (const p of allPaths()) {
      const m = fuzzy(qy, nameOf(p)), pm = m ? null : fuzzy(qy, tilde(p));
      if (m || pm) scored.push({ p, s: m ? m.score + 10 : pm.score, hits: m?.hits });
    }
    emit("search", { kind: "files", query: qy, count: scored.length });
    return scored.sort((a, b) => b.s - a.s).slice(0, 40).map(x => fileItem(x.p, x.hits));
  }
  function reveal(p) {
    const P = active();
    if (!nodeAt(p)) return;
    if (isDir(p)) P.go(p);
    else { if (P.st.path !== parentOf(p)) P.go(parentOf(p)); P.select(p, { reveal: true }); }
    focusPane(P);
  }
  function floating(label) {
    const el = document.createElement("div");
    el.className = "tx-pal"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", label);
    overlay.append(el);
    return el;
  }
  /* one floating list drives Quick Open, the command palette, search in files, the theme pickers and the shortcut editor */
  function picker({ label, hint, foot, results, value = "", debounce = 0 }) {
    closeOverlays();
    const el = floating(label);
    el.innerHTML = `<input class="tx-pal-in" spellcheck="false" autocomplete="off" aria-label="${esc(label)}"><div class="tx-pal-list" role="listbox"></div>${foot ? `<div class="tx-pal-foot">${foot}</div>` : ""}`;
    const inp = el.querySelector("input"), lst = el.querySelector(".tx-pal-list");
    const skip = r => !r || r.sec || r.head;
    let res = [], k = 0;
    const draw = () => {
      lst.innerHTML = res.map((r, i) => r.sec ? `<div class="tx-pal-sec">${r.sec}</div>` : r.head ? `<div class="tx-pal-file">${r.head}</div>` : `<div class="tx-pal-item${i === k ? " tx-on" : ""}" data-i="${i}" role="option">${r.html}</div>`).join("") || `<div class="tx-pal-none">No matches</div>`;
      const on = lst.querySelector(".tx-on");
      if (on) { if (on.offsetTop < lst.scrollTop) lst.scrollTop = on.offsetTop - 30; else if (on.offsetTop + on.offsetHeight > lst.scrollTop + lst.clientHeight) lst.scrollTop = on.offsetTop + on.offsetHeight - lst.clientHeight + 6; }
    };
    const run = keep => {
      inp.placeholder = typeof hint === "function" ? hint(inp.value) : hint;
      res = results(inp.value);
      k = keep && !skip(res[k]) ? k : Math.max(0, res.findIndex(r => r.on && !skip(r)));
      if (skip(res[k])) k = res.findIndex(r => !skip(r));
      draw();
    };
    const move = j => { if (j === k || skip(res[j])) return; k = j; draw(); res[k].hover?.(); };
    const pick = i => { const r = res[i]; if (skip(r)) return; if (r.stay) { r.run(); if (el.isConnected) run(true); } else { onDismiss = null; closeOverlays(); r.run(); } };
    let dt = 0, due = false;   // a slow results function (search in files) waits for a pause in typing
    const flushRun = () => { if (due) { clearTimeout(dt); due = false; run(); } };
    inp.addEventListener("input", () => { if (!debounce) return run(); clearTimeout(dt); due = true; dt = setTimeout(flushRun, debounce); });
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) flushRun();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        let j = k;
        do j += e.key === "ArrowDown" ? 1 : -1; while (res[j] && skip(res[j]));
        if (res[j]) move(j);
      } else if (e.key === "Enter") { e.preventDefault(); pick(k); }
      else if (e.key === "Escape") { e.preventDefault(); closeOverlays(); focusPane(); }
      else { const c = cmdFor(comboOf(e)); if (c?.global) { e.preventDefault(); exec(c, "key"); } }   // the other pickers are a shortcut away
    });
    lst.addEventListener("pointermove", e => { const it = e.target.closest("[data-i]"); if (it) move(+it.dataset.i); });
    lst.addEventListener("click", e => { const it = e.target.closest("[data-i]"); if (it) pick(+it.dataset.i); });
    inp.value = value;
    run();
    inp.focus({ preventScroll: true });
    return { el, inp, refresh: () => run(true) };
  }
  const FOOT = `<span><kbd>↑</kbd><kbd>↓</kbd>&nbsp;move</span><span><kbd>Enter</kbd>&nbsp;open</span><span><kbd>Esc</kbd>&nbsp;close</span>`;
  function openPicker(text) {   // Quick Open; a leading > turns it into the command palette
    ensure(text.startsWith(">") ? "palette" : "search");
    return picker({
      label: "Quick Open", value: text,
      hint: v => v.startsWith(">") ? "Run a command" : "Search files and folders by name",
      foot: `${FOOT}<span>Start with <kbd>&gt;</kbd> for commands</span>`,
      results: v => v.startsWith(">") ? commandResults(v.slice(1)) : fileResults(v),
    });
  }
  const openQuickOpen = (text = "") => openPicker(String(text).replace(/^>+/, ""));
  const openCommandPalette = (text = "") => openPicker(">" + String(text).replace(/^>+/, ""));
  /* search in files: every text file in the filesystem, by content */
  function openSearch(text = "") {
    ensure("search");
    let docs = null;   // every text file, lower-cased once per opening rather than once per keystroke
    const corpus = () => docs ??= allPaths().map(p => [p, nodeAt(p)]).filter(([, n]) => n.text != null).map(([p, n]) => ({ p, n, low: n.text.toLowerCase() }));
    return picker({
      label: "Search in files", value: text, hint: "Search inside every file", foot: `${FOOT}<span>Matches are shown line by line</span>`, debounce: 140,
      results: v => {
        const qy = v.trim().toLowerCase();
        if (qy.length < 2) return [{ sec: "Type two letters or more" }];
        const out = [];
        let files = 0, lines = 0, more = 0;
        for (const { p, n, low } of corpus()) {
          if (!low.includes(qy)) continue;
          files++;
          if (files > 40 || lines >= 160) { more++; continue; }
          const hits = n.text.split("\n").map((line, i) => ({ line, i, at: line.toLowerCase().indexOf(qy) })).filter(x => x.at >= 0);
          lines += Math.min(6, hits.length);
          out.push({ head: `${icon(n)}<b>${esc(n.n)}</b><small>${esc(tilde(parentOf(p)))}</small><em>${hits.length}</em>` });
          for (const h of hits.slice(0, 6)) out.push({ html: `<small class="tx-ln">${h.i + 1}</small><span class="tx-nm tx-code">${esc(h.line.slice(Math.max(0, h.at - 60), h.at))}<mark>${esc(h.line.slice(h.at, h.at + qy.length))}</mark>${esc(h.line.slice(h.at + qy.length, h.at + qy.length + 120))}</span>`, run: () => reveal(p) });
        }
        if (more) out.push({ sec: `${more} more file${more === 1 ? "" : "s"} match; type more to narrow it down` });
        emit("search", { kind: "content", query: v.trim(), count: files });
        return out.length ? out : [{ sec: "Nothing contains that" }];
      },
    });
  }
  /* keyboard shortcuts: pick a command, press the keys you want */
  let capturing = null;
  function openKeys(focusId) {
    ensure("hotkeys");
    const pk = picker({
      label: "Keyboard shortcuts", hint: "Find a command, then press Enter to change its shortcut", foot: `<span><kbd>Enter</kbd>&nbsp;rebind</span><span><kbd>Backspace</kbd>&nbsp;while recording clears it</span><span><kbd>Esc</kbd>&nbsp;close</span>`,
      results: v => {
        const qy = v.trim();
        return CMDS.map(c => ({ c, m: qy ? fuzzy(qy, c.t) : { score: 0 } })).filter(x => x.m).sort((a, b) => b.m.score - a.m.score).map(({ c, m }) => ({
          on: c.id === focusId, stay: true,
          html: `${ICON("i-cmd")}<span class="tx-nm">${hl(c.t, m.hits)}</span><small>${capturing === c.id ? `<i class="tx-rec">Press a shortcut…</i>` : kbd(c.id) || `<i class="tx-none">unbound</i>`}</small>`,
          run: () => record(c, pk),
        }));
      },
    });
    return pk;
  }
  function record(c, pk) {
    if (capturing) return;
    capturing = c.id;
    let chord1 = null, chordT = 0;
    const done = () => { capturing = null; clearTimeout(chordT); document.removeEventListener("keydown", onKey, true); if (pk.el.isConnected) { pk.refresh(); pk.inp.focus({ preventScroll: true }); } };
    const bind = combo => {
      const other = cmdFor(combo);
      if (other && other !== c) keymap[other.id] = null;
      keymap[c.id] = combo;
      done(); rebound();
      toast(other && other !== c ? `${combo} now runs ${c.t}, not ${other.t}` : `${c.t} is now ${combo}`);
    };
    const onKey = e => {
      const combo = comboOf(e);
      if (!combo) return;
      e.preventDefault(); e.stopPropagation();
      if (chord1) { const first = chord1; chord1 = null; clearTimeout(chordT); return bind(["Escape", "Enter", "Tab"].includes(combo) ? first : `${first} ${combo}`); }   // the second press of a chord; Esc/Enter/Tab end it as a single key
      if (combo === "Escape") return done();
      if (combo === "Backspace") { keymap[c.id] = null; done(); rebound(); return toast(`${c.t} has no shortcut now`); }
      if (/^Alt\+[A-Z]$/.test(combo)) { chord1 = combo; chordT = setTimeout(() => { chord1 = null; bind(combo); }, 900); return; }   // Alt+letter may start a chord such as Alt+M B
      bind(combo);
    };
    document.addEventListener("keydown", onKey, true);
    // closing the list by any other means ends the recording too
    new MutationObserver((_, mo) => { if (!pk.el.isConnected) { mo.disconnect(); if (capturing === c.id) done(); } }).observe(overlay, { childList: true });
  }

  function showMenu(x, y, p, P) {
    closeOverlays();
    const n = p && nodeAt(p), binHere = P.st.path === TRASH, items = [];
    const graph = repo => ({ t: "Show commit graph", key: kbd("gitGraph"), run: () => { setActive(P); openGraph(repo); } });
    if (n) {
      items.push({ t: "Open", key: caps("Enter"), run: () => P.open(p) });
      if (n.kids && state.on.has("peek") && P.st.view === "details" && !binHere) items.push({ t: P.st.open.has(p) ? "Close peek" : "Peek inside", run: () => P.toggleOpen(p) });
      if (binHere) items.push({ t: "Restore", run: () => restoreSel(P, p) });
      else {
        items.push({ t: "Rename", key: kbd("rename"), run: () => P.rename(p) }, { t: "Copy", key: kbd("copy"), run: () => copySel(p) });
        if (clip.length) items.push({ t: "Paste", key: kbd("paste"), run: () => paste(P) });
        items.push({ t: "Delete", key: kbd("delete"), run: () => trashSel(P, p) });
        if (n.repo && state.on.has("git")) items.push("-", graph(p));
        const ai = pluginItems(p, n);   // every plugin that can act on this file adds itself here
        if (ai.length) items.push("-", { t: "AI", spark: true, sub: ai });
      }
    } else {
      if (!binHere) items.push({ t: "New folder", key: kbd("newFolder"), run: () => newFolder(P) });
      if (clip.length && !binHere) items.push({ t: "Paste", key: kbd("paste"), run: () => paste(P) });
      if (state.on.has("views")) items.push("-", { t: "View", sub: [["details", "Details"], ["list", "List"], ["tiles", "Tiles"]].map(([v, t]) => ({ t, radio: P.st.view === v && !P.st.graph, run: () => P.setView(v) })) });
      if (repoRoot(P.st.path) && state.on.has("git")) items.push(graph(repoRoot(P.st.path)));
      items.push("-", { t: state.hidden ? "Hide hidden files" : "Show hidden files", key: kbd("toggleHidden"), run: () => toggleHidden() });
      items.push({ t: "Copy path", run: () => toast(`Copied ${tilde(P.st.path)}`) });
    }
    const runs = [];
    const html = rows => rows.map((it, i) => {
      if (it === "-") return i ? "<hr>" : "";
      if (it.sub) return `<div class="tx-sub"><button type="button">${it.spark ? ICON("i-spark", "tx-ic tx-spark") : ""}${it.t}<svg class="tx-chev" style="margin-left:auto">${U("i-chev")}</svg></button><div class="tx-menu">${html(it.sub)}</div></div>`;
      runs.push(it.run);
      return `<button type="button" data-run="${runs.length - 1}">${"radio" in it ? `<span class="tx-rd">${it.radio ? "●" : ""}</span>` : ""}${it.spark ? ICON("i-spark", "tx-ic tx-spark") : ""}${esc(it.t)}${it.key ? `<span class="tx-k">${it.key}</span>` : ""}</button>`;
    }).join("");
    const el = document.createElement("div");
    el.className = "tx-menu"; el.setAttribute("role", "menu");
    el.innerHTML = html(items);
    overlay.append(el);
    const at = relRect({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 });
    el.style.left = clamp(at.left, 4, appEl.clientWidth - el.offsetWidth - 4) + "px";
    el.style.top = clamp(at.top, 4, appEl.clientHeight - el.offsetHeight - 4) + "px";
    el.addEventListener("click", e => { const b = e.target.closest("[data-run]"); if (b) { closeOverlays(); runs[+b.dataset.run](); } });
    el.addEventListener("keydown", e => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault(); e.stopPropagation();
      const bs = [...el.querySelectorAll(":scope > button, :scope > .tx-sub > button")], i = bs.indexOf(document.activeElement);
      bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus();
    });
    el.querySelector("button")?.focus({ preventScroll: true });
  }
  docOn("pointerdown", e => { if (!e.target.closest?.(".tx-overlay, .addr-in")) closeOverlays(); }, true);

  /* path entry with autocomplete, used by the address bar */
  function suggestions(text) {
    const t = untilde(text.trim()) || "/", cut = t.lastIndexOf("/"), d = cut <= 0 ? "/" : t.slice(0, cut), pre = t.slice(cut + 1).toLowerCase();
    return isDir(d) ? list(d).filter(n => n.kids && n.n.toLowerCase().startsWith(pre)).map(n => join(d, n.n)).slice(0, 7) : [];
  }
  function pathInput(inp, done) {
    let items = [], k = -1, closed = false;
    const box = document.createElement("div");
    box.className = "tx-menu tx-sugg";
    overlay.append(box);
    const place = () => { const r = relRect(inp.getBoundingClientRect()); box.style.left = r.left - 6 + "px"; box.style.top = r.bottom + 8 + "px"; box.style.minWidth = clamp(r.width, 260, 420) + "px"; };
    const draw = () => { box.innerHTML = items.map((p, i) => `<button type="button" class="${i === k ? "tx-on" : ""}" data-i="${i}">${ICON("i-folder")}<span>${esc(tilde(p))}/</span></button>`).join(""); box.hidden = !items.length; place(); };
    const refresh = () => { items = suggestions(inp.value); k = items.length ? 0 : -1; draw(); };
    const close = p => { if (closed) return; closed = true; box.remove(); done(p); };
    inp.addEventListener("input", refresh);
    inp.addEventListener("keydown", e => {
      if (cmdFor(comboOf(e))?.global) return;   // let the app's own shortcuts through
      e.stopPropagation();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (items.length) { k = (k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; draw(); } }
      else if (e.key === "Tab") { e.preventDefault(); if (k >= 0) { inp.value = tilde(items[k]) + "/"; refresh(); } }
      else if (e.key === "Enter") {
        e.preventDefault();
        const typed = norm(untilde(inp.value.trim()) || "/");
        const target = isDir(typed) ? typed : k >= 0 ? items[k] : null;
        if (target) close(target);
        else { inp.classList.remove("tx-shake"); void inp.offsetWidth; inp.classList.add("tx-shake"); }
      } else if (e.key === "Escape") { e.preventDefault(); close(null); }
    });
    box.addEventListener("pointerdown", e => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); close(items[+b.dataset.i]); } });
    inp.addEventListener("blur", () => setTimeout(() => close(null), 0));
    refresh();
  }
  function editAddress() {
    ensure("address");
    closeOverlays();
    const P = active(), start = tilde(P.st.path) + (P.st.path === "/" || tilde(P.st.path) === "/" ? "" : "/");
    const bar = P === split ? "address2" : "address", c = face(bar).querySelector(".tx-crumbs");
    if (!c) return;
    addrEditing = bar;
    c.innerHTML = `<input class="tx-addr-in" spellcheck="false" autocomplete="off" aria-label="Path">`;
    const inp = c.firstChild;
    inp.value = start;
    inp.focus();
    inp.setSelectionRange(start.length, start.length);
    pathInput(inp, p => { addrEditing = false; if (p) P.go(p); renderAddress(); focusPane(P); });
  }

  /* ================= commands and their keys ================= */
  // Labels, categories and default keys follow the app's own command registry. Every shortcut is looked up here,
  // never written out: rebinding one changes the key and every hint that names it. "Alt+M B" is a chord: two presses.
  const flip = id => ({ run: () => togglePart(id), state: () => state.on.has(id) });
  const CMDS = [
    { id: "quickOpen", cat: "General", t: "Quick Open", key: "Ctrl+P", global: true, run: () => openQuickOpen("") },
    { id: "palette", cat: "General", t: "Command Palette", key: "Ctrl+Shift+P", global: true, run: () => openCommandPalette("") },
    { id: "search", cat: "General", t: "Search in Files", key: "Ctrl+Shift+F", global: true, run: () => openSearch("") },
    { id: "address", cat: "Navigation", t: "Focus Address Bar", key: "Ctrl+L", global: true, run: () => editAddress() },
    { id: "rename", cat: "File", t: "Rename", key: "F2", run: P => { if (P.st.sel) P.rename(); } },
    { id: "delete", cat: "File", t: "Delete", key: "Delete", run: P => { if (P.st.sel) trashSel(P); } },
    { id: "newFolder", cat: "File", t: "New Folder", key: "Ctrl+Shift+N", run: P => newFolder(P) },
    { id: "undo", cat: "Edit", t: "Undo", key: "Ctrl+Z", run: () => undo() },
    { id: "copy", cat: "Edit", t: "Copy", key: "Ctrl+C", run: P => copySel(P.st.sel) },
    { id: "paste", cat: "Edit", t: "Paste", key: "Ctrl+V", run: P => paste(P) },
    { id: "selectAll", cat: "Selection", t: "Select All", key: "Ctrl+A", run: P => P.setMulti(P.items.map(x => x.p), P.st.sel) },
    { id: "viewDetails", cat: "View", t: "Details View", key: null, run: P => { ensure("views"); P.setView("details"); } },
    { id: "viewList", cat: "View", t: "List View", key: null, run: P => { ensure("views"); P.setView("list"); } },
    { id: "viewTiles", cat: "View", t: "Tiles View", key: null, run: P => { ensure("views"); P.setView("tiles"); } },
    { id: "toggleTabs", cat: "View", t: "Toggle Tabs", key: null, ...flip("tabs") },
    { id: "toggleAddress", cat: "View", t: "Toggle Address Bar", key: "Alt+M D", ...flip("address") },
    { id: "toggleSidebar", cat: "View", t: "Toggle Sidebar", key: "Alt+M B", ...flip("sidebar") },
    { id: "toggleMiller", cat: "View", t: "Toggle Miller Columns", key: "Alt+M E", ...flip("miller") },
    { id: "toggleStatus", cat: "View", t: "Toggle Status Bar", key: "Alt+M U", ...flip("status") },
    { id: "togglePreview", cat: "View", t: "Toggle Preview Pane", key: "Space", ...flip("preview") },
    { id: "toggleDual", cat: "View", t: "Toggle Dual Pane", key: "Ctrl+Shift+D", ...flip("split") },
    { id: "toggleTerminal", cat: "View", t: "Toggle Terminal", key: "Alt+M T", run: () => { if (togglePart("terminal")) setTimeout(() => term.inp.focus({ preventScroll: true })); }, state: () => state.on.has("terminal") },
    { id: "togglePeek", cat: "View", t: "Toggle Folder Peek", key: null, ...flip("peek") },
    { id: "toggleHidden", cat: "View", t: "Toggle Hidden Files", key: "Ctrl+H", run: () => toggleHidden(), state: () => state.hidden },
    { id: "themes", cat: "View", t: "Switch Theme...", key: null, run: () => openThemes("colour") },
    { id: "layouts", cat: "View", t: "Switch Layout...", key: null, run: () => openThemes("layout") },
    { id: "icons", cat: "View", t: "Switch Icon Theme...", key: null, run: () => openThemes("icons") },
    { id: "gitGraph", cat: "General", t: "Git: Toggle Commit Graph", key: "Ctrl+Alt+G", run: () => toggleGraph() },
    { id: "plugins", cat: "Plugins", t: "Plugins", key: null, run: () => openPlugins() },
    { id: "keys", cat: "General", t: "Keyboard Shortcuts", key: "Ctrl+/", run: () => openKeys() },
    { id: "goHome", cat: "Navigation", t: "Go Home", key: null, run: P => P.go(HOME) },
    { id: "goBin", cat: "Navigation", t: "Open Recycle Bin", key: null, run: P => P.go(TRASH) },
    { id: "newTab", cat: "Tabs", t: "New Tab", key: null, run: () => newTab() },
    { id: "prevTab", cat: "Tabs", t: "Previous Tab", key: "Ctrl+PageUp", run: () => stepTab(-1) },
    { id: "nextTab", cat: "Tabs", t: "Next Tab", key: "Ctrl+PageDown", run: () => stepTab(1) },
  ];
  const cmdById = id => CMDS.find(c => c.id === id);
  const keymap = Object.fromEntries(CMDS.map(c => [c.id, c.key]));
  const KEYCAP = { Delete: "Del", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", PageUp: "PgUp", PageDown: "PgDn" };
  const caps = combo => combo ? combo.split(" ").map(part => part.split("+").map(k => `<kbd>${esc(KEYCAP[k] || k)}</kbd>`).join("")).join(" ") : "";
  const kbd = id => caps(keymap[id]);
  function comboOf(e) {
    const k = e.key;
    if (!k || ["Control", "Shift", "Alt", "Meta", "AltGraph", "Dead"].includes(k)) return null;
    const byCode = /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : null;   // Shift+1 arrives as "!", Alt+M as "µ" on a Mac
    return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${byCode ?? (k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k)}`;
  }
  const cmdFor = combo => combo && CMDS.find(c => keymap[c.id] === combo);
  const leads = combo => CMDS.some(c => keymap[c.id]?.startsWith(combo + " "));   // the first half of a chord
  let pending = null, pendT = 0;
  const chordClear = () => { clearTimeout(pendT); pending = null; };
  const chordStart = combo => { pending = combo; clearTimeout(pendT); pendT = setTimeout(() => { pending = null; }, 1600); };
  function exec(c, via = "api") {
    if (!c) return;
    c.run(active());
    emit("command", { id: c.id, via });
    if (via === "key" && state.on.has("hotkeys")) flashKey(c);
  }
  function flashKey(c) {   // once shortcuts are fitted, each one pressed names itself
    overlay.querySelector(".tx-keyflash")?.remove();
    const el = document.createElement("div");
    el.className = "tx-keyflash";
    el.innerHTML = `${kbd(c.id)}<span>${esc(c.t)}</span>`;
    overlay.append(el);
    setTimeout(() => el.remove(), 1500);
  }
  function rebound() { sync(); emitSetup(); }   // a key has changed: redraw everything that names one
  function commandResults(qy) {
    qy = qy.trim();
    const rows = CMDS.map(c => ({ c, m: qy ? fuzzy(qy, c.t) : { score: 0 } })).filter(x => x.m);
    if (qy) rows.sort((a, b) => b.m.score - a.m.score);
    return rows.map(({ c, m }) => ({
      html: `<i class="tx-cat">${esc(c.cat)}</i><span class="tx-nm">${hl(c.t, m.hits)}</span><small>${c.state ? `<b class="tx-badge${c.state() ? " tx-on" : ""}">${c.state() ? "ON" : "OFF"}</b>` : ""}${kbd(c.id)}</small>`,
      run: () => exec(c, "palette"),
    }));
  }
  function registerCommand(d) {
    if (!d || !d.id || typeof d.run !== "function") throw new Error("registerCommand({ id, title, keys?, run }) needs an id and a run function");
    const c = { id: String(d.id), cat: d.cat || "Custom", t: d.title || String(d.id), key: d.keys || null, global: !!d.global, run: () => d.run(app) };
    const i = CMDS.findIndex(x => x.id === c.id);
    if (i >= 0) CMDS[i] = c; else CMDS.push(c);
    if (c.key) for (const other of CMDS) if (other !== c && keymap[other.id] === c.key) keymap[other.id] = null;   // the newest binding wins
    keymap[c.id] = c.key;
    sync();
    return c.id;
  }
  /* ================= file actions ================= */
  const many = (ps, one) => ps.length === 1 ? one : `${ps.length} items`;
  function batch(n, say) {   // several changes made in one gesture undo together
    if (n < 2) return;
    const ops = undos.splice(-n);
    undos.push({ say, undo: () => { ops.reverse().forEach(o => o.undo()); return null; } });
  }
  function copySel(p) { const ps = active().group(p); if (!ps.length) return; clip = ps; toast(`Copied ${many(ps, nameOf(p))}`); }
  function paste(P) {
    const src = clip.filter(x => nodeAt(x));
    if (!src.length) return toast("Nothing to paste");
    if (P.st.path === TRASH) return toast("Paste into a folder, not the Recycle Bin");
    const nps = src.filter(x => !under(P.st.path, x)).map(x => fs.copy(x, P.st.path));
    if (!nps.length) return toast("A folder can't be pasted inside itself");
    batch(nps.length, `Removed ${nps.length} items`);
    P.st.sel = nps.at(-1); P.st.multi = new Set(nps.length > 1 ? nps : []); renderAll(); P.reveal();
    toast(`Pasted ${many(nps, nameOf(nps[0]))}`, true);
  }
  function trashSel(P, p = P.st.sel) {
    if (!p) return;
    if (inBin(p)) return toast("That's already in the Recycle Bin");
    const ps = P.group(p);
    if (ps.length > 1) {
      ps.forEach(x => fs.trash(x));
      batch(ps.length, `Restored ${ps.length} items`);
      P.st.sel = null; P.st.multi = new Set();
      renderAll();
      return toast(`Moved ${ps.length} items to the Recycle Bin`, true);
    }
    const i = P.items.findIndex(e => e.p === p), next = i < 0 ? P.st.sel : P.items[i + 1]?.p ?? P.items[i - 1]?.p ?? null;
    fs.trash(p);
    P.st.sel = next && nodeAt(next) ? next : null;
    renderAll();
    toast(`Moved ${nameOf(p)} to the Recycle Bin`, true);
  }
  function restoreSel(P, p) {
    const ps = P.group(p).filter(x => parentOf(x) === TRASH);
    if (!ps.length) return;
    const nps = ps.map(x => fs.restore(x));
    batch(nps.length, `Moved ${nps.length} items back to the Recycle Bin`);
    renderAll();
    toast(nps.length === 1 ? `Restored ${nameOf(nps[0])} to ${title(parentOf(nps[0]))}` : `Restored ${nps.length} items`, true);
  }
  function newFolder(P = active()) {
    if (P.st.path === TRASH) return;
    const p = fs.add(P.st.path, mkDir("New folder"));
    P.st.sel = p; renderAll(); P.reveal(); P.rename(p);
  }
  function undo() {
    const op = undos.pop();
    if (!op) return toast("Nothing to undo");
    const p = op.undo();
    changed("undo", p);
    renderAll();
    if (p && nodeAt(p)) { const P = active(); if (parentOf(p) === P.st.path) P.select(p, { reveal: true }); }
    toast(op.say);
  }
  function toggleHidden() {
    state.hidden = !state.hidden;
    renderAll(); emitSetup();
    toast(state.hidden ? "Showing hidden files" : "Hiding hidden files");
  }

  /* ================= plugins: the app's bundled ones, faked ================= */
  const baseOf = n => (n?.src || "").match(/([^/]+)\.[a-z0-9]+$/i)?.[1];
  const PLUGINS = [
    { id: "nano-banana", name: "Nano Banana", adds: "menu action · dialog", desc: "AI image editing: right-click an image and describe the change.", on: true, menu: "Edit image…", img: true, run: p => openAI(p), demo: "foggy-pines" },
    { id: "upscale", name: "Upscale", adds: "menu action · job", desc: "AI image upscaling, saved beside the original.", on: true, menu: "Upscale 2×", img: true, run: p => upscale(p), demo: "dunes" },
    { id: "theme-from-image", name: "Theme from Image", adds: "command · theme", desc: "Build a colour theme from any picture's dominant colours.", on: true, menu: "Theme from Image", img: true, run: p => themeFrom(p), demo: "sea-cliffs" },
    { id: "ai-rename", name: "AI Rename", adds: "rename suggestion", desc: "Suggests a filename from what is in the file.", on: true, menu: "Suggest a name", run: p => suggestName(p), demo: "screenshot" },
    { id: "ai-organize", name: "AI Organize", adds: "menu action", desc: "Suggests the folder a stray file belongs in.", on: true, menu: "Organize…", run: p => organize(p), demo: "invoice" },
  ];
  const SEAMS = ["commands", "menu actions", "detail columns", "file icons", "previews", "file views", "virtual folders", "image tools", "drop targets"];
  const pluginItems = (p, n) => state.on.has("plugin") ? PLUGINS.filter(g => g.on && (!g.img || n.src) && !n.kids).map(g => ({ t: g.menu, spark: true, run: () => g.run(p) })) : [];
  let dlg = null, aiPath = null;   // which plugin dialog is up: the list of plugins ("plugins"), or the image editor ("ai")
  function applyDialog() {
    const show = !!dlg && state.on.has("plugin");
    if (show) dialog.dataset.dlg = dlg;
    dialog.classList.toggle("tx-off", !show);
    dialog.inert = !show;
  }
  function openPlugins() {
    ensure("plugin");
    closeOverlays(); aiPath = null; dlg = "plugins";
    renderPlugins(); applyDialog();
  }
  function closeDlg() { if (!dlg) return; dlg = null; aiPath = null; applyDialog(); focusPane(); }
  function renderPlugins() {
    dialog.querySelector("[data-plug-list]").innerHTML = `<div class="tx-ttl">Plugins<span>${PLUGINS.filter(g => g.on).length} ON</span><button type="button" class="tx-x" data-ai="close" aria-label="Close">×</button></div>`
      + `<div class="tx-plugs">${PLUGINS.map(g => `<div class="tx-plug${g.on ? "" : " tx-c-off"}"><div><b>${g.name}</b><i>${g.adds}</i><p>${g.desc}</p></div><button type="button" class="tx-try" data-plug-try="${g.id}"${g.on ? "" : " disabled"}>Try it</button><button type="button" class="tx-tg" role="switch" aria-checked="${g.on}" aria-label="${g.name}" data-plug="${g.id}"></button></div>`).join("")}</div>`
      + `<p class="tx-seams">A plugin can add ${SEAMS.slice(0, -1).join(", ")} and ${SEAMS.at(-1)}.</p>`;
  }
  const organizeTarget = p => {
    const n = nodeAt(p), pick = names => names.map(x => join(HOME, x)).find(isDir);
    const to = n.src || n.k === "img" ? pick(["Photos", "Pictures", "Images"]) : n.k === "audio" ? pick(["Music", "Audio", "Recordings"]) : n.k === "code" || n.k === "svelte" ? pick(["Projects", "Code", "src"]) : pick(["Documents", "Docs"]);
    return to && to !== parentOf(p) ? to : null;
  };
  function demoFor(g) {
    const files = homeFiles().map(([p]) => p), imgs = files.filter(p => nodeAt(p).src);
    if (g.img) return imgs.find(p => baseOf(nodeAt(p)) === g.demo) || imgs[0] || null;
    if (g.id === "ai-rename") return files.find(p => nameOf(p).includes(g.demo)) || imgs[0] || files.find(p => nodeAt(p).text) || null;
    return files.find(p => nameOf(p).includes(g.demo) && organizeTarget(p)) || files.filter(p => /\/(Downloads|Desktop)\//.test(p)).find(organizeTarget) || files.find(organizeTarget) || null;
  }
  function tryPlugin(g) {
    const p = demoFor(g);
    if (!p) return toast(`Nothing here for ${g.name} to work on`);
    dlg = null; applyDialog();
    reveal(p);
    setTimeout(() => g.run(p), 450);
  }
  function resetAI(src, result) {
    dialog.querySelector("[data-ai-from]").src = src;
    dialog.querySelector("[data-ai-to]").innerHTML = result;
    const b = dialog.querySelector("[data-ai=go]"); b.disabled = false; b.textContent = "Generate";
  }
  function openAI(p) {
    ensure("plugin");
    closeOverlays();
    aiPath = p; dlg = "ai";
    resetAI(nodeAt(p).src, `<span>The result appears here</span>`);
    applyDialog();
    setTimeout(() => dialog.querySelector("[data-ai-prompt]").focus({ preventScroll: true }), 300);
  }
  function generateAI() {
    const btn = dialog.querySelector("[data-ai=go]");
    if (!aiPath || btn.disabled) return;
    const from = aiPath, to = dialog.querySelector("[data-ai-to]");
    btn.disabled = true; btn.textContent = "Generating…";
    to.innerHTML = `<div class="tx-shimmer"></div>`;
    setTimeout(() => {
      if (aiPath !== from || !nodeAt(from)) return;
      to.innerHTML = `<img src="${esc(asset("crane.webp"))}" alt="">`;
      btn.textContent = "Saved";
      const np = fs.add(parentOf(from), { n: nameOf(from).replace(/\.[^.]+$/, "") + "-edited.webp", k: "img", s: "2.2 MB", d: "Just now", src: asset("crane.webp"), px: "2048 × 1536" });
      const P = active();
      if (P.st.path === parentOf(np)) P.st.sel = np;
      renderAll();
      toast(`Saved ${nameOf(np)} beside the original`, true);
    }, reduce() ? 200 : 1600);
  }
  function upscale(p) {
    const n = nodeAt(p);
    toast(`Upscaling ${n.n}…`);
    setTimeout(() => {
      if (!nodeAt(p)) return;
      const np = fs.add(parentOf(p), { ...structuredClone(n), n: n.n.replace(/(\.[^.]+)$/, "-2x$1"), s: "9.4 MB", d: "Just now", px: (n.px || "").replace(/\d+/g, d => d * 2) });
      active().st.sel = np; renderAll(); active().reveal();
      toast(`Saved ${nameOf(np)} at twice the size`, true);
    }, 1100);
  }
  // Dominant colours, picked from each sample photo: window, secondary surface, text, muted text, accent, folder.
  const PALETTES = {
    "alpine-lake": { v: ["#eef3f8", "#dfe8f1", "#16263a", "#4a5f78", "#c8643c", "#3f7cb8"] },
    "city-blue-hour": { dark: true, v: ["#0e1a33", "#182848", "#e6ecf8", "#a3b3d1", "#f2a544", "#5b8fe8"] },
    dunes: { dark: true, v: ["#2a1410", "#3a1d16", "#fbe9d2", "#d9b79a", "#ff8a3c", "#f2b354"] },
    "foggy-pines": { v: ["#eef0ea", "#e0e5db", "#1f2b24", "#55655a", "#b9783f", "#5d8468"] },
    "river-canyon": { v: ["#f4ece2", "#eadbca", "#3a1f18", "#6d4a3c", "#1f8a86", "#c96a3f"] },
    "sea-cliffs": { dark: true, v: ["#1b1a2e", "#282642", "#f6e9dc", "#c4b3c0", "#ff9d5c", "#4fb4c8"] },
    crane: { v: ["#fbf0e6", "#f3e0d2", "#33211f", "#6f524c", "#d2483a", "#e79a5c"] },
  };
  const FALLBACK_PAL = [{ dark: true, v: ["#16181d", "#20232a", "#e8e6e1", "#b5b1a8", "#d9a441", "#7aa6c2"] }, { v: ["#f2efe8", "#e6e1d6", "#24221f", "#5e5a52", "#3b7a8c", "#c08a3e"] }];
  function themeFrom(p) {
    const n = nodeAt(p), key = baseOf(n);
    if (!key) return toast("That picture has too few colours to build a theme");
    const pal = PALETTES[key] || FALLBACK_PAL[[...key].reduce((s, c) => s + c.charCodeAt(0), 0) % 2];
    setTheme("colour", "from-image", { ...pal, name: `From ${n.n}` });
    toast(`Theme built from ${n.n}`);
  }
  const NAMES = { "city-blue-hour": "city-skyline-at-blue-hour", "river-canyon": "river-bend-in-red-canyon", "alpine-lake": "alpine-lake-at-sunrise", dunes: "dunes-at-sunset", "foggy-pines": "pines-in-morning-fog", "sea-cliffs": "sea-cliffs-at-dusk", crane: "crane-over-misty-hills" };
  function suggestName(p) {
    const n = nodeAt(p), P = active(), key = baseOf(n);
    const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
    const base = NAMES[key] || (n.text ? slug((n.text.split("\n").find(l => /\w/.test(l)) || "").replace(/^#+\s*/, "")) : key ? slug(key) : null);
    if (!base) return toast("Nothing in that file to name it by");
    if (P.st.path !== parentOf(p)) P.go(parentOf(p));
    P.select(p, { reveal: true });
    P.rename(p);
    const inp = P.host.querySelector(".tx-ren");
    if (inp) { inp.value = base + (n.n.match(/\.[^.]+$/)?.[0] || ""); inp.setSelectionRange(0, base.length); toast("Suggested from what is in the file. Enter keeps it."); }
  }
  function organize(p) {
    const n = nodeAt(p), to = organizeTarget(p);
    if (!to) return toast(`${n.n} is already where it belongs`);
    const np = fs.move(p, to);
    if (!np) return;
    remap(p, np); renderAll();
    toast(`Moved ${nameOf(np)} to ${title(to)}, where its kind lives`, true);
  }

  /* ================= the commit graph: it takes over the pane it is opened in, drawn from the repository's data ================= */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = s => { const m = String(s || "").match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/); return m ? `${MON[+m[2] - 1]} ${+m[3]} ${m[1]}${m[4] ? `, ${m[4]}:${m[5]}` : ""}` : String(s || ""); };
  const subjectOf = m => String(m || "").split("\n")[0];
  const bodyOf = m => String(m || "").split("\n").slice(1).join("\n").trim();
  const graphCommits = repo => nodeAt(repo)?.git?.commits || [];
  const LANE = ["var(--tx-teal)", "#D9822B", "#8A63D2", "#2E9E5B", "#D64545", "#3D8FD1"], ROWH = 30;
  function lanesOf(cs) {   // newest first; each commit takes the lane that was waiting for it
    const idx = new Map(cs.map((c, i) => [c.hash, i])), lanes = [];
    let max = 0;
    const rows = cs.map((c, i) => {
      let lane = lanes.indexOf(c.hash);
      if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; }
      for (let l = 0; l < lanes.length; l++) if (lanes[l] === c.hash) lanes[l] = null;
      const parents = (c.parents ?? (cs[i + 1] ? [cs[i + 1].hash] : [])).filter(h => idx.has(h));
      lanes[lane] = parents[0] ?? null;
      for (const h of parents.slice(1)) if (!lanes.includes(h)) { let l = lanes.indexOf(null); if (l < 0) l = lanes.length; lanes[l] = h; }
      max = Math.max(max, lane, lanes.length - 1);
      return { c, lane, parents };
    });
    return { rows, idx, max: Math.min(max, 7) };
  }
  function diffHTML(t) {
    return String(t).split("\n").map(l => `<span class="${/^(\+\+\+|---|diff |index )/.test(l) ? "tx-m" : l.startsWith("+") ? "tx-a" : l.startsWith("-") ? "tx-r" : l.startsWith("@@") ? "tx-c-h" : ""}">${esc(l) || " "}</span>`).join("");
  }
  function graphHTML(st) {
    const node = nodeAt(st.graph), g = node.git || {}, cs = g.commits || [], branch = g.branch || node.repo;
    const head = `<div class="tx-ghead">${ICON("i-branch")}<b>${esc(nameOf(st.graph))}</b><span>${esc(branch)} · ${cs.length} commit${cs.length === 1 ? "" : "s"}</span><button type="button" data-graph-close aria-label="Back to the files">Files</button></div>`;
    if (!cs.length) return `<div class="tx-pv tx-graphv">${head}<div class="tx-gempty">No commits recorded for this repository</div></div>`;
    const { rows, idx, max } = lanesOf(cs), x = l => 15 + Math.min(l, 7) * 16, y = i => i * ROWH + ROWH / 2;
    const edges = rows.flatMap((r, i) => r.parents.map(h => {
      const j = idx.get(h), p = rows[j], a = [x(r.lane), y(i)], b = [x(p.lane), y(j)], col = LANE[Math.max(r.lane, p.lane) % LANE.length];
      const d = r.lane === p.lane ? `M${a}L${b}`
        : p.lane > r.lane ? `M${a}C${a[0]} ${a[1] + 18} ${b[0]} ${a[1] + 10} ${b[0]} ${a[1] + ROWH}L${b}`     // a merge reaches out to the branch, then follows it down
        : `M${a}L${a[0]} ${b[1] - ROWH}C${a[0]} ${b[1] - 10} ${b[0]} ${b[1] - 18} ${b}`;                        // a branch runs down its own lane to where it forked
      return `<path d="${d}" stroke="${col}"/>`;
    })).join("");
    const dots = rows.map((r, i) => { const col = LANE[r.lane % LANE.length], merge = r.parents.length > 1; return `<circle cx="${x(r.lane)}" cy="${y(i)}" r="${merge ? 5 : 4}" fill="${merge ? "var(--tx-app)" : col}" stroke="${col}"/>`; }).join("");
    const sel = cs.find(c => c.hash === st.commit) || cs[0];
    const refCls = r => /^(v\d|tag:)/.test(r) ? " tx-tag" : r.includes("/") && !r.startsWith("origin") ? " tx-br" : "";
    const crow = c => `<div class="tx-crow${c === sel ? " tx-sel" : ""}" data-commit="${esc(c.hash)}"><span class="tx-cm">${(c.refs || []).map(r => `<i class="tx-ref${refCls(r)}">${esc(r)}</i>`).join("")}<span>${esc(subjectOf(c.msg))}</span></span><span class="tx-cw"><b>${esc((c.author || "?")[0].toUpperCase())}</b>${esc(c.author || "")}</span><span class="tx-ct">${esc(fmtDate(c.date))}</span><span class="tx-ch">${esc(String(c.hash).slice(0, 7))}</span></div>`;
    const files = sel.files || [], gf = files.find(f => f.path === st.gfile) || files.find(f => f.diff), body = bodyOf(sel.msg), np = (sel.parents || []).length;
    const detail = `<div class="tx-cdetail"><strong>${esc(subjectOf(sel.msg))}</strong><p><span class="tx-ch">${esc(sel.hash)}</span> · ${esc(sel.author || "")} · ${esc(fmtDate(sel.date))}${np > 1 ? ` · merge of ${np} parents` : ""}</p>${body ? `<p class="tx-cbody" style="white-space:pre-wrap">${esc(body)}</p>` : ""}`
      + files.map(f => `<div class="tx-cf${f === gf ? " tx-on" : ""}" data-gfile="${esc(f.path)}"><b class="tx-s-${esc(f.status || "M")}">${esc(f.status || "M")}</b>${esc(f.path)}${f.diff ? "" : "<small>no diff</small>"}</div>`).join("")
      + (gf?.diff ? `<pre class="tx-diff">${diffHTML(gf.diff)}</pre>` : "") + `</div>`;
    return `<div class="tx-pv tx-graphv${gf?.diff ? " tx-withdiff" : ""}">${head}<div class="tx-gscroll"><div class="tx-glist" style="--gw:${x(max) + 16}px"><svg width="${x(max) + 14}" height="${cs.length * ROWH}" fill="none" stroke-width="2">${edges}${dots}</svg>${cs.map(crow).join("")}</div></div>${detail}</div>`;
  }
  function openGraph(repo) {
    ensure("git");
    const P = active();
    repo = repo || repoRoot(P.st.path) || repoPaths()[0];
    if (!repo || !nodeAt(repo)?.repo) return toast("There are no repositories here");
    closeOverlays();
    if (P.st.path !== repo) P.go(repo);
    if (P.st.graphOf !== repo) { P.st.graphOf = repo; P.st.commit = graphCommits(repo)[0]?.hash ?? null; P.st.gfile = null; }
    P.st.graph = repo;
    P.render(); sync();
  }
  function toggleGraph() {
    const P = active();
    if (P.st.graph) { P.st.graph = null; P.render(); sync(); return; }
    if (!repoRoot(P.st.path) && repoPaths().length) toast("Not in a repository, so here is one");
    openGraph();
  }
  function closeGraphs(render = true) { for (const st of allStates()) st.graph = null; if (render) renderAll(); }

  /* ================= drag and drop: onto folders, bookmarks, crumbs, tabs or the other pane; hold Ctrl to copy ================= */
  let springT = 0, springKey = "";
  const paneOf = el => el.closest('[data-host="split"]') ? split : el.closest('[data-host="main"]') ? main : null;
  function dropTarget(el) {
    const t = el.closest("[data-row], [data-go], [data-tab], .tx-pane-host");
    if (!t) return null;
    if (t.dataset.row) return isDir(t.dataset.row) ? { el: t, d: t.dataset.row, row: true } : { el: paneOf(t).host, d: paneOf(t).st.path };
    if (t.dataset.go) return { el: t, d: t.dataset.go };
    if (t.dataset.tab) return { el: t, d: tabs[+t.dataset.tab].path, tab: +t.dataset.tab };
    return { el: t, d: paneOf(t).st.path };
  }
  const clearDrop = () => appEl.querySelectorAll(".tx-drop").forEach(x => x.classList.remove("tx-drop"));
  const endSpring = () => { clearTimeout(springT); springKey = ""; };
  appEl.addEventListener("dragover", e => {
    if (!dragSrc) return;
    const t = dropTarget(e.target), copy = e.ctrlKey || e.metaKey;
    if (!t || t.d === TRASH && copy || under(t.d, dragSrc) || (!copy && t.d === parentOf(dragSrc))) { clearDrop(); endSpring(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    if (!t.el.classList.contains("tx-drop")) { clearDrop(); t.el.classList.add("tx-drop"); }
    const key = t.tab != null ? "tab" + t.tab : t.row ? t.d : "";
    if (key === springKey) return;
    endSpring(); springKey = key;
    if (t.tab != null && t.tab !== tabIndex) springT = setTimeout(() => switchTab(t.tab), 700);
    else if (t.row && state.on.has("peek")) {
      const P = paneOf(t.el);
      if (P && P.st.view === "details" && !P.st.open.has(t.d)) springT = setTimeout(() => { P.st.open.add(t.d); P.fresh = new Set([t.d]); P.render(); springKey = ""; }, 650);
    }
  });
  appEl.addEventListener("drop", e => {
    const t = dragSrc && dropTarget(e.target), src = dragSrc, all = dragAll.length ? dragAll : [src];
    clearDrop(); endSpring(); dragSrc = null; dragAll = [];
    if (!t) return;
    e.preventDefault();
    if (t.d === TRASH) return trashSel(active(), src);
    const copy = e.ctrlKey || e.metaKey, done = [];
    for (const x of all) {
      if (under(t.d, x)) continue;
      const np = copy ? fs.copy(x, t.d) : fs.move(x, t.d);
      if (!np) continue;
      if (!copy) remap(x, np);
      done.push(np);
    }
    if (!done.length) return;
    batch(done.length, copy ? `Removed ${done.length} items` : `Moved ${done.length} items back`);
    renderAll();
    toast(`${copy ? "Copied" : "Moved"} ${many(done, nameOf(done[0]))} to ${title(t.d)}`, true);
  });
  appEl.addEventListener("dragend", () => { dragSrc = null; clearDrop(); endSpring(); });
  // a spring-opened peek can re-render the source row, so its dragend may never arrive; pointer events resume after any drag
  docOn("pointermove", () => { if (dragSrc) { dragSrc = null; clearDrop(); endSpring(); } });

  /* clicks on the live faces */
  appEl.addEventListener("click", e => {
    const t = e.target;
    if (t.closest(".tx-overlay")) return;
    const own = t.closest("[data-pane]");   // a pane's own bar or column acts on that pane; the sidebar acts on the active one
    if (own) setActive(own.dataset.pane === "split" ? split : main);
    const go = t.closest("[data-go]"); if (go) { const P = active(); P.go(go.dataset.go); focusPane(P); return; }
    const nav = t.closest("[data-nav]"); if (nav) { const P = active(); P[nav.dataset.nav](); focusPane(P); return; }
    if (t.closest("[data-qo]")) { openQuickOpen(""); return; }
    const cl = t.closest("[data-close]"); if (cl) { closeTab(+cl.dataset.close); return; }
    const tb = t.closest("[data-tab]"); if (tb) { switchTab(+tb.dataset.tab); focusPane(main); return; }
    if (t.closest("[data-newtab]")) { newTab(); focusPane(main); return; }
    if (t.closest(".tx-crumbs") && !t.closest("button, input")) { editAddress(); return; }
    const ai = t.closest("[data-ai]"); if (ai) { ai.dataset.ai === "close" ? closeDlg() : generateAI(); return; }
    const pt = t.closest("[data-plug-try]"); if (pt) { tryPlugin(PLUGINS.find(g => g.id === pt.dataset.plugTry)); return; }
    const pg = t.closest("[data-plug]"); if (pg) { const g = PLUGINS.find(x => x.id === pg.dataset.plug); g.on = !g.on; renderPlugins(); return; }
  });
  dialog.querySelector("[data-ai-prompt]").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") generateAI(); if (e.key === "Escape") closeDlg(); });

  /* keyboard: every shortcut is looked up in the keymap, so a rebound key works the moment it is set */
  docOn("keydown", e => {
    if (film.isOpen() && !capturing) {   // the film has the keys while it is up, wherever focus sits in the app or on the bare page
      const t = e.target;
      if (!e.defaultPrevented && (appEl.contains(t) || !t || t === document.body || t === document.documentElement)) film.key(e);
      return;
    }
    if (capturing || e.defaultPrevented) return;
    const t = e.target, inApp = appEl.contains(t), onPage = !t || t === document.body || t === document.documentElement;
    if (!inApp && !onPage) return;   // the host page's own inputs and widgets keep their keys
    const k = e.key, combo = comboOf(e);
    if (!combo) return;
    if (pending) {   // the second press of a chord such as Alt+M B
      const c = cmdFor(pending + " " + combo);
      chordClear(); e.preventDefault();
      if (c) exec(c, "key");
      return;
    }
    const c = cmdFor(combo);
    if (c?.global) { e.preventDefault(); return exec(c, "key"); }
    if (t?.closest?.("input, textarea, [contenteditable]")) return;
    if (!inApp && !(e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(k))) return;   // on the bare page, plain keys still scroll it
    if (k === "Escape") { if (overlayOpen()) { closeOverlays(); focusPane(); } else if (dlg) closeDlg(); else if (active().st.graph) { active().st.graph = null; active().render(); sync(); } return; }
    if (overlayOpen()) return;
    if ((k === "Enter" || k === " ") && t?.closest?.("button")) return;
    if (leads(combo)) { e.preventDefault(); chordStart(combo); return; }
    if (c) { e.preventDefault(); return exec(c, "key"); }
    const P = active(), ctrl = e.ctrlKey || e.metaKey;
    const act = (() => {
      if (e.altKey && k === "ArrowLeft") return P.back();
      if (e.altKey && k === "ArrowRight") return P.fwd();
      if ((e.altKey && k === "ArrowUp") || k === "Backspace") return P.up();
      if (!ctrl && !e.altKey && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) return P.key(k);
      if (k === "Enter" && P.st.sel && !P.st.graph) return P.open(P.st.sel);
      return false;
    })();
    if (act !== false) e.preventDefault();
  });

  /* ================= parts and setups ================= */
  let setupQueued = false;
  function emitSetup() { if (setupQueued || !settled) return; setupQueued = true; queueMicrotask(() => { setupQueued = false; emit("setup", getSetup()); }); }
  let splitShown = false;
  function applyParts() {
    const on = k => state.on.has(k);
    // a second pane opens on the folder you are looking at, in the view you are using
    if (on("split") && !splitShown) { split.st = mkState(main.st.path, { view: main.st.view, sort: main.st.sort }); split.keepScroll = false; }
    splitShown = on("split");
    const vis = { tabs: on("tabs"), sidebar: on("sidebar"), preview: on("preview"), terminal: on("terminal"), status: on("status"), address: on("address"), miller: on("miller"), address2: on("address") && on("split"), miller2: on("miller") && on("split") };
    for (const [k, v] of Object.entries(vis)) { const el = q(`[data-slot="${k}"]`); el.classList.toggle("tx-off", !v); el.inert = !v; }
    const g = q('[data-group="split"]');
    g.classList.toggle("tx-off", !on("split")); g.inert = !on("split");
    if (!on("plugin")) { dlg = null; aiPath = null; }
    applyDialog();
    if (!on("git")) closeGraphs(false);
    if (!on("split") && activeP === split) activeP = main;
    renderAll();
    const f = document.activeElement;   // focus never stays inside a part that has gone
    if (f && appEl.contains(f) && f.closest(".tx-off")) focusPane();
  }
  function setPart(id, on) {
    if (!PART_IDS.includes(id)) { console.warn(`TX: unknown part "${id}"`); return false; }
    on = !!on;
    if (on === state.on.has(id)) return on;
    on ? state.on.add(id) : state.on.delete(id);
    applyParts(); emitSetup();
    return on;
  }
  const togglePart = id => setPart(id, !state.on.has(id));
  const ensure = id => { if (!state.on.has(id)) setPart(id, true); };
  function getSetup() {
    const s = { parts: PART_IDS.filter(id => state.on.has(id)), theme: theme.custom ? { name: theme.custom.name, dark: !!theme.custom.dark, v: theme.custom.v.slice() } : theme.colour, layout: theme.layout, icons: theme.icons, view: main.st.view, path: main.st.path };
    if (state.hidden) s.hidden = true;
    const keys = {};
    for (const c of CMDS) if ((keymap[c.id] ?? null) !== (c.key ?? null)) keys[c.id] = keymap[c.id] ?? null;
    if (Object.keys(keys).length) s.keys = keys;
    return s;
  }
  function setSetup(input, { animate = true } = {}) {
    const s = TX.decodeSetup(input);
    if (!s) { console.warn("TX.setSetup: could not read that setup"); return false; }
    const fade = animate && !reduce();
    const go = () => {
      closeOverlays();
      const whole = Array.isArray(s.parts);   // a setup with parts is complete: what it leaves out is the default
      if ("hidden" in s || whole) state.hidden = !!s.hidden;
      if ((s.keys && typeof s.keys === "object") || whole) { for (const c of CMDS) keymap[c.id] = c.key ?? null; for (const [id, k] of Object.entries(s.keys || {})) if (id in keymap) keymap[id] = k || null; }
      if (s.theme && typeof s.theme === "object" && Array.isArray(s.theme.v) && s.theme.v.length >= 6) { theme.custom = { name: s.theme.name || "Custom", dark: !!s.theme.dark, v: s.theme.v.slice(0, 6) }; theme.colour = "custom"; }
      else if (COLOURS.some(c => c.id === s.theme)) { theme.colour = s.theme; theme.custom = null; }
      if (LAYOUTS.some(l => l.id === s.layout)) theme.layout = s.layout;
      if (ICONSETS.some(i => i.id === s.icons)) theme.icons = s.icons;
      if (Array.isArray(s.parts)) state.on = new Set(s.parts.filter(id => PART_IDS.includes(id)));
      paint(fade);
      if (s.path) {
        const p = norm(untilde(String(s.path)));
        if (isDir(p)) main.go(p); else if (nodeAt(p)) { main.go(parentOf(p)); main.select(p, { reveal: true }); }
      }
      applyParts();
      if (VIEWS.includes(s.view)) main.setView(s.view, fade);
    };
    fade ? go() : instantly(go);
    emitSetup();
    return true;
  }
  function setUser(id, { animate = true } = {}) {
    const u = USERS.find(x => x.id === id);
    if (!u) { console.warn(`TX.setUser: no user "${id}" in this filesystem`); return false; }
    user = u; HOME = homeOf(u);
    closeOverlays(); dlg = null; aiPath = null;
    const start = startOf(u.setup?.path);
    resetPlaces(start, u.tabs);
    term.cwd = start; term.prev = null; term.seen = null;
    if (term.out) term.out.textContent = "";
    setSetup({ ...(u.setup || {}), path: null }, { animate });
    if (u.setup?.path && !isDir(norm(untilde(String(u.setup.path)))) && nodeAt(norm(untilde(String(u.setup.path))))) main.select(norm(untilde(String(u.setup.path))), { reveal: true });
    if (term.inp) { runLine("ls"); term.hist.length = 0; term.hi = 0; }   // the greeting is not something the user typed
    emit("user", { id: u.id, name: u.name || u.id, home: HOME });
    emit("navigate", { path: main.st.path, pane: "main" });
    return true;
  }

  /* ================= the app object ================= */
  const app = {
    el: appEl,
    setSetup, getSetup,
    togglePart, setPart, hasPart: id => state.on.has(id), parts: () => PART_IDS.filter(id => state.on.has(id)),
    setUser, user: () => user ? { id: user.id, name: user.name || user.id, home: HOME } : null, users: () => USERS.map(u => ({ id: u.id, name: u.name || u.id, home: u.home, blurb: u.blurb || "" })),
    navigate(path, { pane = "active" } = {}) {
      const p = norm(untilde(String(path))), P = pane === "split" ? split : pane === "main" ? main : active();
      if (isDir(p)) { P.go(p); return true; }
      if (nodeAt(p)) { if (P.st.path !== parentOf(p)) P.go(parentOf(p)); P.select(p, { reveal: true }); return true; }
      return false;
    },
    path: () => active().st.path,
    selection: () => active().picked(),
    // read-only views of the filesystem, as the app currently has it (after any renames, writes or deletes)
    read(path) { const n = nodeAt(norm(untilde(String(path)))); return n && !n.kids ? (n.text ?? null) : null; },
    list(path) {
      const d = norm(untilde(String(path)));
      if (!isDir(d)) return null;
      return nodeAt(d).kids.map(n => ({ name: n.n, path: join(d, n.n), dir: !!n.kids, kind: n.k, image: !!n.src, video: n.k === "video", repo: !!n.repo, hidden: n.n.startsWith(".") }));
    },
    repoRoot: path => repoRoot(norm(untilde(String(path)))),
    binCount: () => (nodeAt(TRASH)?.kids || []).length,
    openKeys: (commandId = null) => { openKeys(commandId && cmdById(commandId) ? commandId : undefined); },
    playFilm: p => { const n = nodeAt(norm(p)); if (n?.k !== "video") return false; film.open(norm(p)); return true; },
    closeFilm: () => film.close(),
    filmOpen: () => film.path(),
    openPalette: (prefill = "") => { openCommandPalette(prefill); },
    openQuickOpen: (prefill = "") => { openQuickOpen(prefill); },
    openSearch: (prefill = "") => { openSearch(prefill); },
    shell(line) { ensure("terminal"); runLine(String(line)); },
    registerCommand,
    run(id) { const c = cmdById(id); if (!c) { console.warn(`TX.run: no command "${id}"`); return false; } exec(c, "api"); return true; },
    commands: () => CMDS.map(c => ({ id: c.id, title: c.t, cat: c.cat, keys: keymap[c.id] ?? null })),
    on(ev, fn) { (listeners[ev] ||= []).push(fn); return () => app.off(ev, fn); },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
    focus: () => focusPane(),
    toast: msg => toast(String(msg)),
    destroy() {
      cleanups.forEach(f => f()); ros.forEach(r => r.disconnect());
      clearTimeout(toastT); clearTimeout(pendT); clearTimeout(paintT);
      THEMEVARS.forEach(k => themeRoot.style.removeProperty(k));
      delete themeRoot.dataset.txScheme; themeRoot.classList.remove("tx-theming");
      appEl.remove();
      if (current === app) { current = null; if (TX.app === app) TX.app = null; }
    },
  };

  /* ================= first paint ================= */
  main.attach(q('[data-host="main"]'));
  split.attach(q('[data-host="split"]'));
  const setup0 = Object.assign({}, user?.setup || {}, TX.decodeSetup(opts.setup) || {});
  if (!Array.isArray(setup0.parts)) setup0.parts = PART_IDS.slice();
  const start = startOf(setup0.path);
  resetPlaces(start, opts.tabs);
  term.cwd = start;
  termBuild();
  setSetup({ ...setup0, path: null }, { animate: false });
  const startFile = setup0.path && norm(untilde(String(setup0.path)));
  if (startFile && nodeAt(startFile) && !isDir(startFile)) main.select(startFile, { reveal: true });
  runLine("ls");
  term.hist.length = 0; term.hi = 0;
  void appEl.offsetWidth;
  appEl.classList.remove("tx-instant");
  settled = true;
  document.fonts?.ready.then(() => { if (current === app) renderAll(); });
  current = TX.app = app;
  return app;
};
})();

/**
 * Nerd Font icon mappings for the Material icon theme.
 * Issue: tauri-explorer-gmpb
 *
 * Maps file extensions and special filenames to Nerd Font glyphs and colors.
 * Uses BMP-range codepoints (dev/fa/custom) to avoid surrogate pair complexity.
 */

export interface NerdIcon {
  readonly glyph: string;
  readonly color: string;
}

/** Default icon for unknown file types */
export const DEFAULT_FILE_ICON: NerdIcon = { glyph: "\uF15B", color: "#6D8086" }; // nf-fa-file

/** Folder icons */
export const FOLDER_ICON: NerdIcon = { glyph: "\uE5FF", color: "#90A4AE" };
export const FOLDER_OPEN_ICON: NerdIcon = { glyph: "\uE5FE", color: "#90A4AE" };

/** Extension-to-icon mapping */
const EXT_ICONS: Record<string, NerdIcon> = {
  // Programming languages
  ts:     { glyph: "\uE8CA", color: "#519ABA" },
  tsx:    { glyph: "\uE7BA", color: "#1354BF" },
  js:     { glyph: "\uE781", color: "#CBCB41" },
  jsx:    { glyph: "\uE7BA", color: "#20C2E3" },
  mjs:    { glyph: "\uE781", color: "#F1E05A" },
  py:     { glyph: "\uE73C", color: "#FFBC03" },
  rs:     { glyph: "\uE7A8", color: "#DEA584" },
  go:     { glyph: "\uE724", color: "#00ADD8" },
  java:   { glyph: "\uE738", color: "#CC3E44" },
  c:      { glyph: "\uE61E", color: "#599EFF" },
  cpp:    { glyph: "\uE7A3", color: "#519ABA" },
  cc:     { glyph: "\uE7A3", color: "#519ABA" },
  cxx:    { glyph: "\uE7A3", color: "#519ABA" },
  h:      { glyph: "\uE7A3", color: "#A074C4" },
  hpp:    { glyph: "\uE7A3", color: "#A074C4" },
  cs:     { glyph: "\uE7B2", color: "#596706" },
  rb:     { glyph: "\uE739", color: "#701516" },
  php:    { glyph: "\uE73D", color: "#A074C4" },
  swift:  { glyph: "\uE755", color: "#E37933" },
  kt:     { glyph: "\uE81B", color: "#7F52FF" },
  kts:    { glyph: "\uE81B", color: "#7F52FF" },
  lua:    { glyph: "\uE826", color: "#51A0CF" },
  vim:    { glyph: "\uE7C5", color: "#019833" },
  svelte: { glyph: "\uE8B7", color: "#FF3E00" },
  vue:    { glyph: "\uE8DC", color: "#8DC149" },

  // Web
  html:   { glyph: "\uE736", color: "#E44D26" },
  htm:    { glyph: "\uE736", color: "#E44D26" },
  css:    { glyph: "\uE749", color: "#663399" },
  scss:   { glyph: "\uE74B", color: "#F55385" },
  sass:   { glyph: "\uE74B", color: "#F55385" },
  less:   { glyph: "\uE749", color: "#1D365D" },
  json:   { glyph: "\uE80B", color: "#CBCB41" },
  jsonc:  { glyph: "\uE80B", color: "#CBCB41" },
  xml:    { glyph: "\uF121", color: "#E37933" },
  yaml:   { glyph: "\uE8EB", color: "#6D8086" },
  yml:    { glyph: "\uE8EB", color: "#6D8086" },

  // Documents
  md:       { glyph: "\uE73E", color: "#DDDDDD" },
  markdown: { glyph: "\uE73E", color: "#DDDDDD" },
  txt:      { glyph: "\uF15C", color: "#89E051" },
  pdf:      { glyph: "\uF1C1", color: "#B30B00" },
  doc:      { glyph: "\uF1C2", color: "#185ABD" },
  docx:     { glyph: "\uF1C2", color: "#185ABD" },
  rtf:      { glyph: "\uF1C2", color: "#185ABD" },
  odt:      { glyph: "\uF1C2", color: "#185ABD" },
  xls:      { glyph: "\uF1C3", color: "#1D6F42" },
  xlsx:     { glyph: "\uF1C3", color: "#1D6F42" },
  csv:      { glyph: "\uF1C3", color: "#1D6F42" },
  ods:      { glyph: "\uF1C3", color: "#1D6F42" },
  ppt:      { glyph: "\uF1C4", color: "#D24726" },
  pptx:     { glyph: "\uF1C4", color: "#D24726" },
  odp:      { glyph: "\uF1C4", color: "#D24726" },

  // Archives
  zip:  { glyph: "\uF1C6", color: "#ECA517" },
  tar:  { glyph: "\uF1C6", color: "#ECA517" },
  gz:   { glyph: "\uF1C6", color: "#ECA517" },
  bz2:  { glyph: "\uF1C6", color: "#ECA517" },
  xz:   { glyph: "\uF1C6", color: "#ECA517" },
  "7z": { glyph: "\uF1C6", color: "#ECA517" },
  rar:  { glyph: "\uF1C6", color: "#ECA517" },

  // Images
  jpg:  { glyph: "\uF03E", color: "#A074C4" },
  jpeg: { glyph: "\uF03E", color: "#A074C4" },
  png:  { glyph: "\uF03E", color: "#A074C4" },
  gif:  { glyph: "\uF03E", color: "#A074C4" },
  bmp:  { glyph: "\uF03E", color: "#A074C4" },
  webp: { glyph: "\uF03E", color: "#A074C4" },
  ico:  { glyph: "\uF03E", color: "#A074C4" },
  svg:  { glyph: "\uF03E", color: "#FFB13B" },

  // Audio
  mp3:  { glyph: "\uF001", color: "#00AFFF" },
  wav:  { glyph: "\uF001", color: "#00AFFF" },
  flac: { glyph: "\uF001", color: "#00AFFF" },
  ogg:  { glyph: "\uF001", color: "#00AFFF" },
  aac:  { glyph: "\uF001", color: "#00AFFF" },

  // Video
  mp4:  { glyph: "\uF008", color: "#FD971F" },
  avi:  { glyph: "\uF008", color: "#FD971F" },
  mkv:  { glyph: "\uF008", color: "#FD971F" },
  mov:  { glyph: "\uF008", color: "#FD971F" },
  wmv:  { glyph: "\uF008", color: "#FD971F" },
  webm: { glyph: "\uF008", color: "#FD971F" },

  // Executables & scripts
  exe:  { glyph: "\uF013", color: "#9F0500" },
  msi:  { glyph: "\uF013", color: "#9F0500" },
  sh:   { glyph: "\uE760", color: "#4D5A5E" },
  zsh:  { glyph: "\uE760", color: "#4D5A5E" },
  fish: { glyph: "\uE760", color: "#4D5A5E" },
  bash: { glyph: "\uE760", color: "#89E051" },
  bat:  { glyph: "\uE70F", color: "#C1F12E" },
  cmd:  { glyph: "\uE70F", color: "#C1F12E" },
  ps1:  { glyph: "\uE795", color: "#4273CA" },
  psm1: { glyph: "\uE795", color: "#4273CA" },

  // Data
  sql:    { glyph: "\uF1C0", color: "#DAD8D8" },
  db:     { glyph: "\uF1C0", color: "#DAD8D8" },
  sqlite: { glyph: "\uF1C0", color: "#DAD8D8" },

  // Config
  conf: { glyph: "\uF013", color: "#6D8086" },
  ini:  { glyph: "\uF013", color: "#6D8086" },
  cfg:  { glyph: "\uF013", color: "#6D8086" },
  toml: { glyph: "\uE73E", color: "#9C4221" },
  env:  { glyph: "\uF023", color: "#FAF743" },

  // Misc
  log:  { glyph: "\uF15C", color: "#DDDDDD" },
  tmp:  { glyph: "\uF15B", color: "#9CA3AF" },

  // Fonts
  ttf:   { glyph: "\uF031", color: "#6D8086" },
  otf:   { glyph: "\uF031", color: "#6D8086" },
  woff:  { glyph: "\uF031", color: "#6D8086" },
  woff2: { glyph: "\uF031", color: "#6D8086" },

  // System
  dll: { glyph: "\uF013", color: "#6D6D6D" },
  sys: { glyph: "\uF013", color: "#6D6D6D" },
  reg: { glyph: "\uF013", color: "#0078D4" },
};

/** Special filename overrides (matched case-insensitively) */
const FILENAME_ICONS: Record<string, NerdIcon> = {
  ".gitignore":     { glyph: "\uE702", color: "#F54D27" },
  ".gitmodules":    { glyph: "\uE702", color: "#F54D27" },
  ".gitattributes": { glyph: "\uE702", color: "#F54D27" },
  ".dockerignore":  { glyph: "\uE7B0", color: "#458EE6" },
  ".env":           { glyph: "\uF023", color: "#FAF743" },
  ".env.local":     { glyph: "\uF023", color: "#FAF743" },
  "makefile":       { glyph: "\uE795", color: "#6D8086" },
  "dockerfile":     { glyph: "\uE7B0", color: "#458EE6" },
  "license":        { glyph: "\uF0A3", color: "#D0BF41" },
  "licence":        { glyph: "\uF0A3", color: "#D0BF41" },
  "readme":         { glyph: "\uE73E", color: "#EDEDED" },
  "readme.md":      { glyph: "\uE73E", color: "#EDEDED" },
  "tsconfig.json":  { glyph: "\uE8CA", color: "#519ABA" },
  "package.json":   { glyph: "\uE71E", color: "#E8274B" },
  "package-lock.json": { glyph: "\uE71E", color: "#E8274B" },
  "cargo.toml":     { glyph: "\uE7A8", color: "#DEA584" },
  "cargo.lock":     { glyph: "\uE7A8", color: "#DEA584" },
  "go.mod":         { glyph: "\uE724", color: "#00ADD8" },
  "go.sum":         { glyph: "\uE724", color: "#00ADD8" },
  "bun.lock":       { glyph: "\uE71E", color: "#FBF0DF" },
  "bun.lockb":      { glyph: "\uE71E", color: "#FBF0DF" },
};

/** Look up a Nerd Font icon for a file entry. */
export function getNerdIcon(name: string, kind: string): NerdIcon {
  if (kind === "directory") return FOLDER_ICON;

  const lowerName = name.toLowerCase();

  // Check special filenames first
  const filenameIcon = FILENAME_ICONS[lowerName];
  if (filenameIcon) return filenameIcon;

  // Then check by extension
  const ext = lowerName.split(".").pop() || "";
  return EXT_ICONS[ext] ?? DEFAULT_FILE_ICON;
}

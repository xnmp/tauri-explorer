/**
 * File type detection and display utilities.
 * Extracted from FileItem.svelte for reusability and maintainability.
 */

import type { FileEntry } from "./file";

/** File type descriptive names - Windows 11 style */
const FILE_TYPE_MAP: Record<string, string> = {
  // Documents
  txt: "Text Document",
  doc: "Microsoft Word Document",
  docx: "Microsoft Word Document",
  pdf: "Adobe Acrobat Document",
  rtf: "Rich Text Format",
  odt: "OpenDocument Text",

  // Spreadsheets
  xls: "Microsoft Excel Worksheet",
  xlsx: "Microsoft Excel Worksheet",
  csv: "CSV File",
  ods: "OpenDocument Spreadsheet",

  // Presentations
  ppt: "Microsoft PowerPoint Presentation",
  pptx: "Microsoft PowerPoint Presentation",
  odp: "OpenDocument Presentation",

  // Images
  jpg: "JPEG Image",
  jpeg: "JPEG Image",
  png: "PNG Image",
  gif: "GIF Image",
  bmp: "BMP Image",
  svg: "SVG Image",
  webp: "WebP Image",
  ico: "Icon",

  // Archives
  zip: "Compressed (zipped) Folder",
  rar: "WinRAR Archive",
  "7z": "7-Zip Archive",
  tar: "TAR Archive",
  gz: "GZ Archive",

  // Code
  js: "JavaScript File",
  ts: "TypeScript File",
  jsx: "React JavaScript File",
  tsx: "React TypeScript File",
  py: "Python File",
  java: "Java File",
  cpp: "C++ Source File",
  c: "C Source File",
  h: "C/C++ Header File",
  cs: "C# Source File",
  go: "Go Source File",
  rs: "Rust Source File",
  php: "PHP File",
  rb: "Ruby File",
  swift: "Swift Source File",
  kt: "Kotlin Source File",

  // Web
  html: "HTML Document",
  htm: "HTML Document",
  css: "Cascading Style Sheet",
  scss: "SCSS File",
  sass: "Sass File",
  less: "LESS File",
  json: "JSON File",
  xml: "XML Document",
  yaml: "YAML File",
  yml: "YAML File",

  // Executables & Scripts
  exe: "Application",
  msi: "Windows Installer Package",
  bat: "Windows Batch File",
  cmd: "Windows Command Script",
  ps1: "PowerShell Script",
  sh: "Shell Script",
  bash: "Bash Script",

  // System
  dll: "Dynamic Link Library",
  sys: "System File",
  ini: "Configuration Settings",
  cfg: "Configuration File",
  conf: "Configuration File",
  reg: "Registration Entries",

  // Media
  mp3: "MP3 Audio File",
  wav: "WAV Audio File",
  flac: "FLAC Audio File",
  ogg: "OGG Audio File",
  mp4: "MP4 Video",
  avi: "AVI Video",
  mkv: "MKV Video",
  mov: "QuickTime Movie",
  wmv: "Windows Media Video",

  // Fonts
  ttf: "TrueType Font",
  otf: "OpenType Font",
  woff: "Web Open Font Format",
  woff2: "Web Open Font Format 2",

  // Data
  db: "Database File",
  sql: "SQL File",
  sqlite: "SQLite Database",

  // Misc
  md: "Markdown Document",
  log: "Log File",
  tmp: "Temporary File",
};

/** File icon colors - Windows 11 style */
const FILE_COLOR_MAP: Record<string, string> = {
  // Documents - Blue
  txt: "#2b579a", doc: "#2b579a", docx: "#2b579a", rtf: "#2b579a", odt: "#2b579a",

  // PDF - Red
  pdf: "#d13438",

  // Spreadsheets - Green
  xls: "#217346", xlsx: "#217346", csv: "#217346", ods: "#217346",

  // Presentations - Orange
  ppt: "#d24726", pptx: "#d24726", odp: "#d24726",

  // Images - Teal/Cyan
  jpg: "#008272", jpeg: "#008272", png: "#008272", gif: "#008272",
  bmp: "#008272", svg: "#008272", webp: "#008272", ico: "#008272",

  // Archives - Purple
  zip: "#744da9", rar: "#744da9", "7z": "#744da9", tar: "#744da9", gz: "#744da9",

  // Code - Various
  js: "#f7df1e", ts: "#3178c6", jsx: "#61dafb", tsx: "#3178c6",
  py: "#3776ab", java: "#ed8b00", cpp: "#659ad2", c: "#a8b9cc",
  h: "#a8b9cc", cs: "#68217a", go: "#00add8", rs: "#dea584",
  php: "#777bb4", rb: "#cc342d", swift: "#f05138", kt: "#7f52ff",

  // Web
  html: "#e44d26", htm: "#e44d26", css: "#264de4", scss: "#cf649a",
  sass: "#cf649a", less: "#1d365d", json: "#f5a623", xml: "#f16529",
  yaml: "#cb171e", yml: "#cb171e",

  // Executables
  exe: "#0078d4", msi: "#0078d4", bat: "#4d4d4d", cmd: "#4d4d4d",
  ps1: "#012456", sh: "#4eaa25", bash: "#4eaa25",

  // System - Gray
  dll: "#6d6d6d", sys: "#6d6d6d", ini: "#6d6d6d", cfg: "#6d6d6d",
  conf: "#6d6d6d", reg: "#0078d4",

  // Media
  mp3: "#f472b6", wav: "#f472b6", flac: "#f472b6", ogg: "#f472b6",
  mp4: "#a855f7", avi: "#a855f7", mkv: "#a855f7", mov: "#a855f7", wmv: "#a855f7",

  // Fonts - Gray
  ttf: "#6d6d6d", otf: "#6d6d6d", woff: "#6d6d6d", woff2: "#6d6d6d",

  // Data - Teal
  db: "#0d9488", sql: "#0d9488", sqlite: "#0d9488",

  // Misc
  md: "#083fa1", log: "#6d6d6d", tmp: "#9ca3af",
};

/** Icon categories for different SVG paths */
export type IconCategory = "document" | "image" | "archive" | "code" | "media" | "executable" | "default";

const ICON_CATEGORY_MAP: Record<string, IconCategory> = {
  // Documents
  txt: "document", doc: "document", docx: "document", pdf: "document",
  rtf: "document", odt: "document", xls: "document", xlsx: "document",
  csv: "document", ods: "document", ppt: "document", pptx: "document",
  odp: "document", md: "document",

  // Images
  jpg: "image", jpeg: "image", png: "image", gif: "image",
  bmp: "image", svg: "image", webp: "image", ico: "image",

  // Archives
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",

  // Code
  js: "code", ts: "code", jsx: "code", tsx: "code", py: "code",
  java: "code", cpp: "code", c: "code", h: "code", cs: "code",
  go: "code", rs: "code", php: "code", rb: "code", swift: "code",
  kt: "code", html: "code", htm: "code", css: "code", scss: "code",
  sass: "code", less: "code", json: "code", xml: "code", yaml: "code",
  yml: "code", sql: "code",

  // Media
  mp3: "media", wav: "media", flac: "media", ogg: "media",
  mp4: "media", avi: "media", mkv: "media", mov: "media", wmv: "media",

  // Executables
  exe: "executable", msi: "executable", bat: "executable", cmd: "executable",
  ps1: "executable", sh: "executable", bash: "executable",
};

/** Extract file extension from filename */
function getExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

/** Get descriptive file type from entry - Windows 11 style */
export function getFileType(entry: FileEntry): string {
  if (entry.kind === "directory") {
    return "File folder";
  }

  const ext = getExtension(entry.name);
  return FILE_TYPE_MAP[ext] || (ext ? `${ext.toUpperCase()} File` : "File");
}

/** Get icon color based on file extension - Windows 11 style colors */
export function getFileIconColor(entry: FileEntry): string {
  if (entry.kind === "directory") {
    return ""; // Handled by folder-specific styling
  }

  const ext = getExtension(entry.name);
  return FILE_COLOR_MAP[ext] || "#6d6d6d"; // Default gray
}

/** Get file icon category for different SVG paths */
export function getFileIconCategory(entry: FileEntry): IconCategory {
  if (entry.kind === "directory") return "default";

  const ext = getExtension(entry.name);
  return ICON_CATEGORY_MAP[ext] || "default";
}

/** Format modified date - Windows 11 style: M/D/YYYY h:mm AM/PM */
export function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

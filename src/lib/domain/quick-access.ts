/**
 * Default Quick Access (system folder) entries for the files sidebar.
 *
 * These rows are navigation targets, so they may only exist once the real home
 * directory is known. The home path arrives from an async backend query
 * (`get_home_directory`), and substituting a placeholder root while that query
 * is in flight renders rows that navigate somewhere that does not exist —
 * `/home/Documents` instead of `/home/user/Documents` — leaving the pane parked
 * on "Path not found" (#702). An unknown home yields rows with no path instead:
 * the section keeps its shape (nothing below it jumps) while the rows are not
 * yet navigable, and they gain their real target on the frame home resolves.
 */
import { joinPath } from "./path";

export interface QuickAccessFolder {
  name: string;
  icon: string;
  /** Absolute target, or null while the home directory is still unknown. */
  path: string | null;
  color: string;
}

/** Name/icon/color of each default row, independent of where home lives. */
const SYSTEM_FOLDERS: readonly Omit<QuickAccessFolder, "path">[] = [
  { name: "Downloads", icon: "download", color: "#0078d4" },
  { name: "Documents", icon: "document", color: "#2b579a" },
  { name: "Pictures", icon: "picture", color: "#008272" },
  { name: "Videos", icon: "video", color: "#a855f7" },
  { name: "Music", icon: "music", color: "#f472b6" },
];

/**
 * Build the default Quick Access rows under `homeDir`.
 *
 * Every row carries a null path while the home directory is unknown (null, or
 * blank from a backend that answered with nothing usable), so no row can point
 * at a fabricated path. Separator style follows `homeDir`, so a Windows home
 * stays all-backslash.
 */
export function buildQuickAccessFolders(homeDir: string | null | undefined): QuickAccessFolder[] {
  const trimmed = typeof homeDir === "string" ? homeDir.trim() : "";
  const base = trimmed === "" ? null : trimmed;
  return SYSTEM_FOLDERS.map((folder) => ({
    ...folder,
    path: base === null ? null : joinPath(base, folder.name),
  }));
}

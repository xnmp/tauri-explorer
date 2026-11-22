/**
 * Which frecency entries the sidebar "Recent" section may list.
 *
 * The Recycle Bin (`trash://`) is deliberately recorded in frecency so Quick
 * Open can jump to it (#1218), but it already has its own sidebar row and is
 * not a folder: listing it under Recent duplicated that row (#1893). Home,
 * filesystem roots, bookmarks and Quick Access folders are likewise shown
 * elsewhere, and paths on an ejected drive must disappear with the drive.
 */
import { directoryKey } from "./path";
import { isTrashPath } from "./virtual-path";

/**
 * True when `path` lives on a removable/mounted root (a non-system Windows
 * drive letter, a WSL/UNC share, or a Linux/macOS mount base) that is not in
 * the currently-mounted set. Fixed locations are never hidden by this rule.
 */
export function ejectedDriveHidesPath(path: string, mounted: ReadonlySet<string>): boolean {
  // Windows drive letter (e.g. "E:\\foo" or "E:/foo").
  const win = path.match(/^([a-zA-Z]):[\\/]/);
  if (win) {
    const root = `${win[1].toLowerCase()}:`;
    // C: is the system drive and always mounted; only guard other letters.
    if (root === "c:") return false;
    return !mounted.has(root);
  }
  // WSL / UNC roots (\\wsl$\Distro\... or \\server\share\...).
  const unc = path.match(/^\\\\[^\\]+\\[^\\]+/);
  if (unc) return !mounted.has(unc[0].toLowerCase());
  // Linux/macOS removable mount bases.
  const mountBase = path.match(/^(\/(?:run\/)?media\/[^/]+\/[^/]+|\/Volumes\/[^/]+)/);
  if (mountBase) return !mounted.has(mountBase[1].toLowerCase());
  return false;
}

/**
 * True when a recorded location belongs in the sidebar Recent list.
 * `shownElsewhere` holds `directoryKey`s of bookmarks and Quick Access rows.
 */
export function isRecentLocationListed(
  path: string,
  homeDir: string | null,
  shownElsewhere: ReadonlySet<string>,
  mounted: ReadonlySet<string>,
): boolean {
  if (isTrashPath(path)) return false;
  if (path === homeDir || path === "/home" || path === "/") return false;
  if (shownElsewhere.has(directoryKey(path))) return false;
  return !ejectedDriveHidesPath(path, mounted);
}

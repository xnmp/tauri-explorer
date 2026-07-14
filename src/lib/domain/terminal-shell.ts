/**
 * Shell-dialect awareness for the embedded terminal (#409, #418).
 *
 * The shell the PTY actually runs is not always the platform default: on
 * Windows, a pane inside `\\wsl.localhost\…` gets a `wsl.exe` shell (#378) —
 * a POSIX shell that speaks Linux paths, while the explorer speaks Windows
 * paths. Everything the frontend writes to the PTY (cd syncs, path
 * insertions) and everything it reads back (OSC 7 cwd reports) must be
 * translated through the shell's dialect, or injected commands corrupt
 * (`cd /d` fed to zsh) and echoed cwds break navigation (`/home/user/x`
 * treated as a Windows path).
 *
 * Pure functions — unit-tested independently of the PTY.
 */

import { toForwardSlashes } from "./path";

export type ShellKind = "posix" | "cmd" | "powershell";

export interface ShellProfile {
  kind: ShellKind;
  /** Set when the shell is `wsl.exe` into this distro: paths written to the
   *  shell must be Linux paths, and reported cwds are Linux paths that map
   *  back to `\\wsl.localhost\<distro>\…`. */
  wslDistro: string | null;
}

/** The profile assumed before the backend reports what it actually spawned. */
export function defaultShellProfile(isWindows: boolean): ShellProfile {
  return { kind: isWindows ? "cmd" : "posix", wslDistro: null };
}

const WSL_UNC = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i;
const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/;

/**
 * Translate an explorer (host) path into what the spawned shell understands.
 * Only WSL shells need translation: `\\wsl.localhost\<distro>\p` → `/p`,
 * `C:\x` → `/mnt/c/x` (the default automount). Anything else passes through.
 */
export function toShellPath(path: string, profile: ShellProfile): string {
  if (!profile.wslDistro) return path;
  const unc = path.match(WSL_UNC);
  if (unc) {
    const tail = unc[2] ? toForwardSlashes(unc[2]) : "/";
    return tail.startsWith("/") ? tail : `/${tail}`;
  }
  const drive = path.match(DRIVE);
  if (drive) {
    const tail = drive[2] ? toForwardSlashes(drive[2]) : "";
    return `/mnt/${drive[1].toLowerCase()}${tail ? `/${tail}` : ""}`;
  }
  return path;
}

/**
 * Translate a cwd the shell reported (OSC 7) back into an explorer path.
 * For WSL shells: `/mnt/c/x` → `C:\x`, `/home/u` → `\\wsl.localhost\<distro>\home\u`.
 */
export function fromShellCwd(cwd: string, profile: ShellProfile): string {
  if (!profile.wslDistro || !cwd.startsWith("/")) return cwd;
  const mnt = cwd.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (mnt) {
    const tail = (mnt[2] ?? "").replace(/\//g, "\\");
    return `${mnt[1].toUpperCase()}:\\${tail}`;
  }
  return `\\\\wsl.localhost\\${profile.wslDistro}${cwd.replace(/\//g, "\\")}`;
}

/**
 * WSL path recognition. Pure functions — no framework or filesystem deps.
 *
 * On Windows, WSL distros are exposed as UNC shares under `\\wsl.localhost\`
 * (modern) or `\\wsl$\` (legacy), e.g. `\\wsl.localhost\Ubuntu-24.04`. We
 * recognise the distro root and a user's home directory so the UI can give them
 * a Tux mascot instead of the generic folder icon.
 */

import { toForwardSlashes } from "./path";

const WSL_SERVERS = new Set(["wsl.localhost", "wsl$"]);

/**
 * Segments of a UNC path after the leading `\\` / `//`, separator-agnostic and
 * trailing-slash tolerant. Returns null for non-UNC paths.
 * `\\wsl.localhost\Ubuntu\home\me` → `["wsl.localhost", "Ubuntu", "home", "me"]`
 */
function uncSegments(path: string): string[] | null {
  const p = toForwardSlashes(path).replace(/\/+$/, "");
  if (!p.startsWith("//")) return null;
  return p.slice(2).split("/").filter(Boolean);
}

/** True for any path inside a WSL distro share (`\\wsl.localhost\Distro\…`). */
export function isWslPath(path: string): boolean {
  const seg = uncSegments(path);
  return !!seg && seg.length >= 1 && WSL_SERVERS.has(seg[0].toLowerCase());
}

/** True for a WSL distro root itself — `\\wsl.localhost\Ubuntu` (no deeper path). */
export function isWslDistroRoot(path: string): boolean {
  const seg = uncSegments(path);
  return !!seg && seg.length === 2 && WSL_SERVERS.has(seg[0].toLowerCase());
}

/** True for a user's home inside a distro — `\\wsl.localhost\Ubuntu\home\<user>`. */
export function isWslHome(path: string): boolean {
  const seg = uncSegments(path);
  return (
    !!seg &&
    seg.length === 4 &&
    WSL_SERVERS.has(seg[0].toLowerCase()) &&
    seg[2].toLowerCase() === "home"
  );
}

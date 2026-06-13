/**
 * Path normalization helpers.
 * Pure functions — no framework or filesystem deps.
 */

const BARE_DRIVE_LETTER = /^([A-Za-z]):$/;

/**
 * Normalize a path string entered by the user (typically in the address bar).
 *
 * - A bare Windows drive letter like `e:` or `E:` becomes `E:/` so that
 *   downstream path logic (up-one-level, joining) sees a proper root. Without
 *   this, typing `e:` leaves the caller with a malformed path where the drive
 *   has no separator and `..` lookups break.
 * - The case of the drive letter is preserved uppercase so paths normalize to
 *   a canonical form.
 * - All other inputs pass through unchanged; callers should continue to do
 *   tilde expansion, whitespace trimming, etc. separately.
 */
export function normalizePathInput(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(BARE_DRIVE_LETTER);
  if (match) {
    return `${match[1].toUpperCase()}:/`;
  }
  return trimmed;
}

/**
 * Returns true if the given path is the root of a Windows drive (e.g. `C:/`
 * or `C:\`). Used to suppress broken "up one level" attempts from a drive root.
 */
export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path);
}

/**
 * Return the parent directory of a path.
 *
 * `"/home/user/file.txt"` → `"/home/user"`
 * `"/file.txt"`            → `"/"`
 * `"file.txt"` (no slash)  → `"/"`
 */
export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.substring(0, idx) : "/";
}

/**
 * Join a directory path and a child name with a single separator.
 *
 * `joinPath("/home/user", "file.txt")` → `"/home/user/file.txt"`
 * `joinPath("/", "file.txt")`          → `"/file.txt"`
 */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * `expandTilde("~", "/home/u")`      → `"/home/u"`
 * `expandTilde("~/docs", "/home/u")` → `"/home/u/docs"`
 * `expandTilde("/etc", "/home/u")`   → `"/etc"` (unchanged)
 * With a null/unknown homeDir the input passes through unchanged.
 */
export function expandTilde(path: string, homeDir: string | null): string {
  if (!homeDir) return path;
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return homeDir + path.slice(1);
  return path;
}

/**
 * Return the last path segment (file or directory name).
 *
 * `"/home/user/file.txt"` → `"file.txt"`
 * `"/home/user/"`         → `"user"` (trailing slash stripped)
 * `"file.txt"`            → `"file.txt"`
 * `"/"`                   → `"/"`
 */
export function basename(path: string): string {
  // Strip a single trailing slash (but not the root `/` itself)
  const cleaned = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = cleaned.lastIndexOf("/");
  return idx < 0 ? cleaned : cleaned.substring(idx + 1) || "/";
}

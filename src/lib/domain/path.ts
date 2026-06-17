/**
 * Path normalization helpers.
 * Pure functions — no framework or filesystem deps.
 *
 * Separator policy: these helpers accept either `/` or `\` on input (Windows
 * backends emit backslash-separated paths) and emit `/`-separated results.
 * Forward slashes round-trip correctly through the Windows APIs the backend
 * uses, so callers can stay separator-agnostic.
 */

const BARE_DRIVE_LETTER = /^([A-Za-z]):$/;
/** A Windows drive prefix capturing the letter and the remainder, e.g. `C:/Users`. */
const DRIVE_PREFIX = /^([A-Za-z]):(.*)$/;
/** A UNC share root like `//server/share` (after backslash normalization). */
const UNC_ROOT = /^\/\/[^/]+\/[^/]+/;

/** Normalize all backslash separators to forward slashes. */
export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Normalize all forward-slash separators to backslashes. */
export function toBackslashes(path: string): string {
  return path.replace(/\//g, "\\");
}

/**
 * Coerce every separator in `path` to a single style. The caller supplies the
 * target separator (typically the platform's native one) so this stays pure and
 * platform-agnostic — a backslash is a legal character in a Unix filename, so
 * the conversion must be opt-in via `sep`, never inferred.
 */
export function toNativeSeparators(path: string, sep: "/" | "\\"): string {
  return sep === "\\" ? toBackslashes(toForwardSlashes(path)) : toForwardSlashes(path);
}

/** Strip a single trailing separator, but never reduce a bare root (`/`) to empty. */
function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

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
 *   tilde expansion, whitespace trimming, etc. separately. In particular,
 *   backslashes are left intact here (a backslash is a legal character in a
 *   Unix filename), so navigation input is taken literally.
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
 * Return the parent directory of a path. Separator-agnostic; emits `/`.
 *
 * `"/home/user/file.txt"`  → `"/home/user"`
 * `"/file.txt"`            → `"/"`
 * `"file.txt"` (no slash)  → `"/"`
 * `"C:\\Users\\foo"`        → `"C:/Users"`
 * `"C:\\Users"`             → `"C:/"`   (top-level dir's parent is the drive root)
 * `"C:/"` / `"C:"`          → `"C:/"`   (a drive root is its own parent)
 * `"\\\\server\\share\\d"`     → `"//server/share"`
 * `"\\\\server\\share"`       → `"//server/share"` (a share root is its own parent)
 */
export function parentDir(path: string): string {
  const p = toForwardSlashes(path);

  // Windows drive paths (`C:` / `C:/` / `C:/Users/...`).
  const drive = p.match(DRIVE_PREFIX);
  if (drive) {
    const letter = drive[1];
    const root = `${letter}:/`;
    const rest = stripTrailingSlash(drive[2]); // "" | "/Users" | "/Users/foo"
    if (rest === "") return root;
    const idx = rest.lastIndexOf("/");
    // A single top-level segment ("/Users") has its parent at the drive root.
    return idx > 0 ? `${letter}:${rest.substring(0, idx)}` : root;
  }

  // UNC share root (`//server/share`) is its own parent.
  const unc = p.match(UNC_ROOT);
  if (unc && stripTrailingSlash(p) === unc[0]) return unc[0];

  // POSIX (and UNC subpaths, which fall through to here correctly).
  const cleaned = stripTrailingSlash(p);
  const idx = cleaned.lastIndexOf("/");
  return idx > 0 ? cleaned.substring(0, idx) : "/";
}

/**
 * Canonical key for a directory path, stable across the separator style (`\` vs
 * `/`), a trailing slash, and — for Windows-style paths (drive letter or UNC) —
 * drive-letter and casing differences (Windows file systems are
 * case-insensitive). Use this anywhere a path is a dedup key, Map/Set member, or
 * object key so the same directory never produces two entries. The result is a
 * comparison key only; it is not meant for display (keep the native-separator
 * path for that).
 */
export function directoryKey(path: string): string {
  const norm = stripTrailingSlash(toForwardSlashes(path));
  const isWindowsPath = /^[A-Za-z]:/.test(norm) || norm.startsWith("//");
  return isWindowsPath ? norm.toLowerCase() : norm;
}

/**
 * True when two paths refer to the same directory. Tolerant of separator style,
 * trailing slash, and Windows drive-letter/casing differences (see
 * `directoryKey`). This is what makes "paste into the same folder produces a
 * copy" work on Windows, where the clipboard source dir and the current dir can
 * differ only by separator or case and a raw `===` would wrongly see them as
 * different (triggering a conflict prompt instead of a silent " - Copy").
 */
export function sameDirectory(a: string, b: string): boolean {
  return directoryKey(a) === directoryKey(b);
}

/**
 * Join a directory path and a child name with a single separator. If `dir`
 * already ends in a separator, that one is reused. Otherwise the separator
 * matches the style `dir` already uses (backslash if it contains one and no
 * forward slash) so a Windows path stays all-backslash instead of going mixed;
 * forward slash is the default.
 *
 * `joinPath("/home/user", "file.txt")`  → `"/home/user/file.txt"`
 * `joinPath("/", "file.txt")`           → `"/file.txt"`
 * `joinPath("C:\\Users", "f.txt")`       → `"C:\\Users\\f.txt"`
 */
export function joinPath(dir: string, name: string): string {
  if (/[\\/]$/.test(dir)) return dir + name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir + sep + name;
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
 * Return the last path segment (file or directory name). Separator-agnostic.
 *
 * `"/home/user/file.txt"`  → `"file.txt"`
 * `"/home/user/"`         → `"user"` (trailing slash stripped)
 * `"C:\\Users\\foo"`        → `"foo"`
 * `"file.txt"`            → `"file.txt"`
 * `"/"`                   → `"/"`
 */
export function basename(path: string): string {
  const p = toForwardSlashes(path);
  // Strip a single trailing slash (but not the root `/` itself)
  const cleaned = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = cleaned.lastIndexOf("/");
  return idx < 0 ? cleaned : cleaned.substring(idx + 1) || "/";
}

/**
 * True if `child` is the same path as, or nested inside, `parent`.
 * Separator-agnostic so it works for both Unix and Windows paths.
 *
 * `isInsideDir("/a/b/c", "/a/b")`           → true
 * `isInsideDir("C:\\a\\b", "C:\\a")`           → true
 * `isInsideDir("/a/bc", "/a/b")`            → false (not a path-segment prefix)
 */
export function isInsideDir(child: string, parent: string): boolean {
  const c = toForwardSlashes(child);
  const p = stripTrailingSlash(toForwardSlashes(parent));
  return c === p || c.startsWith(p + "/");
}

/**
 * Separator-agnostic path equality. Needed because `parentDir`/`basename`
 * emit forward slashes while backend-provided paths (and DOM `data-path`
 * attributes) use the OS separator — on Windows a naive `===` between the two
 * always fails. Compares the forward-slash normal form of both, ignoring a
 * single trailing separator.
 *
 * `samePath("C:/Users/x", "C:\\Users\\x")` → true
 * `samePath("/a/b/", "/a/b")`              → true
 */
export function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(toForwardSlashes(a)) === stripTrailingSlash(toForwardSlashes(b));
}

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

/**
 * Pure domain logic for AI rename suggestions (#145).
 *
 * No framework or IPC deps. Two responsibilities:
 *   - `buildContentHint` decides what *lightweight* signal (if any) may accompany
 *     a filename when asking the model. For text-like files it returns a
 *     truncated head; for everything else, nothing.
 *   - `sanitizeChosenName` guards a chosen suggestion before it is applied via
 *     the normal rename flow (non-empty, no path components, keeps extension).
 *
 * Privacy: this module only *shapes* a hint from text the caller already read.
 * It is invoked exclusively inside the explicit "Suggest rename" action — never
 * on hover/selection — so no file content is ever read speculatively.
 */

import type { FileEntry } from "./file";
import { getExtension, isImageFile, isTextFile } from "./file-types";

/** Max characters of a text file's head sent as a hint. Keep it lightweight. */
export const CONTENT_HINT_MAX_CHARS = 2048;

/**
 * Whether this entry is eligible to have a text-content hint attached. Only
 * text-like, non-image files qualify; the caller reads the head lazily and
 * passes it as `textHead`.
 */
export function canSendContentHint(entry: FileEntry): boolean {
  if (entry.kind !== "file") return false;
  if (isImageFile(entry)) return false;
  return isTextFile(entry);
}

/**
 * Build the content hint to send with the suggestion request. Returns a
 * truncated text head for text-like files (given the already-read `textHead`),
 * otherwise `undefined` — signalling "send only the filename".
 *
 * `textHead` must be supplied by the caller (read only inside the explicit
 * action). Passing `undefined`/empty yields no hint even for a text file.
 */
export function buildContentHint(
  entry: FileEntry,
  textHead?: string,
): string | undefined {
  if (!canSendContentHint(entry)) return undefined;
  if (!textHead) return undefined;
  const trimmed = textHead.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, CONTENT_HINT_MAX_CHARS);
}

/**
 * Sanitize a model-chosen name before applying it. Guarantees:
 *   - trimmed, non-empty (falls back to the original name)
 *   - no path components / traversal (strips to the basename, drops `..`)
 *   - keeps the original extension when the sanitized name lost it
 *
 * Returns a bare filename safe to hand to `renameEntry`.
 */
export function sanitizeChosenName(name: string, originalName: string): string {
  // Reduce to a basename: take the last segment after any slash/backslash.
  const segments = name.split(/[/\\]/);
  let base = (segments[segments.length - 1] ?? "").trim();

  // Drop traversal / hidden-nav names.
  if (base === "" || base === "." || base === "..") {
    return originalName;
  }

  const originalExt = extensionWithDot(originalName);
  if (originalExt && !base.toLowerCase().endsWith(originalExt.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    base = `${stem}${originalExt}`;
  }

  return base;
}

/** Extension including the leading dot (".md"), or "" when there is none. */
function extensionWithDot(name: string): string {
  const ext = getExtension(name);
  return ext ? `.${ext}` : "";
}

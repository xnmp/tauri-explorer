/**
 * Rules for a plugin asking the host to open its image editor directly in one
 * of the plugin's own editor tools.
 */

export interface ImageEditorRequest {
  readonly path: string;
  readonly tool: string;
}

const MAX_PATH = 4096;

/** POSIX absolute, Windows drive-absolute (`C:\` or `C:/`) or UNC. */
function absolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

/**
 * Why a request cannot open the editor, or null when it can. Only tools the
 * calling plugin registered may be opened; the editor itself validates and
 * captures the file.
 */
export function imageEditorRequestError(request: unknown, ownTools: ReadonlySet<string>): string | null {
  if (typeof request !== "object" || request === null) return "Image editor request must be an object";
  const { path, tool } = request as Record<string, unknown>;
  if (typeof tool !== "string" || !ownTools.has(tool)) return "Image editor tool is not registered by this plugin";
  if (typeof path !== "string" || !path || path.length > MAX_PATH || path.includes("\0") || !absolute(path)) {
    return "Image editor path must be an absolute file path";
  }
  return null;
}

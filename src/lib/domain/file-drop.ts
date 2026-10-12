import { isNativeDropPath, nativeDropPaths } from "./native-drop-paths";

/** Admission uses the current gesture's types, never unrelated retained state.
 * Bookmark reorder and plugin-specific/text payloads belong to their DOM owners. */
export function isExplorerFileTransfer(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!data && ["application/x-explorer-path", "application/x-explorer-paths", "application/x-explorer-kind"]
    .some(type => data.types.includes(type));
}

export function isFileTransfer(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return isExplorerFileTransfer(data) || !!data?.types.includes("Files");
}

/** Link-only shortcuts carry their restriction in both DOM transport and
 * source provenance; a receiver must never treat them as mutable files. */
export function isLinkOnlyFileTransfer(data: Pick<DataTransfer, "effectAllowed" | "getData"> | null | undefined,
  source?: { nativeCopyPolicy?: string } | null): boolean {
  return source?.nativeCopyPolicy === "link" || data?.effectAllowed === "link"
    || data?.getData("application/x-explorer-effect") === "link";
}

/** Native observations use process-scoped monotonic milliseconds before IPC delivery.
 * End is exclusive: a later external gesture must not borrow retired identity. */
export function observedDuringGesture(observedAt: number, startedAt: number, endedAt?: number): boolean {
  return Number.isFinite(observedAt) && Number.isFinite(startedAt)
    && observedAt >= startedAt && (endedAt === undefined || (Number.isFinite(endedAt) && observedAt < endedAt));
}

/** Internal payloads are all-or-nothing: a malformed member cannot fall back
 * to a single path or a stale persisted selection. Preserve source order. */
export function validatedDropPaths(value: unknown, windows: boolean): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const path of value) {
    if (typeof path !== "string" || !isNativeDropPath(path, windows)) return null;
  }
  return [...value];
}

export function internalDragPaths(value: unknown, windows: boolean): string[] | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.path !== "string" || typeof data.name !== "string" ||
      (data.kind !== "file" && data.kind !== "directory")) return null;
  const paths = validatedDropPaths(data.paths === undefined ? [data.path] : data.paths, windows);
  return paths?.includes(data.path) ? paths : null;
}

/** Compare the entire multiset, not just the first native path. Native order
 * may differ; only a complete match may recover Explorer selection order. */
export function sameDropPathSet(left: readonly string[], right: readonly string[], windows = false): boolean {
  if (left.length !== right.length) return false;
  const key = (path: string) => windows ? path.replace(/\\/g, "/") : path;
  const counts = new Map<string, number>();
  for (const path of left) counts.set(key(path), (counts.get(key(path)) ?? 0) + 1);
  for (const path of right) {
    const count = counts.get(key(path));
    if (!count) return false;
    counts.set(key(path), count - 1);
  }
  return true;
}

export function domDropPaths(data: Pick<DataTransfer, "getData">, windows: boolean): string[] | null {
  const multi = data.getData("application/x-explorer-paths");
  if (multi) {
    try {
      const paths = validatedDropPaths(JSON.parse(multi), windows);
      const primary = data.getData("application/x-explorer-path");
      return paths && (!primary || (isNativeDropPath(primary, windows) && paths.includes(primary))) ? paths : null;
    }
    catch { return null; }
  }
  return validatedDropPaths([data.getData("application/x-explorer-path")], windows);
}

/** Ownership follows a successful native handoff, including native Enter. */
export function domOwnsFileDrop(nativeOwned: boolean): boolean {
  return !nativeOwned;
}

/** Filesystem export must remain a plain URI list: WebKit sanitizes it as a
 * single URL before native export. Recent carries only a non-filesystem URN. */
export function html5DragUriList(source: { sessionId?: string; path: string; paths?: string[]; nativeCopyPolicy?: string }): string {
  if (!source.sessionId) return "";
  if (source.nativeCopyPolicy === "link") return `urn:tauri-explorer:drag:${source.sessionId}`;
  return (source.paths ?? [source.path]).map(path => {
    const normalized = path.startsWith("/") ? path : path.replace(/\\/g, "/");
    const prefix = normalized.startsWith("//") ? "file:" : normalized.startsWith("/") ? "file://" : "file:///";
    return prefix + encodeURI(normalized).replace(/[?#]/g, encodeURIComponent);
  }).join("\r\n");
}

/** HTML text survives WebKit's stripped custom types without becoming a URL
 * in the OS pasteboard. No filesystem path or link is embedded here. */
export function html5DragHtml(source: { sessionId?: string }): string {
  return source.sessionId ? `<span>urn:tauri-explorer:drag:${source.sessionId}</span>` : "";
}

export function html5TransferMatchesGesture(data: Pick<DataTransfer, "getData">, source: Parameters<typeof html5DragUriList>[0]): boolean {
  // Only Recent's URI proves identity. Ordinary file URIs never do, even if
  // the same paths are still retained after a missed dragend.
  return !!source.sessionId && (data.getData("text/html").trim() === html5DragHtml(source)
    || (source.nativeCopyPolicy === "link" && data.getData("text/uri-list") === html5DragUriList(source)));
}

/** GTK/Wry preserves Recent's sole URI as a native path string. A mixed or
 * malformed payload cannot substitute the session's filesystem selection. */
export function nativeDragSession(rawPaths: readonly string[]): string | null {
  return rawPaths.length === 1 ? /^urn:tauri-explorer:drag:([^\s\0]+)$/.exec(rawPaths[0])?.[1] ?? null : null;
}

export function resolveNativeDragPaths(rawPaths: readonly string[], source: unknown, windows: boolean): string[] {
  const session = nativeDragSession(rawPaths);
  if (!windows && session && source && typeof source === "object") {
    const data = source as Record<string, unknown>;
    if (data.sessionId === session && data.nativeCopyPolicy === "link") return internalDragPaths(source, windows) ?? [];
  }
  return nativeDropPaths(rawPaths, windows);
}

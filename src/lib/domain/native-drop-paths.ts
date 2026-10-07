import { splitFlattenedUriList } from "./path";

/** Native drops are filesystem paths, never webview blob or network URLs. */
export function isNativeDropPath(path: string, windows: boolean): boolean {
  if (!path || path.includes("\0")) return false;
  const normalized = windows ? path.replace(/\\/g, "/") : path;
  if (normalized.split("/").includes("..")) return false;
  if (!windows) return normalized.startsWith("/") && normalized.replace(/\//g, "").length > 0;
  return /^[A-Za-z]:\/[^/]/.test(normalized)
    || /^\/\/[^/?\.][^/]*\/[^/]+\/[^/]/.test(normalized)
    || /^\/\/\?\/(?:[A-Za-z]:\/[^/]|UNC\/[^/]+\/[^/]+\/[^/])/i.test(normalized);
}

export function nativeDropPaths(rawPaths: readonly string[], windows: boolean): string[] {
  return rawPaths.flatMap(splitFlattenedUriList).filter(path => isNativeDropPath(path, windows));
}

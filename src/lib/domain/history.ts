/** Persisted optional history is validated before entering application state. */
export interface HistoryRecentEntry { name: string; path: string; kind: "file" | "directory"; timestamp: number; revision?: number }
export interface HistoryFrecencyEntry { path: string; accesses: number[]; dismissedFromRecent?: boolean; revision?: number }
export interface HistorySnapshot { recent: HistoryRecentEntry[]; frecency: HistoryFrecencyEntry[] }
export type HistoryCollection = "recent" | "frecency";
export type HistoryMutation =
  | { type: "recent"; key: string; entry: HistoryRecentEntry }
  | { type: "access"; key: string; path: string; timestamp: number }
  | { type: "remove"; collection: HistoryCollection; keys: string[] }
  | { type: "prune"; collection: HistoryCollection; entries: { key: string; revision: number }[] }
  | { type: "clear"; collection: HistoryCollection }
  | { type: "downvote"; key: string; dismiss: boolean };
const validPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !value.includes("\0");
const revision = (entry: { revision?: unknown }) => typeof entry.revision === "number" && Number.isSafeInteger(entry.revision) && entry.revision > 0 ? { revision: entry.revision } : {};
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function sanitizeRecentHistory(value: unknown): HistoryRecentEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(entry => entry && validPath(entry.path) && typeof entry.name === "string" && entry.name.length <= 4096 && (entry.kind === "file" || entry.kind === "directory") && validTime(entry.timestamp)).slice(0, 50)
    .map(entry => ({ name: entry.name, path: entry.path, kind: entry.kind, timestamp: entry.timestamp, ...revision(entry) }));
}
export function sanitizeFrecencyHistory(value: unknown): HistoryFrecencyEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(entry => entry && validPath(entry.path) && Array.isArray(entry.accesses)).slice(0, 200)
    .map(entry => ({ path: entry.path, accesses: entry.accesses.filter(validTime).slice(-10), ...(entry.dismissedFromRecent === true ? { dismissedFromRecent: true } : {}), ...revision(entry) }));
}

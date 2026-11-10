/**
 * AI filter (#1506): natural-language filtering of the current folder.
 *
 * Pure contract between the filter box and the host text service: a bounded,
 * compact listing prompt, validation of the model's reply against the exact
 * names that were sent, and the request state machine whose request ID is the
 * staleness token. No framework, IPC or clock access lives here.
 */
import type { FileEntry } from "./file";

/** Most entries a single request describes. */
export const AI_FILTER_MAX_ENTRIES = 2000;
/**
 * UTF-8 bytes for instructions plus input. The native text service rejects
 * anything over 64 KiB combined; the margin absorbs the truncation note.
 */
export const AI_FILTER_MAX_BYTES = 60 * 1024;
const AI_FILTER_MAX_QUERY = 500;
export const AI_FILTER_MAX_OUTPUT_TOKENS = 4096;

const AI_FILTER_INSTRUCTIONS = [
  "You filter a file manager's folder listing for a user.",
  "Each listing line is: kind (d = folder, f = file), name, extension, size in bytes (- for folders), modified local time.",
  "Select every entry that satisfies the user's request, interpreting relative dates against the stated current time.",
  "Reply with JSON only, no prose or code fences: {\"names\":[\"exact name\", ...]}.",
  "Copy names exactly as listed. Reply {\"names\":[]} when nothing matches.",
].join("\n");

export interface AiFilterPrompt {
  instructions: string;
  input: string;
  /** Exact names the model saw; replies are validated against these. */
  sent: string[];
  /** Entries in the folder (before truncation). */
  total: number;
  truncated: boolean;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM` in local time; empty for an unparsable date. */
function localTimestamp(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function extension(entry: FileEntry): string {
  if (entry.kind === "directory") return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

/** Tabs and newlines in names would break the line format; spaces stand in. */
const cell = (text: string) => text.replace(/[\t\r\n]/g, " ");

export function entryLine(entry: FileEntry): string {
  const kind = entry.kind === "directory" ? "d" : "f";
  const size = entry.kind === "directory" ? "-" : String(entry.size);
  return [kind, cell(entry.name), extension(entry), size, localTimestamp(entry.modified)].join("\t");
}

export function normalizeAiFilterQuery(query: string): string {
  return [...query.replace(/\p{Cc}+/gu, " ").trim()].slice(0, AI_FILTER_MAX_QUERY).join("");
}

/**
 * Build the request for `query` over `entries` (in display order). Entries are
 * included until the entry cap or byte budget is reached, and the model is told
 * when the listing was truncated.
 */
export function buildAiFilterPrompt(query: string, directory: string, entries: readonly FileEntry[], now: Date): AiFilterPrompt {
  const request = normalizeAiFilterQuery(query);
  const total = entries.length;
  const header = [
    `Request: ${request}`,
    `Current time: ${localTimestamp(now)} (${utcOffset(now)}, ${now.toLocaleDateString("en-US", { weekday: "long" })})`,
    `Folder: ${cell(directory)}`,
  ];
  // Reserve room for the listing header and a worst-case truncation note.
  const reserve = bytes(AI_FILTER_INSTRUCTIONS) + bytes(header.join("\n")) + 160;
  let used = reserve;
  const lines: string[] = [];
  const sent: string[] = [];
  for (const entry of entries) {
    if (sent.length >= AI_FILTER_MAX_ENTRIES) break;
    const line = entryLine(entry);
    const size = bytes(line) + 1;
    if (used + size > AI_FILTER_MAX_BYTES) break;
    used += size;
    lines.push(line);
    sent.push(entry.name);
  }
  const truncated = sent.length < total;
  const summary = truncated
    ? `Entries (listing truncated: ${sent.length} of ${total} shown; consider only these):`
    : `Entries (${total}):`;
  return {
    instructions: AI_FILTER_INSTRUCTIONS,
    input: [...header, summary, ...lines].join("\n"),
    sent,
    total,
    truncated,
  };
}

export type AiFilterParse =
  | { ok: true; names: string[]; ignored: number }
  | { ok: false; message: string };

/** The first balanced JSON object or array in `text`, if any. */
function jsonCandidate(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(body); } catch { /* fall through to scanning */ }
  // Prose around the JSON: try the outermost object, then the outermost array.
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = body.indexOf(open), end = body.lastIndexOf(close);
    if (start === -1 || end <= start) continue;
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* next shape */ }
  }
  return undefined;
}

/**
 * Validate a model reply against the names that were sent. Exact names win;
 * a unique case-insensitive match is accepted; anything else is ignored and
 * counted. Duplicates collapse. A reply without a names list is an error.
 */
export function parseAiFilterResponse(text: string, sent: readonly string[]): AiFilterParse {
  const value = jsonCandidate(text);
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { names?: unknown }).names)
      ? (value as { names: unknown[] }).names
      : null;
  if (!list) return { ok: false, message: "The language model did not return a list of matching items." };
  const exact = new Set(sent);
  const folded = new Map<string, string | null>();
  for (const name of sent) {
    const key = name.toLowerCase();
    folded.set(key, folded.has(key) ? null : name);
  }
  const names = new Set<string>();
  let ignored = 0;
  for (const item of list) {
    const name = typeof item === "string" ? item : null;
    const match = name === null ? null : exact.has(name) ? name : folded.get(name.toLowerCase()) ?? null;
    if (match === null) ignored++;
    else names.add(match);
  }
  return { ok: true, names: [...names], ignored };
}

// ---- State machine ---------------------------------------------------------

export interface AiFilterTarget {
  requestId: string;
  query: string;
  /** Directory the request describes; a result for another one is stale. */
  path: string;
}

export type AiFilterState =
  | { kind: "idle" }
  | ({ kind: "loading" } & AiFilterTarget)
  | ({ kind: "applied"; names: ReadonlySet<string>; sent: number; total: number; truncated: boolean; ignored: number } & AiFilterTarget)
  | ({ kind: "error"; message: string } & AiFilterTarget);

export type AiFilterOutcome =
  | { ok: true; names: readonly string[]; sent: number; total: number; truncated: boolean; ignored: number }
  | { ok: false; message: string };

export const AI_FILTER_IDLE: AiFilterState = { kind: "idle" };

export function beginAiFilter(target: AiFilterTarget): AiFilterState {
  return { kind: "loading", ...target };
}

/**
 * Settle the request identified by `requestId` that was issued for `path`.
 * Returns `state` unchanged (identity) when the result is stale: another
 * request superseded it, it was cleared or cancelled, or the pane moved on.
 */
export function settleAiFilter(state: AiFilterState, requestId: string, currentPath: string, outcome: AiFilterOutcome): AiFilterState {
  if (state.kind !== "loading" || state.requestId !== requestId || state.path !== currentPath) return state;
  const target = { requestId, query: state.query, path: state.path };
  if (!outcome.ok) return { kind: "error", message: outcome.message, ...target };
  return { kind: "applied", names: new Set(outcome.names), sent: outcome.sent, total: outcome.total, truncated: outcome.truncated, ignored: outcome.ignored, ...target };
}

type AiFilterKeyEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing"> & {
  getModifierState?(key: string): boolean;
};

/**
 * Alt+Enter in the filter box. A right Alt that the keyboard layout maps to
 * AltGraph (ISO_Level3_Shift on Linux, Ctrl+Alt on Windows) counts as Alt:
 * otherwise the chord arrives as a plain Enter that nothing handles (#1522).
 */
export function isAiFilterKey(event: AiFilterKeyEvent): boolean {
  if (event.key !== "Enter" || event.isComposing || event.metaKey || event.shiftKey) return false;
  if (event.getModifierState?.("AltGraph")) return true;
  return event.altKey && !event.ctrlKey;
}

/** Whether the AI state replaces the box's substring filter. */
export function aiFilterOwnsListing(state: AiFilterState): boolean {
  return state.kind === "loading" || state.kind === "applied";
}

/** One-line status for the filter box. */
export function aiFilterStatus(state: AiFilterState): string | null {
  switch (state.kind) {
    case "idle": return null;
    case "loading": return "AI filtering… Esc to cancel";
    case "error": return state.message;
    case "applied": {
      const count = state.names.size;
      const matched = count === 0 ? "No items match" : `${count} ${count === 1 ? "item matches" : "items match"}`;
      const scope = state.truncated ? ` (AI saw the first ${state.sent} of ${state.total})` : "";
      return `${matched}${scope} · Esc to clear`;
    }
  }
}

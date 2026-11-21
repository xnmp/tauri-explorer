/**
 * One AI column's `load` for the Details-column seam (#1884): persisted
 * values first, then a single model request for the misses of a batch.
 * Errors leave cells empty and go to `report` (deduplicated by the caller,
 * see `createOnceReporter`). Dependencies are injected for unit tests.
 */
import type { FileEntry } from "$lib/domain/file";
import type { DetailRowValues } from "$lib/domain/plugin-detail-columns";
import type { WindowTextRequest } from "$lib/api/ai-text";
import { extractError } from "$lib/api/common";
import { isTrashPath, isVirtualPath } from "$lib/domain/virtual-path";
import {
  AI_COLUMN_BATCH, AI_COLUMN_MAX_OUTPUT_TOKENS, buildColumnPrompt, parseColumnReply, valueKey,
  type AiColumnDefinition, type AiColumnFile,
} from "$lib/domain/ai-column";

/** The single column key inside each AI column's provider. */
export const AI_COLUMN_VALUE_KEY = "value";

export interface AiColumnLoaderDeps {
  generateText(request: WindowTextRequest): Promise<{ text: string }>;
  cancelText(requestId: string): Promise<unknown>;
  /** The head of a text-like file, or undefined (never binary content). */
  readExcerpt(entry: FileEntry): Promise<string | undefined>;
  lookup(key: string): string | undefined;
  store(pairs: readonly (readonly [string, string])[]): void;
  report(message: string): void;
  nextRequestId(): string;
}

/** Real files and folders only: not plugin-virtual or Trash entries. */
export const aiColumnApplies = (entry: FileEntry): boolean =>
  (entry.kind === "file" || entry.kind === "directory") && !isVirtualPath(entry.path) && !isTrashPath(entry.path);

function extensionOf(entry: FileEntry): string {
  if (entry.kind === "directory") return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

async function describeFile(entry: FileEntry, readExcerpt: AiColumnLoaderDeps["readExcerpt"]): Promise<AiColumnFile> {
  const excerpt = await readExcerpt(entry).catch(() => undefined);
  return {
    name: entry.name,
    kind: entry.kind === "directory" ? "directory" : "file",
    extension: extensionOf(entry),
    size: entry.size,
    modified: entry.modified,
    ...(excerpt ? { excerpt } : {}),
  };
}

const row = (value: string | null | undefined): DetailRowValues | null =>
  value ? { columns: { [AI_COLUMN_VALUE_KEY]: value } } : null;

export function createColumnLoader(column: AiColumnDefinition, deps: AiColumnLoaderDeps) {
  /** One request for at most `AI_COLUMN_BATCH` entries; null on any failure. */
  async function ask(entries: readonly FileEntry[], signal: AbortSignal): Promise<(string | null)[] | null> {
    const files = await Promise.all(entries.map((entry) => describeFile(entry, deps.readExcerpt)));
    if (signal.aborted) return null;
    const prompt = buildColumnPrompt(column.description, files);
    const requestId = deps.nextRequestId();
    const cancel = () => { void deps.cancelText(requestId).catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let text: string;
    try {
      ({ text } = await deps.generateText({ requestId, ...prompt, maxOutputTokens: AI_COLUMN_MAX_OUTPUT_TOKENS }));
    } catch (error) {
      if (!signal.aborted) deps.report(`AI column "${column.label}": ${extractError(error)}`);
      return null;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (signal.aborted) return null;
    const answers = parseColumnReply(text, entries.length);
    if (answers.every((answer) => answer === null)) {
      deps.report(`AI column "${column.label}": the language model's reply could not be read`);
    }
    return answers;
  }

  return async function load(entries: readonly FileEntry[], signal: AbortSignal): Promise<(DetailRowValues | null)[]> {
    const keys = entries.map(valueKey);
    const values = keys.map((key) => deps.lookup(key));
    const misses = entries.flatMap((entry, index) => values[index] === undefined ? [{ entry, index }] : []);
    // The seam batches 16 per call; larger calls are split, never truncated.
    for (let start = 0; start < misses.length && !signal.aborted; start += AI_COLUMN_BATCH) {
      const chunk = misses.slice(start, start + AI_COLUMN_BATCH);
      const answers = await ask(chunk.map(({ entry }) => entry), signal);
      if (!answers) break;
      deps.store(chunk.flatMap(({ index }, i) => answers[i] === null ? [] : [[keys[index], answers[i]!] as const]));
      chunk.forEach(({ index }, i) => { values[index] = answers[i] ?? undefined; });
    }
    return values.map(row);
  };
}

/** Each key's first message only: errors are reported once per column, not per row. */
export function createOnceReporter(sink: (message: string) => void) {
  const reported = new Set<string>();
  return (key: string, message: string) => {
    if (reported.has(key)) return;
    reported.add(key);
    sink(message);
  };
}

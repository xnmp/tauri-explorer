/**
 * One AI column's `load` for the Details-column seam (#1886): persisted values
 * first; the misses of a folder share ONE folder-agent job (`ctx.agent`) that
 * answers every file of that folder still unanswered, as JSON keyed by name.
 * A folder runs automatically at most once per session; new or changed files
 * wait for `forget` (the plugin's refresh command). Errors leave cells empty
 * and go to `report` (deduplicated by the caller, see `createOnceReporter`).
 * Dependencies are injected for unit tests.
 */
import type { FileEntry } from "$lib/domain/file";
import type { DetailRowValues } from "$lib/domain/plugin-detail-columns";
import type { AgentRequest } from "$lib/domain/ai-agent";
import { extractError } from "$lib/api/common";
import { directoryKey, parentDir } from "$lib/domain/path";
import { isTrashPath, isVirtualPath } from "$lib/domain/virtual-path";
import { buildFolderPrompt, parseFolderReply, valueKey, type AiColumnDefinition } from "$lib/domain/ai-column";

/** The single column key inside each AI column's provider. */
export const AI_COLUMN_VALUE_KEY = "value";
/** Whole-job deadline: a folder job reads files, so it gets longer than a text request. */
export const AI_COLUMN_JOB_TIMEOUT_MS = 180_000;

export interface AiColumnLoaderDeps {
  runAgent(request: AgentRequest, signal: AbortSignal): Promise<{ text: string }>;
  /** The folder's entries (files and subfolders); rejects or returns null when unreadable. */
  listFolder(folder: string): Promise<readonly FileEntry[] | null>;
  lookup(key: string): string | undefined;
  store(pairs: readonly (readonly [string, string])[]): void;
  report(message: string): void;
}

/** Real files and folders only: not plugin-virtual or Trash entries. */
export const aiColumnApplies = (entry: FileEntry): boolean =>
  (entry.kind === "file" || entry.kind === "directory") && !isVirtualPath(entry.path) && !isTrashPath(entry.path);

const row = (value: string | undefined): DetailRowValues | null =>
  value ? { columns: { [AI_COLUMN_VALUE_KEY]: value } } : null;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;

/** Resolves when `promise` settles or `signal` aborts, whichever is first. */
function until(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { signal.removeEventListener("abort", done); resolve(); };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, done);
  });
}

export function createColumnLoader(column: AiColumnDefinition, deps: AiColumnLoaderDeps) {
  interface Job { promise: Promise<void>; controller: AbortController }
  /** In-flight jobs by directory key. */
  const jobs = new Map<string, Job>();
  /** Folders whose job finished (answered or failed) this session. */
  const settled = new Set<string>();
  let disposed = false;

  async function runJob(folder: string, misses: readonly FileEntry[], signal: AbortSignal): Promise<boolean> {
    const listed = await deps.listFolder(folder).catch(() => null);
    if (signal.aborted) return false;
    // Ask about every unanswered entry of the folder, not only the rendered
    // rows: one job fills the whole column.
    const entries = (listed ?? misses).filter((entry) => aiColumnApplies(entry) && deps.lookup(valueKey(entry)) === undefined);
    const byName = new Map<string, FileEntry[]>();
    for (const entry of [...entries, ...misses]) {
      const list = byName.get(entry.name) ?? [];
      if (!list.some((other) => valueKey(other) === valueKey(entry))) list.push(entry);
      byName.set(entry.name, list);
    }
    const prompt = buildFolderPrompt(column.description, [...byName.keys()]);
    if (prompt.names.length === 0) return true;
    let text: string;
    try {
      ({ text } = await deps.runAgent({
        folder,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        timeoutMs: AI_COLUMN_JOB_TIMEOUT_MS,
      }, signal));
    } catch (error) {
      if (signal.aborted) return false;
      // A folder that is not a pane's (a Folder Peek child) is not ours to ask about.
      if (errorCode(error) !== "folder_not_open") deps.report(`AI column "${column.label}": ${extractError(error)}`);
      return true;
    }
    if (signal.aborted) return false;
    const answers = parseFolderReply(text, prompt.names);
    if (answers.size === 0) deps.report(`AI column "${column.label}": the agent's reply could not be read`);
    deps.store([...answers].flatMap(([name, value]) => (byName.get(name) ?? []).map((entry) => [valueKey(entry), value] as const)));
    return true;
  }

  function ensureJob(folder: string, misses: readonly FileEntry[]): Promise<void> {
    const key = directoryKey(folder);
    const running = jobs.get(key);
    if (running) return running.promise;
    const controller = new AbortController();
    const job: Job = {
      controller,
      promise: runJob(folder, misses, controller.signal)
        .catch((error) => { deps.report(`AI column "${column.label}": ${extractError(error)}`); return true; })
        .then((finished) => {
          if (jobs.get(key) === job) jobs.delete(key);
          if (finished && !controller.signal.aborted) settled.add(key);
        }),
    };
    jobs.set(key, job);
    return job.promise;
  }

  function forget(folder?: string): void {
    const only = folder === undefined ? null : directoryKey(folder);
    for (const [key, job] of jobs) if (only === null || key === only) { job.controller.abort(); jobs.delete(key); }
    if (only === null) settled.clear();
    else settled.delete(only);
  }

  return {
    async load(entries: readonly FileEntry[], signal: AbortSignal): Promise<(DetailRowValues | null)[]> {
      const lookup = () => entries.map((entry) => deps.lookup(valueKey(entry)));
      const values = lookup();
      if (disposed) return values.map(row);
      const folders = new Map<string, { folder: string; misses: FileEntry[] }>();
      entries.forEach((entry, index) => {
        if (values[index] !== undefined) return;
        const folder = parentDir(entry.path);
        const key = directoryKey(folder);
        if (settled.has(key)) return;
        const group = folders.get(key) ?? { folder, misses: [] };
        group.misses.push(entry);
        folders.set(key, group);
      });
      if (folders.size === 0) return values.map(row);
      await until(Promise.all([...folders.values()].map(({ folder, misses }) => ensureJob(folder, misses))), signal);
      return lookup().map(row);
    },
    /** Rerun on demand: cancel the folder's job and let the next load ask again
     *  (all folders when `folder` is omitted). */
    forget,
    /** Cancel every job (removal, deactivation); later loads serve the cache only. */
    dispose(): void {
      disposed = true;
      forget();
    },
    /** Folders with a job running (tests and diagnostics). */
    get running(): number { return jobs.size; },
  };
}

export type AiColumnLoader = ReturnType<typeof createColumnLoader>;

/** Each key's first message only: errors are reported once per column, not per row. */
export function createOnceReporter(sink: (message: string) => void) {
  const reported = new Set<string>();
  const once = (key: string, message: string) => {
    if (reported.has(key)) return;
    reported.add(key);
    sink(message);
  };
  /** Report this key's next error again (after a refresh). */
  once.reset = (key?: string) => { if (key === undefined) reported.clear(); else reported.delete(key); };
  return once;
}

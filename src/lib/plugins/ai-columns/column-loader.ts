/**
 * One AI column's `load` for the Details-column seam (#1886): persisted values
 * first; the misses of a folder share ONE folder-agent job (`ctx.agent`) that
 * answers every file of that folder still unanswered, as JSON keyed by name,
 * rendered rows first. Each path is asked automatically at most once per
 * session: rows no job asked about (new or hidden files, names past a job's
 * cap) get a follow-up job, one at a time per folder; rewritten files wait
 * for `forget` (the plugin's refresh command). Errors leave cells empty
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
  interface FolderState {
    folder: string;
    /** At most one job per folder at a time. */
    job: Job | null;
    /** Rows waiting for a job, by path: the next job asks about them first. */
    waiting: Map<string, FileEntry>;
    /** Paths some finished job asked about this session (answered or not). A
     *  rewritten file keeps its path, so it waits for a refresh (`forget`);
     *  a path no job has asked about yet (a new file, a hidden file, a name
     *  past a job's cap) gets a follow-up job. */
    asked: Set<string>;
  }
  const folders = new Map<string, FolderState>();
  let disposed = false;

  const stateFor = (folder: string): FolderState => {
    const key = directoryKey(folder);
    let state = folders.get(key);
    if (!state) folders.set(key, state = { folder, job: null, waiting: new Map(), asked: new Set() });
    return state;
  };

  /** One job: the waiting rows first, then the folder's other unasked,
   *  uncached entries, so one job fills the whole column. */
  async function runJob(state: FolderState, priority: readonly FileEntry[], signal: AbortSignal): Promise<void> {
    const listed = await deps.listFolder(state.folder).catch(() => null);
    if (signal.aborted) return;
    const others = (listed ?? []).filter((entry) => aiColumnApplies(entry) && !state.asked.has(entry.path) && deps.lookup(valueKey(entry)) === undefined);
    const byName = new Map<string, FileEntry[]>();
    for (const entry of [...priority, ...others]) {
      const list = byName.get(entry.name) ?? [];
      if (!list.some((other) => valueKey(other) === valueKey(entry))) list.push(entry);
      byName.set(entry.name, list);
    }
    const prompt = buildFolderPrompt(column.description, [...byName.keys()]);
    // Only unaskable names (empty or overlong): count them as asked so the
    // follow-up loop always makes progress.
    if (prompt.names.length === 0) { for (const entry of priority) state.asked.add(entry.path); return; }
    const markAsked = () => { for (const name of prompt.names) for (const entry of byName.get(name) ?? []) state.asked.add(entry.path); };
    let text: string;
    try {
      ({ text } = await deps.runAgent({
        folder: state.folder,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        timeoutMs: AI_COLUMN_JOB_TIMEOUT_MS,
      }, signal));
    } catch (error) {
      if (signal.aborted) return;
      // Failed names count as asked: no retry loop until a refresh.
      markAsked();
      // A folder that is not a pane's (a Folder Peek child) is not ours to ask about.
      if (errorCode(error) !== "folder_not_open") deps.report(`AI column "${column.label}": ${extractError(error)}`);
      return;
    }
    if (signal.aborted) return;
    markAsked();
    const answers = parseFolderReply(text, prompt.names);
    if (answers.size === 0) deps.report(`AI column "${column.label}": the agent's reply could not be read`);
    deps.store([...answers].flatMap(([name, value]) => (byName.get(name) ?? []).map((entry) => [valueKey(entry), value] as const)));
  }

  /** Start a job for the waiting rows unless one is running. */
  function startJob(state: FolderState): Job | null {
    if (state.job) return state.job;
    const priority = [...state.waiting.values()].filter((entry) => !state.asked.has(entry.path));
    state.waiting.clear();
    if (priority.length === 0) return null;
    const controller = new AbortController();
    const job: Job = {
      controller,
      promise: runJob(state, priority, controller.signal)
        .catch((error) => { deps.report(`AI column "${column.label}": ${extractError(error)}`); })
        .finally(() => { if (state.job === job) state.job = null; }),
    };
    state.job = job;
    return job;
  }

  /** Wait until every row of `misses` was asked by some job (follow-up jobs
   *  run one at a time), the caller gives up, or the jobs are cancelled. */
  async function ensureAsked(state: FolderState, misses: readonly FileEntry[], signal: AbortSignal): Promise<void> {
    for (;;) {
      const pending = misses.filter((entry) => !state.asked.has(entry.path) && deps.lookup(valueKey(entry)) === undefined);
      if (pending.length === 0 || signal.aborted || disposed) return;
      for (const entry of pending) state.waiting.set(entry.path, entry);
      const job = state.job ?? startJob(state);
      if (!job) return;
      await until(job.promise, signal);
      // Cancelled by a refresh or disposal: this load is over.
      if (job.controller.signal.aborted) return;
    }
  }

  function forget(folder?: string): void {
    const only = folder === undefined ? null : directoryKey(folder);
    for (const [key, state] of folders) {
      if (only !== null && key !== only) continue;
      state.job?.controller.abort();
      folders.delete(key);
    }
  }

  return {
    async load(entries: readonly FileEntry[], signal: AbortSignal): Promise<(DetailRowValues | null)[]> {
      const lookup = () => entries.map((entry) => deps.lookup(valueKey(entry)));
      const values = lookup();
      if (disposed) return values.map(row);
      const groups = new Map<FolderState, FileEntry[]>();
      entries.forEach((entry, index) => {
        if (values[index] !== undefined) return;
        const state = stateFor(parentDir(entry.path));
        if (state.asked.has(entry.path)) return;
        groups.set(state, [...(groups.get(state) ?? []), entry]);
      });
      if (groups.size === 0) return values.map(row);
      await Promise.all([...groups].map(([state, misses]) => ensureAsked(state, misses, signal)));
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
    get running(): number { return [...folders.values()].filter((state) => state.job).length; },
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

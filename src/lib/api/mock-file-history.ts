/** Browser fixture for the native file-history IPC. No native window loads it.
 * Rust policy/executor tests and binary E2E verify the authoritative behavior. */
import type { HistoryDirection, HistoryReply, HistorySummary, UndoAction } from "$lib/domain/file-history";
import { executeUndo, executeRedo, type UndoApiDeps } from "./mock-file-history-execution";
import type { FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import { parentDir } from "$lib/domain/path";

type Entry = { id: number; action: UndoAction };
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

function recoverable(action: UndoAction): UndoAction | null {
  if (action.type === "copy" && action.restoreSupported === false) return null;
  if (action.type === "batch") {
    const actions = action.actions.map(recoverable).filter((entry): entry is UndoAction => entry !== null);
    return actions.length ? { ...action, actions } : null;
  }
  return action;
}
function prepare(action: UndoAction): UndoAction {
  if (action.type === "copy") return { ...action, restoreSupported: !/^[/\\]{2}/.test(action.copiedPath) };
  if (action.type === "batch") return { ...action, actions: action.actions.map(prepare) };
  return action;
}

function affectedDirectories(action: UndoAction): string[] {
  switch (action.type) {
    case "rename": return [parentDir(action.path)];
    case "move": return [parentDir(action.sourcePath), parentDir(action.destPath)];
    case "copy": return [parentDir(action.copiedPath)];
    case "delete": return action.paths.map(parentDir);
    case "batch": return action.actions.flatMap(affectedDirectories);
  }
}

export function createMockFileHistory(invoke: Invoke, publishEffects: (directories: string[]) => void) {
  let undo: Entry[] = [];
  let redo: Entry[] = [];
  let nextId = 0;
  let revision = 0;
  let generation = 0;
  let branch = 0;
  let busy = false;
  let receive: ((summary: HistorySummary) => void) | undefined;
  const entry = (action: UndoAction): Entry => ({ id: ++nextId, action });
  const summary = (): HistorySummary => ({ revision, undoId: undo.at(-1)?.id ?? null, redoId: redo.at(-1)?.id ?? null, stackSize: undo.length, busy });
  const publish = () => { receive?.(summary()); };
  const reply = (action?: UndoAction, error?: string): HistoryReply => ({ summary: summary(), ...(action ? { action } : {}), ...(error ? { error } : {}) });
  const call = async (command: string, args: Record<string, unknown>) => {
    try { await invoke(command, args); return { ok: true as const }; }
    catch (error) { return { ok: false as const, error: String(error) }; }
  };
  const batch = async (command: string, paths: string[]) => {
    try { return { ok: true as const, data: await invoke(command, { paths }) as FileBatchOutcome }; }
    catch (error) { return { ok: false as const, error: String(error) }; }
  };
  const files: UndoApiDeps = {
    renameEntry: (path, newName) => call("rename_entry", { path, newName }),
    moveEntry: (source, destDir) => call("move_entry", { source, destDir, overwrite: false }),
    deleteEntry: (path) => call("move_to_trash", { path }),
    deleteMultipleEntries: (paths) => batch("move_multiple_to_trash", paths),
    restoreFromTrash: (paths) => batch("restore_from_trash", paths),
  };
  return {
    summary,
    register(listener: (summary: HistorySummary) => void) { receive = listener; publish(); return "0"; },
    push(action: UndoAction | null) {
      if (action) undo = [...undo, entry(prepare(structuredClone(action)))].slice(-256);
      redo = []; branch += 1; revision += 1; publish(); return reply();
    },
    clear() { undo = []; redo = []; generation += 1; branch += 1; revision += 1; publish(); return reply(); },
    async execute(direction: HistoryDirection, expectedId: number): Promise<HistoryReply> {
      if (busy) return reply(undefined, "An undo or redo operation is already in progress");
      const admitted = (direction === "undo" ? undo : redo).at(-1);
      if (!admitted || admitted.id !== expectedId) return reply(undefined, "File history changed before the operation could start");
      const admittedGeneration = generation;
      const admittedBranch = branch;
      busy = true; revision += 1; publish();
      try {
        const result = await (direction === "undo" ? executeUndo : executeRedo)(admitted.action, files);
        if (generation === admittedGeneration) {
          const remaining = result.remaining ? entry(result.remaining) : null;
          const oppositeAction = result.completed && (direction === "undo" ? recoverable(result.completed) : result.completed);
          const opposite = oppositeAction ? entry(oppositeAction) : null;
          const settle = (entries: Entry[]) => entries.flatMap((candidate) => candidate.id === admitted.id ? remaining ? [remaining] : [] : [candidate]);
          if (direction === "undo") {
            undo = settle(undo);
            if (opposite && branch === admittedBranch) redo = [...redo, opposite];
          } else {
            redo = branch === admittedBranch ? settle(redo) : remaining ? [remaining] : [];
            if (opposite) undo = [...undo, opposite];
          }
        }
        busy = false; revision += 1; publish();
        if (result.completed) publishEffects([...new Set(affectedDirectories(result.completed))]);
        return reply(result.completed ?? undefined, result.error ?? undefined);
      } finally { if (busy) { busy = false; revision += 1; publish(); } }
    },
  };
}

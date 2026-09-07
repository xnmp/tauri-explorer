/** Recorded file effects and the native authority's window-local projection. */
export type UndoAction =
  | { type: "rename"; path: string; oldName: string; newName: string }
  | { type: "move"; sourcePath: string; destPath: string; originalDir: string }
  | { type: "copy"; copiedPath: string; parentDir: string; restoreSupported?: boolean }
  | { type: "batch"; actions: UndoAction[]; label: string }
  | { type: "delete"; paths: string[]; parentDir: string };

export type HistoryDirection = "undo" | "redo";
export interface HistorySummary {
  revision: number;
  undoId: number | null;
  redoId: number | null;
  stackSize: number;
  busy: boolean;
}
export interface HistoryReply {
  summary: HistorySummary;
  action?: UndoAction;
  error?: string;
}
export interface HistoryPort {
  subscribe(receive: (summary: HistorySummary) => void): () => void;
  push(action: UndoAction, shared: boolean): Promise<HistoryReply>;
  clear(): Promise<HistoryReply>;
  execute(direction: HistoryDirection, expectedEntryId: number): Promise<HistoryReply>;
}
export const emptyHistorySummary = (): HistorySummary => ({ revision: -1, undoId: null, redoId: null, stackSize: 0, busy: false });

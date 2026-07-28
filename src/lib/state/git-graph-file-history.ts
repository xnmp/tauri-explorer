/**
 * Per-pane handoff from SCM file rows to Git Graph's path filter (#518).
 *
 * The SCM panel can request history before GitGraphView mounts. Retaining one
 * request per pane makes opening the graph and applying the path one atomic
 * user action without persisting a one-off filter in tab state.
 */

type FileHistoryHandler = (filePath: string) => void;

const pendingPaths = new Map<string, string>();
const handlers = new Map<string, FileHistoryHandler>();

/** Request a graph view limited to `filePath` for a pane. */
export function requestGraphFileHistory(paneId: string, filePath: string): void {
  if (!filePath.trim()) return;
  const handler = handlers.get(paneId);
  if (handler) {
    handler(filePath);
    return;
  }
  pendingPaths.set(paneId, filePath);
}

/** Register the mounted graph's path-filter handler for one pane. */
export function registerGraphFileHistoryHandler(
  paneId: string,
  handler: FileHistoryHandler,
): () => void {
  handlers.set(paneId, handler);
  const pending = pendingPaths.get(paneId);
  if (pending !== undefined) {
    pendingPaths.delete(paneId);
    handler(pending);
  }
  return () => {
    if (handlers.get(paneId) === handler) handlers.delete(paneId);
  };
}

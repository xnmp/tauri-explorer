/**
 * Session-only graph undo state and active-pane request bus.
 *
 * The command registry owns Ctrl+Z. Components register a confirmation opener
 * by pane id, exactly like the graph refresh/navigation buses, so only the
 * active graph pane can respond.
 */
import { createGitUndoLedger } from "$lib/domain/git-graph-undo";

type RequestUndo = () => void;

export const gitUndoLedger = createGitUndoLedger();

const requesters = new Map<string, RequestUndo>();

export function registerGraphUndoRequester(paneId: string, requester: RequestUndo): () => void {
  requesters.set(paneId, requester);
  return () => {
    if (requesters.get(paneId) === requester) requesters.delete(paneId);
  };
}

export function requestGraphUndo(paneId: string | undefined | null): boolean {
  if (!paneId) return false;
  const requester = requesters.get(paneId);
  if (!requester) return false;
  requester();
  return true;
}

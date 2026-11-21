/**
 * `ctx.agent` (capability "folderAgent", #1884): a plugin's folder-agent jobs.
 * The host generates request IDs scoped to the plugin and to this context
 * incarnation (native keeps a cancelled ID refused for a while, so a
 * reactivated plugin must not reuse one). Aborting a job's signal cancels it,
 * and `cancelAll` (run on deactivation) cancels every job still running.
 * Native errors (`{code, message}`) reject unchanged; nothing is swallowed.
 * A job may only run in a folder open in one of this window's panes
 * (`folder_not_open` otherwise): a plugin cannot point the agent at a folder
 * the user is not looking at. Native applies its own folder policy on top.
 * The provider sees whatever files the agent reads
 * (docs/shared-ai-services-contracts.md § Folder agent).
 */
import { cancelAgent, describeAgent, runAgent } from "$lib/api/ai-agent";
import { agentRequestId, type AgentDescription, type AgentRequest, type AgentResult } from "$lib/domain/ai-agent";
import { sameDirectory } from "$lib/domain/path";

export interface PluginAgent {
  describe(): Promise<AgentDescription>;
  run(request: AgentRequest, signal?: AbortSignal): Promise<AgentResult>;
}

export function createPluginAgent(
  pluginId: string,
  isDisposed: () => boolean,
  reportCancelFailure: (error: unknown) => void,
  /** Paths of the panes open in this window's tabs. */
  openFolders: () => readonly string[],
): { agent: PluginAgent; cancelAll: () => void } {
  const running = new Set<string>();
  const incarnation = Math.random().toString(36).slice(2, 10);
  let sequence = 0;
  const cancel = (requestId: string) => { void cancelAgent(requestId).catch(reportCancelFailure); };
  const refuseDisposed = () => { if (isDisposed()) throw new Error("Plugin caller was disposed"); };
  return {
    agent: {
      async describe() {
        refuseDisposed();
        return describeAgent();
      },
      async run(request, signal) {
        refuseDisposed();
        signal?.throwIfAborted();
        if (!openFolders().some((path) => sameDirectory(path, request.folder))) {
          throw { code: "folder_not_open", message: "Agent jobs run only in a folder open in a pane of this window" };
        }
        const requestId = agentRequestId(pluginId, incarnation, ++sequence);
        running.add(requestId);
        const abort = () => { if (running.has(requestId)) cancel(requestId); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          return await runAgent({ ...request, requestId });
        } finally {
          signal?.removeEventListener("abort", abort);
          running.delete(requestId);
        }
      },
    },
    cancelAll() {
      for (const requestId of running) cancel(requestId);
      running.clear();
    },
  };
}

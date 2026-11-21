/**
 * Folder-agent jobs (#1884) on the configured Claude Code / Codex CLI
 * connection. Native owns the connection, read-only tool isolation, deadline,
 * the two-job queue and per-window cancellation; `describeAgent` lets a caller
 * refuse before building a request. Plugins reach this through `ctx.agent`.
 */
import { invoke } from "./common";
import type { AgentDescription, AgentResult, AgentRunRequest } from "$lib/domain/ai-agent";

export const describeAgent = () => invoke<AgentDescription>("ai_agent_describe");
export const runAgent = (request: AgentRunRequest) => invoke<AgentResult>("ai_agent_run", { ...request });
export const cancelAgent = (requestId: string) => invoke<boolean>("ai_agent_cancel", { requestId });

/**
 * Folder-agent contract (#1884): one job runs a CLI connection (Claude Code or
 * Codex) in a folder with read-only file tools, answering `instructions`
 * about the files the model chooses to read. Native owns the connection,
 * isolation, deadline, queue and cancellation; see
 * docs/shared-ai-services-contracts.md § Folder agent.
 */
import type { ServiceError, TextContext } from "./text-connections";

/** How far the CLI's reads are kept inside the folder: `folder` is enforced
 *  by the CLI; `folderRequested` is configuration an older CLI may ignore. */
export type AgentReadScope = "folder" | "folderRequested";

export interface AgentDescription {
  version: 1;
  enabled: boolean;
  /** A Claude Code / Codex CLI connection is selected and passes local checks. */
  available: boolean;
  configurationRevision: number;
  context?: TextContext;
  /** Model IDs `run` accepts; the default (cheapest) comes first. */
  models: string[];
  defaultModel?: string;
  readScope?: AgentReadScope;
  /** Plain-language isolation summary for the selected connection. */
  isolation?: string;
  maxTimeoutMs: number;
  maxConcurrent: number;
  error?: ServiceError;
}

export interface AgentRequest {
  /** Absolute path of an existing local directory; it becomes the CLI's
   *  working directory and the only place it may read. */
  folder: string;
  instructions: string;
  /** Data for the instructions (for example file names), framed as JSON. */
  input: string;
  /** One of `AgentDescription.models`; defaults to `defaultModel`. */
  model?: string;
  maxOutputTokens: number;
  /** Whole-job deadline including queueing; default 120 s, capped at `maxTimeoutMs`. */
  timeoutMs?: number;
  expectedConfigurationRevision?: number;
}

export interface AgentRunRequest extends AgentRequest {
  requestId: string;
}

export interface AgentResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Native request IDs: 1–128 of `[A-Za-z0-9._-]`. */
const UNSAFE_ID = /[^A-Za-z0-9._-]+/g;

/**
 * Host-generated request ID for a plugin's agent job: scoped to the plugin
 * and to one context incarnation, so a reactivated plugin never reuses an ID
 * native still remembers as cancelled.
 */
export function agentRequestId(pluginId: string, incarnation: string, sequence: number): string {
  const owner = pluginId.replace(UNSAFE_ID, "_").slice(0, 64) || "plugin";
  const scope = incarnation.replace(UNSAFE_ID, "").slice(0, 24) || "0";
  return `agent.${owner}.${scope}.${sequence}`;
}

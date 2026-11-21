/**
 * Mock AI and plugin-job commands: AI operations, connections, presentation and generation jobs.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { AiResolution } from "$lib/domain/ai-operations";
import { createMockAiPresentation } from "./mock-ai-presentation";
import { getMockControl } from "./mock-control";
import { createMockTextConnections } from "./mock-text-connections";
import type { CommandHandler } from "./mock-dispatch";
import { mockFiles } from "./mock-fixtures";
import type { AgentDescription } from "$lib/domain/ai-agent";

const mockAiPresentation = () => getMockControl().nativeAiPresentation ??= createMockAiPresentation((name, value) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail: value }));
});

const mockTextConnections = createMockTextConnections();

function mockTextDescription() {
  const configuration = mockTextConnections.read();
  const available = configuration.enabled && !getMockControl().aiTextUnavailable;
  return { version: 1, enabled: configuration.enabled, available, configurationRevision: configuration.revision, ...(available ? {} : { error: { code: "disabled", message: "Text generation is disabled" } }) };
}

const MOCK_AGENT_MODELS = ["haiku", "sonnet", "opus"];

/** Mirrors native `ai_agent_describe` for a Claude Code connection (#1884). */
function mockAgentDescription(): AgentDescription {
  const text = mockTextDescription();
  const available = text.available && !getMockControl().aiAgentUnavailable;
  return {
    version: 1 as const, enabled: text.enabled, available, configurationRevision: text.configurationRevision,
    models: available ? MOCK_AGENT_MODELS : [], maxTimeoutMs: 300_000, maxConcurrent: 2,
    ...(available
      ? { defaultModel: MOCK_AGENT_MODELS[0], readScope: "folder" as const, isolation: "Mock folder agent: reads only the folder." }
      : { error: { code: "unsupported", message: "Folder agent jobs need a Claude Code CLI or Codex CLI connection; HTTP connections cannot read files" } }),
  };
}

/** Pending mock agent jobs by request ID, so `ai_agent_cancel` can end them. */
const mockAgentJobs = new Map<string, () => void>();

/** Deterministic stand-in for a folder agent: a JSON object mapping each file
 *  of the mock folder to its extension in capitals ("NONE" without one). */
function mockAgentReply(folder: string): string {
  const files = (mockFiles[folder] ?? []).filter((entry) => entry.kind === "file");
  return JSON.stringify(Object.fromEntries(files.map((entry) => {
    const dot = entry.name.lastIndexOf(".");
    return [entry.name, dot > 0 ? entry.name.slice(dot + 1).toUpperCase() : "NONE"];
  })));
}

async function mockAgentRun(args: Record<string, unknown>) {
  const description = mockAgentDescription();
  if (!description.available) throw description.error;
  const folder = String(args.folder ?? "");
  if (!folder.startsWith("/") || /^[a-z][a-z0-9+.-]+:\/\//i.test(folder)) {
    throw { code: "invalid_request", message: "Agent folder must be an absolute path" };
  }
  const model = typeof args.model === "string" ? args.model : MOCK_AGENT_MODELS[0];
  if (!MOCK_AGENT_MODELS.includes(model)) throw { code: "invalid_request", message: "Model is not offered for agent jobs on this connection; use one that describe lists" };
  const control = getMockControl();
  const requestId = String(args.requestId);
  if (control.aiAgentDelayMs) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { mockAgentJobs.delete(requestId); resolve(); }, control.aiAgentDelayMs);
      mockAgentJobs.set(requestId, () => { clearTimeout(timer); mockAgentJobs.delete(requestId); reject({ code: "cancelled", message: "Text request was cancelled" }); });
    });
  }
  const request = { folder, instructions: String(args.instructions ?? ""), input: String(args.input ?? ""), model };
  const text = control.aiAgentReply ? control.aiAgentReply(request) : mockAgentReply(folder);
  return { text, model, usage: { inputTokens: request.instructions.length + request.input.length, outputTokens: text.length } };
}

const MOCK_FILTER_STOPWORDS = new Set(["the", "and", "all", "any", "from", "with", "that", "show", "only", "files", "file", "items", "folder", "folders", "last", "days"]);

/** Deterministic stand-in for a model: names containing any query word. */
function mockAiFilterReply(input: string): string {
  const lines = input.split("\n");
  const request = (lines.find(line => line.startsWith("Request: ")) ?? "").slice("Request: ".length).toLowerCase();
  const words = request.split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && !MOCK_FILTER_STOPWORDS.has(word));
  const start = lines.findIndex(line => line.startsWith("Entries"));
  const names = lines.slice(start + 1).map(line => line.split("\t")[1]).filter((name): name is string => !!name);
  return JSON.stringify({ names: names.filter(name => words.some(word => name.toLowerCase().includes(word))) });
}

export const aiCommands: Record<string, CommandHandler> = {
  plugin_jobs_snapshot: () => mockAiPresentation().snapshot(),
  plugin_job_reveal: (args) => mockAiPresentation().snapshot().jobs.find(job => job.jobKey === args.jobKey)?.reveal ?? null,
  plugin_job_cancel: (args) => mockAiPresentation().cancel(String(args.jobKey)),
  plugin_job_dismiss: (args) => mockAiPresentation().dismiss(String(args.jobKey)),
  plugin_job_resume: (args) => mockAiPresentation().resume(String(args.jobKey)),
  ai_operations_snapshot: () => mockAiPresentation().operationSnapshot(),
  ai_operation_resolve: (args) => mockAiPresentation().resolve(String(args.consumerPackage), String(args.operationId), args.action as AiResolution),
  ai_connections_read: () => mockTextConnections.read(),
  ai_connections_save: ({ configuration, expectedRevision }) => mockTextConnections.save(configuration, expectedRevision),
  ai_connection_set_credential: ({ profileId, key, expectedRevision }) => mockTextConnections.credential(profileId, key, expectedRevision),
  ai_connection_clear_credential: ({ profileId, expectedRevision }) => mockTextConnections.credential(profileId, null, expectedRevision),
  ai_connection_check: ({ profileId }) => mockTextConnections.check(profileId),
  ai_connection_test: ({ profileId, expectedConfigurationRevision }) => mockTextConnections.test(profileId, expectedConfigurationRevision),
  ai_connection_cancel_test: () => undefined,
  ai_text_describe: () => mockTextDescription(),
  ai_text_generate: ({ input }) => {
    if (!mockTextDescription().available) throw { code: "disabled", message: "Text generation is disabled" };
    const text = String(input);
    const reply = getMockControl().aiTextReply;
    return { text: reply ? reply(text) : mockAiFilterReply(text), context: mockTextConnections.context() };
  },
  ai_text_cancel: () => true,
  ai_agent_describe: () => mockAgentDescription(),
  ai_agent_run: (args) => mockAgentRun(args),
  ai_agent_cancel: ({ requestId }) => { const cancel = mockAgentJobs.get(String(requestId)); cancel?.(); return true; },

  start_nano_banana_job: () => 1,

  start_upscale_job: () => 1,

  // Deterministic fake filename suggestions so browser E2E exercises the picker
  // without a real model. Derives names from the original's extension.
  ai_suggest_destination: (args) => {
    const candidates = (args.candidates as string[]) ?? [];
    const count = Math.max(1, Math.min(5, (args.count as number) ?? 3));
    // Deterministic mock: the first N candidates, so E2E can assert exact rows.
    return candidates.slice(0, count);
  },
  ai_suggest_filenames: (args) => {
    const originalName = (args.originalName as string) ?? "file";
    const dot = originalName.lastIndexOf(".");
    const ext = dot > 0 ? originalName.slice(dot) : "";
    const count = Math.max(1, Math.min(5, (args.count as number) ?? 3));
    const bases = ["meeting-notes", "2024-notes", "summary", "draft", "final"];
    return bases.slice(0, count).map((b) => `${b}${ext}`);
  },
};

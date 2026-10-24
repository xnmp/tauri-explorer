/**
 * Mock AI and plugin-job commands: AI operations, connections, presentation and generation jobs.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { AiResolution } from "$lib/domain/ai-operations";
import { createMockAiPresentation } from "./mock-ai-presentation";
import { getMockControl } from "./mock-control";
import { createMockTextConnections } from "./mock-text-connections";
import type { CommandHandler } from "./mock-dispatch";

const mockAiPresentation = () => getMockControl().nativeAiPresentation ??= createMockAiPresentation((name, value) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail: value }));
});

const mockTextConnections = createMockTextConnections();

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

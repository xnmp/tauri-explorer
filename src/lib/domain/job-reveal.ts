/** Reveal policy with injected workspace effects. No Svelte or IPC dependencies. */
import type { JobReveal } from "$lib/plugins/api";
import { parentDir, sameDirectory } from "./path";
import { jobReveal } from "./job-presentation";

export interface RevealPane { tabId: string; paneId: string; directory: string; viewId?: string | null }
export function findRevealPane(panes: readonly RevealPane[], reveal: JobReveal): RevealPane | undefined {
  const directory = reveal.kind === "file" ? parentDir(reveal.path) : reveal.directory;
  return panes.find(pane => sameDirectory(pane.directory, directory) && (reveal.kind === "file" || pane.viewId === reveal.viewId));
}
export interface FileSelectionWorkspace {
  currentDirectory(): string;
  current(): boolean;
  navigate(directory: string): Promise<unknown>;
  refresh(): Promise<void>;
  select(path: string): boolean;
  capture(): () => boolean;
}
/** Same present-file selection used by workspace.selectFile and job reveal. */
export async function selectWorkspaceFile(path: string, workspace: FileSelectionWorkspace, signal?: AbortSignal): Promise<"selected" | "missing" | "aborted"> {
  const live = () => !signal?.aborted && workspace.current();
  if (!live()) return "aborted";
  const directory = parentDir(path);
  const previousDirectory = workspace.currentDirectory();
  if (!sameDirectory(previousDirectory, directory)) {
    const navigation = workspace.navigate(directory);
    const ownsNavigation = workspace.capture();
    const navigated = await navigation;
    if (navigated === false && live() && ownsNavigation() && workspace.currentDirectory() === previousDirectory) return "missing";
  }
  if (!live() || !sameDirectory(workspace.currentDirectory(), directory)) return "aborted";
  if (workspace.select(path)) return "selected";
  const ownsSelection = workspace.capture();
  await workspace.refresh();
  if (!live() || !ownsSelection()) return "aborted";
  return workspace.select(path) ? "selected" : "missing";
}
export interface RevealDependencies {
  panes(): readonly RevealPane[];
  open(directory: string, existing: RevealPane | undefined, signal: AbortSignal): Promise<boolean | void>;
  file(path: string, signal: AbortSignal): Promise<"selected" | "missing" | "aborted">;
  view(viewId: string, targetId: string, signal: AbortSignal): Promise<boolean>;
  fallback(): void;
  notify(message: string): void;
}
export async function routeJobReveal(reveal: JobReveal, deps: RevealDependencies, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const directory = reveal.kind === "file" ? parentDir(reveal.path) : reveal.directory;
  const opened = await deps.open(directory, findRevealPane(deps.panes(), reveal), signal);
  if (signal.aborted) return;
  if (opened === false) {
    deps.notify(reveal.kind === "file" ? "The image was moved or deleted" : "The image folder could not be opened");
    return;
  }
  if (reveal.kind === "file") {
    deps.fallback();
    if (await deps.file(reveal.path, signal) === "missing" && !signal.aborted) deps.notify("The image was moved or deleted");
    return;
  }
  try {
    if (await deps.view(reveal.viewId, reveal.targetId, signal) || signal.aborted) return;
  } catch {
    if (signal.aborted) return;
  }
  deps.fallback();
  deps.notify("The image could not be shown. Opened its folder");
}
/** Latest click owns all continuations, including a delayed status response. */
export function createJobRevealController<T extends { reveal?: JobReveal }>(deps: {
  latest(job: T, signal: AbortSignal): Promise<unknown>;
  route(reveal: JobReveal, signal: AbortSignal): Promise<void>;
  error(error: unknown): void;
}) {
  let current: AbortController | undefined;
  const abort = () => { current?.abort(); current = undefined; };
  return {
    abort,
    async show(job: T): Promise<void> {
      abort();
      const request = new AbortController(); current = request;
      try {
        let reveal = job.reveal;
        try { reveal = jobReveal(await deps.latest(job, request.signal)) ?? reveal; } catch { /* Stored target survives an unavailable consumer. */ }
        if (reveal && !request.signal.aborted) await deps.route(reveal, request.signal);
      } catch (error) { if (!request.signal.aborted) deps.error(error); }
      finally { if (current === request) current = undefined; }
    },
  };
}

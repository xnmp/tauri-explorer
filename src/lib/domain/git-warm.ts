/**
 * Background git cache warmer — scheduling/dedup logic (#287).
 *
 * Pure, dependency-injected: decides WHEN and WHETHER to warm the git-graph
 * and SCM caches after a pane settles on a folder. Debounces path changes,
 * probes the repo root once per folder, warms each repo at most once, and
 * gates each cache on its feature flag. The real IPC/store wiring lives in
 * `state/git-warm.ts`; this module has no framework or backend dependency so
 * the timing/dedup rules can be unit-tested directly.
 */

import { directoryKey } from "./path";

export interface GitWarmDeps {
  /** Resolve the git repo root for a folder, or null when it isn't in a repo. */
  resolveRepoRoot: (path: string) => Promise<string | null>;
  /** Warm the git-graph cache for a repo root (fire-and-forget). */
  warmGraph: (repoRoot: string) => void;
  /** Warm the SCM summary cache for a repo root (fire-and-forget). */
  warmScm: (repoRoot: string) => void;
  /** Release owner-scoped warm work once no pane remains in the repo. */
  cancelWarm?: (repoRoot: string) => void;
  /** Whether the git-graph feature is enabled (gates graph warming). */
  graphEnabled: () => boolean;
  /** Whether the git-status/SCM feature is enabled (gates SCM warming). */
  scmEnabled: () => boolean;
  /** Debounce window (ms) the path must stay stable before warming. */
  debounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface GitWarmer {
  /** Track a pane settled on `path`; release it when the pane navigates away. */
  schedule: (path: string, ownerId?: string) => () => void;
}

export function createGitWarmer(deps: GitWarmDeps): GitWarmer {
  const debounceMs = deps.debounceMs ?? 250;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingPaths = new Map<string, string>();
  // Roots already warmed this session — skips redundant warms on repeat
  // navigation into the same repo.
  const warmedRoots = new Set<string>();
  // Resolved roots per path (null = known non-repo) — avoids re-probing the
  // same folder, so a second navigation into it costs no extra IPC.
  const resolvedRoots = new Map<string, string | null>();
  const trackedPaths = new Map<string, number>();

  function schedule(path: string, ownerId = "default"): () => void {
    if (!path) return () => {};
    // Non-git users (both features off) pay zero extra IPC.
    if (!deps.graphEnabled() && !deps.scmEnabled()) return () => {};
    trackedPaths.set(path, (trackedPaths.get(path) ?? 0) + 1);
    pendingPaths.set(ownerId, path);
    const existingTimer = timers.get(ownerId);
    if (existingTimer !== undefined) clearT(existingTimer);
    const timer = setT(() => {
      timers.delete(ownerId);
      const pendingPath = pendingPaths.get(ownerId);
      pendingPaths.delete(ownerId);
      if (pendingPath) void run(pendingPath);
    }, debounceMs);
    timers.set(ownerId, timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (pendingPaths.get(ownerId) === path) {
        const pendingTimer = timers.get(ownerId);
        if (pendingTimer !== undefined) clearT(pendingTimer);
        timers.delete(ownerId);
        pendingPaths.delete(ownerId);
      }
      const remaining = (trackedPaths.get(path) ?? 1) - 1;
      if (remaining > 0) {
        trackedPaths.set(path, remaining);
        return;
      }
      trackedPaths.delete(path);
      const pathKey = directoryKey(path);
      const root = resolvedRoots.get(path)
        ?? Array.from(warmedRoots).find((candidate) => {
          const candidateKey = directoryKey(candidate);
          return pathKey === candidateKey || pathKey.startsWith(`${candidateKey}/`);
        });
      if (!root) return;
      const rootKey = directoryKey(root);
      const rootStillTracked = Array.from(trackedPaths).some(
        ([trackedPath, refs]) => {
          if (refs <= 0) return false;
          const resolved = resolvedRoots.get(trackedPath);
          if (resolved) return directoryKey(resolved) === rootKey;
          const trackedKey = directoryKey(trackedPath);
          const insideRoot = trackedKey === rootKey || trackedKey.startsWith(`${rootKey}/`);
          if (insideRoot) resolvedRoots.set(trackedPath, root);
          return insideRoot;
        },
      );
      if (!rootStillTracked) {
        warmedRoots.delete(root);
        deps.cancelWarm?.(root);
      }
    };
  }

  async function run(path: string): Promise<void> {
    if (!trackedPaths.has(path)) return;
    if (!resolvedRoots.has(path)) {
      try {
        resolvedRoots.set(path, await deps.resolveRepoRoot(path));
      } catch {
        return; // best-effort; a later navigation can retry
      }
    }
    if (!trackedPaths.has(path)) return;
    const root = resolvedRoots.get(path) ?? null;
    if (!root || warmedRoots.has(root)) return;
    warmedRoots.add(root);
    if (deps.scmEnabled()) deps.warmScm(root);
    if (deps.graphEnabled()) deps.warmGraph(root);
  }

  return { schedule };
}

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
  const pendingPaths = new Map<string, { path: string }>();
  // Roots already warmed this session — skips redundant warms on repeat
  // navigation into the same repo.
  const warmedRoots = new Set<string>();
  // Resolved roots only for paths with live owners. Long-lived probe reuse is
  // provided by the bounded shared state cache; this map exists for release.
  const resolvedRoots = new Map<string, string | null>();
  const trackedPaths = new Map<string, number>();
  const pathOwners = new Map<string, object>();
  const probes = new Map<string, object>();

  function schedule(path: string, ownerId = "default"): () => void {
    if (!path) return () => {};
    // Non-git users (both features off) pay zero extra IPC.
    if (!deps.graphEnabled() && !deps.scmEnabled()) return () => {};
    if (!trackedPaths.has(path)) pathOwners.set(path, {});
    trackedPaths.set(path, (trackedPaths.get(path) ?? 0) + 1);
    const request = { path };
    pendingPaths.set(ownerId, request);
    const existingTimer = timers.get(ownerId);
    if (existingTimer !== undefined) clearT(existingTimer);
    const timer = setT(() => {
      if (pendingPaths.get(ownerId) !== request) return;
      timers.delete(ownerId);
      const pendingPath = pendingPaths.get(ownerId);
      pendingPaths.delete(ownerId);
      if (pendingPath) void run(pendingPath.path);
    }, debounceMs);
    timers.set(ownerId, timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (pendingPaths.get(ownerId) === request) {
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
      pathOwners.delete(path);
      probes.delete(path);
      resolvedRoots.delete(path);
      releaseUnusedRoots();
    };
  }

  function releaseUnusedRoots(): void {
    const activeRoots = new Set(resolvedRoots.values());
    for (const root of warmedRoots) {
      if (activeRoots.has(root)) continue;
      warmedRoots.delete(root);
      deps.cancelWarm?.(root);
    }
  }

  async function run(path: string): Promise<void> {
    const owner = pathOwners.get(path);
    if (!owner) return;
    const probe = {};
    probes.set(path, probe);
    try {
      // Probe reuse belongs to the shared cache. A live path can become a
      // nested repository; this map is release bookkeeping, not a second cache.
      const root = await deps.resolveRepoRoot(path);
      if (pathOwners.get(path) !== owner || probes.get(path) !== probe) return;
      resolvedRoots.set(path, root);
      releaseUnusedRoots();
    } catch {
      return; // best-effort; a later navigation can retry
    } finally {
      if (probes.get(path) === probe) probes.delete(path);
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

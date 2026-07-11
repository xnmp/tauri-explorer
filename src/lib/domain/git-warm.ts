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
  /** Note that a pane settled on `path`; warms after the debounce elapses. */
  schedule: (path: string) => void;
}

export function createGitWarmer(deps: GitWarmDeps): GitWarmer {
  const debounceMs = deps.debounceMs ?? 250;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingPath = "";
  // Roots already warmed this session — skips redundant warms on repeat
  // navigation into the same repo.
  const warmedRoots = new Set<string>();
  // Resolved roots per path (null = known non-repo) — avoids re-probing the
  // same folder, so a second navigation into it costs no extra IPC.
  const resolvedRoots = new Map<string, string | null>();

  function schedule(path: string): void {
    if (!path) return;
    // Non-git users (both features off) pay zero extra IPC.
    if (!deps.graphEnabled() && !deps.scmEnabled()) return;
    pendingPath = path;
    if (timer !== null) clearT(timer);
    timer = setT(() => {
      timer = null;
      void run(pendingPath);
    }, debounceMs);
  }

  async function run(path: string): Promise<void> {
    if (!resolvedRoots.has(path)) {
      try {
        resolvedRoots.set(path, await deps.resolveRepoRoot(path));
      } catch {
        return; // best-effort; a later navigation can retry
      }
    }
    const root = resolvedRoots.get(path) ?? null;
    if (!root || warmedRoots.has(root)) return;
    warmedRoots.add(root);
    if (deps.scmEnabled()) deps.warmScm(root);
    if (deps.graphEnabled()) deps.warmGraph(root);
  }

  return { schedule };
}

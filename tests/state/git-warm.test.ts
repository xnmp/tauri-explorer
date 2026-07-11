/**
 * Background git cache warmer scheduling/dedup logic (#287).
 *
 * Behavior under test (the debounce + repo-root resolution + per-feature
 * gating that decides WHEN and WHETHER to warm), exercised through the pure
 * dependency-injected factory with fake timers:
 * - navigating into a repo warms both caches (graph + SCM) with the repo root;
 * - a non-repo folder warms nothing;
 * - rapid path changes collapse to a single warm (debounce);
 * - a failed repo probe is swallowed (no throw) and warms nothing;
 * - a second navigation into an already-warmed repo re-probes/re-warms nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGitWarmer, type GitWarmDeps } from "$lib/domain/git-warm";

const DEBOUNCE = 250;

function makeDeps(overrides: Partial<GitWarmDeps> = {}) {
  const warmGraph = vi.fn<(root: string) => void>();
  const warmScm = vi.fn<(root: string) => void>();
  const resolveRepoRoot = vi.fn<(path: string) => Promise<string | null>>(async (path) =>
    path.startsWith("/repo") ? "/repo" : null,
  );
  const deps: GitWarmDeps = {
    resolveRepoRoot,
    warmGraph,
    warmScm,
    graphEnabled: () => true,
    scmEnabled: () => true,
    debounceMs: DEBOUNCE,
    ...overrides,
  };
  return { deps, warmGraph, warmScm, resolveRepoRoot };
}

/** Fire the debounce timer and flush the async run() that follows. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("gitWarmer scheduling", () => {
  it("warms both the graph and SCM caches with the resolved repo root", async () => {
    const { deps, warmGraph, warmScm } = makeDeps();
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await tick();

    expect(warmGraph).toHaveBeenCalledOnce();
    expect(warmGraph).toHaveBeenCalledWith("/repo");
    expect(warmScm).toHaveBeenCalledOnce();
    expect(warmScm).toHaveBeenCalledWith("/repo");
  });

  it("warms nothing for a folder that isn't inside a repo", async () => {
    const { deps, warmGraph, warmScm } = makeDeps();
    const warmer = createGitWarmer(deps);

    warmer.schedule("/plain/folder");
    await tick();

    expect(warmGraph).not.toHaveBeenCalled();
    expect(warmScm).not.toHaveBeenCalled();
  });

  it("collapses rapid path changes into a single warm of the final path", async () => {
    const { deps, warmGraph, warmScm, resolveRepoRoot } = makeDeps();
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/a");
    await vi.advanceTimersByTimeAsync(100);
    warmer.schedule("/repo/b");
    await vi.advanceTimersByTimeAsync(100);
    warmer.schedule("/repo/c");
    await tick();

    expect(resolveRepoRoot).toHaveBeenCalledOnce();
    expect(resolveRepoRoot).toHaveBeenCalledWith("/repo/c");
    expect(warmGraph).toHaveBeenCalledOnce();
    expect(warmScm).toHaveBeenCalledOnce();
  });

  it("swallows a failing repo probe without throwing or warming", async () => {
    const resolveRepoRoot = vi.fn<(p: string) => Promise<string | null>>(async () => {
      throw new Error("ipc down");
    });
    const { deps, warmGraph, warmScm } = makeDeps({ resolveRepoRoot });
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await expect(tick()).resolves.toBeUndefined();

    expect(warmGraph).not.toHaveBeenCalled();
    expect(warmScm).not.toHaveBeenCalled();
  });

  it("does not re-probe or re-warm a repo on a second navigation into it", async () => {
    const { deps, warmGraph, warmScm, resolveRepoRoot } = makeDeps();
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await tick();
    warmer.schedule("/repo/src");
    await tick();

    expect(resolveRepoRoot).toHaveBeenCalledOnce();
    expect(warmGraph).toHaveBeenCalledOnce();
    expect(warmScm).toHaveBeenCalledOnce();
  });

  it("warms the graph but not SCM once per root when only the graph feature is on", async () => {
    const { deps, warmGraph, warmScm } = makeDeps({ scmEnabled: () => false });
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await tick();

    expect(warmGraph).toHaveBeenCalledOnce();
    expect(warmScm).not.toHaveBeenCalled();
  });

  it("issues no probe at all when both git features are disabled", async () => {
    const { deps, resolveRepoRoot, warmGraph, warmScm } = makeDeps({
      graphEnabled: () => false,
      scmEnabled: () => false,
    });
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await tick();

    expect(resolveRepoRoot).not.toHaveBeenCalled();
    expect(warmGraph).not.toHaveBeenCalled();
    expect(warmScm).not.toHaveBeenCalled();
  });
});

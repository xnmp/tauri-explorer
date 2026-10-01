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

  it("reuses the shared root resolver but warms a live repository only once", async () => {
    const { deps, warmGraph, warmScm, resolveRepoRoot } = makeDeps();
    const warmer = createGitWarmer(deps);

    warmer.schedule("/repo/src");
    await tick();
    warmer.schedule("/repo/src");
    await tick();

    expect(resolveRepoRoot).toHaveBeenCalledTimes(2);
    expect(warmGraph).toHaveBeenCalledOnce();
    expect(warmScm).toHaveBeenCalledOnce();
  });

  it("releases per-path resolution when its final owner leaves", async () => {
    const { deps, resolveRepoRoot } = makeDeps();
    const warmer = createGitWarmer(deps);
    const release = warmer.schedule("/repo/src");
    await tick();
    release();

    warmer.schedule("/repo/src");
    await tick();

    expect(resolveRepoRoot).toHaveBeenCalledTimes(2);
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

describe("gitWarmer pending ownership", () => {
  it("does not retain a root resolved after its last owner releases", async () => {
    let complete!: (root: string) => void;
    const lookup = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }))
      .mockResolvedValue("/new-root");
    const { deps, warmGraph } = makeDeps({ resolveRepoRoot: lookup });
    const warmer = createGitWarmer(deps);
    const release = warmer.schedule("/repo/src");
    await tick();
    release();
    complete("/old-root");
    await Promise.resolve();
    warmer.schedule("/repo/src");
    await tick();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(warmGraph).toHaveBeenCalledExactlyOnceWith("/new-root");
  });

  it("a replaced path owner cannot publish into a new owner during lookup", async () => {
    let complete!: (root: string) => void;
    const lookup = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }))
      .mockResolvedValue("/new-root");
    const { deps, warmGraph } = makeDeps({ resolveRepoRoot: lookup });
    const warmer = createGitWarmer(deps);
    const release = warmer.schedule("/repo/src");
    await tick();
    release();
    warmer.schedule("/repo/src");
    complete("/old-root");
    await tick();
    expect(warmGraph).toHaveBeenCalledExactlyOnceWith("/new-root");
  });

  it("an old same-path disposer cannot cancel its owner's replacement timer", async () => {
    const { deps, warmGraph } = makeDeps();
    const warmer = createGitWarmer(deps);
    const release = warmer.schedule("/repo/src", "pane");
    warmer.schedule("/repo/src", "pane");
    release();
    await tick();
    expect(warmGraph).toHaveBeenCalledExactlyOnceWith("/repo");
  });
});

it("does not assign a pending nested repository to an ancestor's warm owner", async () => {
  let complete!: (root: string) => void;
  const cancelWarm = vi.fn();
  const resolveRepoRoot = vi.fn().mockResolvedValueOnce("/repo")
    .mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }));
  const { deps } = makeDeps({ resolveRepoRoot, cancelWarm });
  const warmer = createGitWarmer(deps);
  const releaseOuter = warmer.schedule("/repo/a", "outer");
  await tick();
  const releaseInner = warmer.schedule("/repo/nested/b", "inner");
  await tick();
  releaseOuter();
  complete("/repo/nested");
  await Promise.resolve();
  releaseInner();
  expect(cancelWarm.mock.calls.map(([root]) => root).sort()).toEqual(["/repo", "/repo/nested"]);
});

it("only the newest concurrent probe may change a live path's root", async () => {
  let old!: (root: string) => void; let newer!: (root: string) => void;
  const lookup = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { old = resolve; }))
    .mockImplementationOnce(() => new Promise<string>((resolve) => { newer = resolve; }));
  const { deps, warmGraph } = makeDeps({ resolveRepoRoot: lookup });
  const warmer = createGitWarmer(deps);
  warmer.schedule("/repo/src", "first"); await tick();
  warmer.schedule("/repo/src", "second"); await tick();
  newer("/new"); await Promise.resolve();
  old("/old"); await Promise.resolve();
  expect(warmGraph).toHaveBeenCalledExactlyOnceWith("/new");
});

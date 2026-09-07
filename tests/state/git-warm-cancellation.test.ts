import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWarmer } from "$lib/domain/git-warm";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("gitWarmer pane ownership", () => {
  it("releases warm summary work when the final tracked pane leaves", async () => {
    const cancelWarm = vi.fn<(root: string) => void>();
    const warmer = createGitWarmer({
      resolveRepoRoot: vi.fn(async () => "/repo"),
      warmGraph: vi.fn(),
      warmScm: vi.fn(),
      cancelWarm,
      graphEnabled: () => true,
      scmEnabled: () => true,
      debounceMs: 1,
    });

    const releaseFirst = warmer.schedule("/repo/src");
    const releaseSecond = warmer.schedule("/repo/src");
    await vi.advanceTimersByTimeAsync(1);

    releaseFirst();
    expect(cancelWarm).not.toHaveBeenCalled();

    releaseSecond();
    expect(cancelWarm).toHaveBeenCalledOnce();
    expect(cancelWarm).toHaveBeenCalledWith("/repo");
  });

  it("keeps a repo warm while another pane tracks a different child path", async () => {
    const cancelWarm = vi.fn<(root: string) => void>();
    const warmer = createGitWarmer({
      resolveRepoRoot: vi.fn(async () => "/repo"),
      warmGraph: vi.fn(),
      warmScm: vi.fn(),
      cancelWarm,
      graphEnabled: () => true,
      scmEnabled: () => true,
      debounceMs: 1,
    });

    const releaseFirst = warmer.schedule("/repo/first", "first");
    const releaseSecond = warmer.schedule("/repo/second", "second");
    await vi.advanceTimersByTimeAsync(1);

    releaseSecond();
    expect(cancelWarm).not.toHaveBeenCalled();

    releaseFirst();
    expect(cancelWarm).toHaveBeenCalledWith("/repo");
  });

  it("debounces each pane independently so one pane cannot suppress another", async () => {
    const warmScm = vi.fn<(root: string) => void>();
    const warmer = createGitWarmer({
      resolveRepoRoot: vi.fn(async (path) => path.startsWith("/one") ? "/one" : "/two"),
      warmGraph: vi.fn(),
      warmScm,
      graphEnabled: () => false,
      scmEnabled: () => true,
      debounceMs: 1,
    });

    warmer.schedule("/one/src", "left");
    warmer.schedule("/two/src", "right");
    await vi.advanceTimersByTimeAsync(1);

    expect(warmScm).toHaveBeenCalledTimes(2);
    expect(warmScm).toHaveBeenCalledWith("/one");
    expect(warmScm).toHaveBeenCalledWith("/two");
  });
});

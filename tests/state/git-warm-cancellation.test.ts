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
});

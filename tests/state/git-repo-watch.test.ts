import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ watch: vi.fn(), unwatch: vi.fn() }));
vi.mock("$lib/api/git", () => ({ gitWatchRepo: api.watch, gitUnwatchRepo: api.unwatch }));
import { createGitRepoWatch } from "$lib/state/git-repo-watch";
it("closing during Git watch acquisition releases the late native reference", async () => {
  let acquired!: () => void; let refs = 0;
  api.watch.mockImplementation(() => new Promise((resolve) => { acquired = () => { refs++; resolve({ ok: true }); }; }));
  api.unwatch.mockImplementation(async () => { refs = Math.max(0, refs - 1); return { ok: true }; });
  const owner = createGitRepoWatch();
  const loading = owner.update("/repo");
  await vi.waitFor(() => expect(acquired).toBeDefined());
  const closing = owner.destroy();
  acquired();
  await Promise.all([loading, closing]);
  expect(refs).toBe(0);
});
it("failed acquisition does not release another owner's native reference", async () => {
  vi.clearAllMocks();
  api.watch.mockResolvedValueOnce({ ok: false, error: "cannot watch" });
  const owner = createGitRepoWatch();
  await expect(owner.update("/repo")).rejects.toThrow("cannot watch");
  await owner.destroy();
  expect(api.unwatch).not.toHaveBeenCalled();
});

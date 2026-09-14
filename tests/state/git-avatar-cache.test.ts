import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ email: string; resolve: (value: string | null) => void }> = [];
vi.mock("$lib/api/git-avatar", () => ({
  gitAuthorAvatar: (email: string) => new Promise<string | null>((resolve) => calls.push({ email, resolve })),
}));

describe("git avatar request ownership", () => {
  beforeEach(() => { calls.length = 0; vi.resetModules(); });
  it("bounds active lookups and removes a queued request when its last owner leaves", async () => {
    const { requestGitAuthorAvatar, gitAvatarQueueSizeForTests } = await import("$lib/state/git-avatar-cache");
    const requests = Array.from({ length: 6 }, (_, index) => requestGitAuthorAvatar(`author-${index}@example.com`, false));
    expect(calls.map(({ email }) => email)).toEqual(["author-0@example.com", "author-1@example.com", "author-2@example.com", "author-3@example.com"]);
    requests[5].cancel();
    for (let index = 0; index < 1_000; index += 1) {
      requestGitAuthorAvatar(`retired-${index}@example.com`, false).cancel();
    }
    expect(gitAvatarQueueSizeForTests()).toBe(1);
    calls[0].resolve(null);
    await requests[0].promise;
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls.some(({ email }) => email === "author-5@example.com")).toBe(false);
    calls.slice(1).forEach(({ resolve }) => resolve(null));
    await Promise.all(requests.map(({ promise }) => promise));
  });
});

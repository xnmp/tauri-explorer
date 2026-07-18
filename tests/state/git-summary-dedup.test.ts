/**
 * VERIFICATION of #431 Claim 3 — shared status-scan dedup (git-summary-cache).
 * Added by verify/431-perf (adversarial).
 *
 * Claims measured here:
 *  - in-flight dedup: N concurrent consumers for the SAME repo on one
 *    git-status-changed cause exactly ONE `git_status` (gitSummary) scan.
 *  - short-TTL reuse: a passive caller arriving <1.5s after a settled scan
 *    reuses it (no new scan); a forced caller bypasses the TTL.
 *  - STALENESS ATTACK: a forced (post-mutation) caller JOINS a passive scan
 *    that is already in flight — and that in-flight scan reflects the
 *    PRE-mutation tree. Documents whether force truly observes post-mutation
 *    state (it does not, when a passive scan is mid-flight).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GitStatusSummary } from "$lib/api/files";

const gitSummaryMock = vi.fn();

vi.mock("$lib/api/files", () => ({
  gitSummary: (root: string) => gitSummaryMock(root),
}));

function summary(marker: string): { ok: true; data: GitStatusSummary } {
  return {
    ok: true,
    data: {
      is_repo: true,
      repo_root: "/repo",
      branch: "main",
      detached: false,
      staged: [{ path: marker, status: "Added", old_path: null }],
      changes: [],
      untracked: [],
      merge: [],
      op_state: "clean",
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function freshModule() {
  vi.resetModules();
  return await import("$lib/state/git-summary-cache");
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("#431 Claim 3: status-scan dedup", () => {
  it("collapses N concurrent same-repo callers into ONE git_status scan", async () => {
    const { fetchGitSummary } = await freshModule();
    const d = deferred<{ ok: true; data: GitStatusSummary }>();
    gitSummaryMock.mockReturnValue(d.promise);

    // Graph reload (passive) + SCM refresh (forced) + commit-row selection
    // (passive) all fire for the same repo on one git-status-changed.
    const a = fetchGitSummary("/repo");
    const b = fetchGitSummary("/repo", { force: true });
    const c = fetchGitSummary("/repo");
    await flush();

    expect(gitSummaryMock).toHaveBeenCalledTimes(1);
    d.resolve(summary("x.ts"));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    expect(ra.ok && ra.data.staged[0].path).toBe("x.ts");
  });

  it("reuses a settled scan within the TTL for passive callers; force bypasses it", async () => {
    vi.useFakeTimers();
    const { fetchGitSummary } = await freshModule();
    gitSummaryMock.mockResolvedValueOnce(summary("first"));
    const r1 = await fetchGitSummary("/repo");
    expect(gitSummaryMock).toHaveBeenCalledTimes(1);
    expect(r1.ok && r1.data.staged[0].path).toBe("first");

    // Passive caller 100ms later → served from TTL cache, no new scan.
    vi.advanceTimersByTime(100);
    const r2 = await fetchGitSummary("/repo");
    expect(gitSummaryMock).toHaveBeenCalledTimes(1);
    expect(r2).toBe(r1);

    // Forced caller (mutation-driven) with NOTHING in flight → bypasses TTL,
    // triggers a fresh scan.
    gitSummaryMock.mockResolvedValueOnce(summary("second"));
    const r3 = await fetchGitSummary("/repo", { force: true });
    expect(gitSummaryMock).toHaveBeenCalledTimes(2);
    expect(r3.ok && r3.data.staged[0].path).toBe("second");

    // Passive caller after TTL expiry → fresh scan.
    vi.advanceTimersByTime(2000);
    gitSummaryMock.mockResolvedValueOnce(summary("third"));
    const r4 = await fetchGitSummary("/repo");
    expect(gitSummaryMock).toHaveBeenCalledTimes(3);
    expect(r4.ok && r4.data.staged[0].path).toBe("third");
  });

  it("STALENESS: a forced post-mutation caller joins an in-flight PRE-mutation scan and receives stale data", async () => {
    const { fetchGitSummary } = await freshModule();

    // 1) A passive scan (e.g. a graph reload) starts and reads the PRE-mutation
    //    working tree — but has not resolved yet (a large-tree scan takes time).
    const preScan = deferred<{ ok: true; data: GitStatusSummary }>();
    gitSummaryMock.mockReturnValueOnce(preScan.promise);
    const passive = fetchGitSummary("/repo");
    await flush();
    expect(gitSummaryMock).toHaveBeenCalledTimes(1);

    // 2) The user stages/commits (a MUTATION). The SCM store's refresh fires a
    //    FORCED fetch to observe the post-mutation state.
    const forced = fetchGitSummary("/repo", { force: true });
    await flush();

    // The force did NOT start a second scan — it joined the in-flight one.
    expect(gitSummaryMock).toHaveBeenCalledTimes(1);

    // 3) The in-flight (pre-mutation) scan settles.
    preScan.resolve(summary("PRE-MUTATION"));
    const [rp, rf] = await Promise.all([passive, forced]);

    // The forced, post-mutation caller received the PRE-mutation snapshot.
    expect(rf).toBe(rp);
    expect(rf.ok && rf.data.staged[0].path).toBe("PRE-MUTATION");
    // Documented defect: the forced caller believed it observed post-mutation
    // state but was served a scan started before the mutation. Correction only
    // arrives via a later watcher-driven refresh.
  });
});

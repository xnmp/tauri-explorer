/**
 * #432 adversarial verification (verify/432-repro) — Claims 1 & 2.
 *
 * TESTABILITY DEFECT (reported in the verdict): the graph's reload state
 * machine (`reload`, `reloading`, `reloadDirty`, `reloadGeneration`) and its
 * watcher subscriber live as un-exported local `let`s / `$effect` closures
 * inside src/lib/components/GitGraphView.svelte. There is NO importable seam —
 * the new state/git-graph-refresh.ts bus is only the F5 fan-out, not the reload
 * loop. So claims 1 & 2 cannot be exercised against the real product code
 * headlessly.
 *
 * What this file does instead: FAITHFUL PORTS of both the pre-fix (39317a9) and
 * post-fix (dev) machines, transcribed line-for-line from the component, run
 * against a controlled/deferred fetch. This proves the *logic* the fix relies
 * on is correct AND that the pre-fix logic exhibits the claimed bug — but it is
 * verification-by-construction, not a test of the shipped component.
 *
 *   PRE-FIX  src/lib/components/GitGraphView.svelte@39317a9:484-533, 551-562, 556
 *   POST-FIX src/lib/components/GitGraphView.svelte:446-499, 578-603, 585
 */

import { describe, it, expect } from "vitest";

/** A promise whose resolution we control from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ─── Claim 1: a refresh arriving mid-load must never be dropped ──────────────

describe("#432 Claim 1 — mid-flight refresh handling", () => {
  it("PRE-FIX (skip-while-loading guard) DROPS the mid-flight refresh → lands on STALE", async () => {
    // Faithful port of loadPage + the line-561 guard `!untrack(() => loading)`.
    let loading = false;
    let commits = "";
    let fetchCount = 0;
    const fetches: Array<ReturnType<typeof deferred<string>>> = [];

    async function loadPage(): Promise<void> {
      loading = true;
      const d = deferred<string>();
      fetches.push(d);
      fetchCount++;
      try {
        commits = await d.promise;
      } finally {
        loading = false;
      }
    }
    // watcher (line 561): only reloads when NOT already loading.
    function watcherRefresh(): void {
      if (!loading) void loadPage();
    }

    void loadPage(); // initial load in flight
    watcherRefresh(); // fires mid-load → guard blocks it (the bug)
    fetches[0].resolve("STALE"); // first (only) fetch resolves with stale refs
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCount).toBe(1); // second load never issued — refresh dropped
    expect(commits).toBe("STALE"); // graph settles on pre-pull state, nothing re-triggers
  });

  it("POST-FIX (generation + dirty flag) RE-RUNS the mid-flight refresh → lands on FRESH", async () => {
    // Faithful port of reload() lines 446-499.
    let reloadGeneration = 0;
    let reloading = false;
    let reloadDirty = false;
    let commits = "";
    let fetchCount = 0;
    const fetches: Array<ReturnType<typeof deferred<string>>> = [];

    async function reload(): Promise<void> {
      if (reloading) {
        reloadDirty = true;
        return;
      }
      reloading = true;
      reloadDirty = false;
      const gen = ++reloadGeneration;
      const d = deferred<string>();
      fetches.push(d);
      fetchCount++;
      try {
        const snapshot = await d.promise;
        if (gen !== reloadGeneration) return;
        commits = snapshot;
      } finally {
        reloading = false;
        if (reloadDirty) void reload();
      }
    }

    void reload(); // initial load in flight (gen 1)
    void reload(); // watcher refresh mid-load → sets dirty, not dropped
    fetches[0].resolve("STALE"); // first fetch resolves stale …
    await Promise.resolve();
    await Promise.resolve();
    // … completion re-runs reload (gen 2); resolve THAT with fresh data.
    expect(fetches.length).toBe(2);
    fetches[1].resolve("FRESH");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchCount).toBe(2); // refresh re-ran — never dropped
    expect(commits).toBe("FRESH"); // graph lands on post-pull state
  });

  it("POST-FIX generation counter: a stale in-flight result cannot clobber a newer load", async () => {
    // Two overlapping page-0 loads (e.g. filter change): the older gen's write
    // is discarded by the `gen !== reloadGeneration` guard.
    let reloadGeneration = 0;
    let commits = "";

    async function loadGen(payload: string, settle: Promise<void>): Promise<void> {
      const gen = ++reloadGeneration;
      await settle;
      if (gen !== reloadGeneration) return; // stale result discarded
      commits = payload;
    }

    const first = deferred<void>();
    const second = deferred<void>();
    void loadGen("STALE", first.promise); // gen 1
    void loadGen("FRESH", second.promise); // gen 2 (supersedes)
    second.resolve();
    await Promise.resolve();
    first.resolve(); // stale gen-1 resolves LAST but must not win
    await Promise.resolve();
    await Promise.resolve();

    expect(commits).toBe("FRESH");
  });
});

// ─── Claim 2: every mutating action triggers exactly one reload (no echo) ─────

describe("#432 Claim 2 — no echo double-load from source:'local'", () => {
  type Change = { source: "local" | "watcher"; repoRoot?: string };

  it("PRE-FIX subscriber (no source filter) reloads on the action's own local echo → DOUBLE", () => {
    let reloads = 0;
    // Port of line 556-562 subscriber WITHOUT a source check.
    function subscriber(_change: Change): void {
      reloads++; // schedules loadPage(0) for every change, incl. local echo
    }
    // A mutating action: its own loadPage(0) (counted) + notifyLocalGitChange echo.
    reloads++; // the action's finally { await loadPage(0) }
    subscriber({ source: "local", repoRoot: "/repo" }); // the notify echo
    expect(reloads).toBe(2); // double IPC per action
  });

  it("POST-FIX subscriber filters source:'local' → EXACTLY ONE reload per action", () => {
    let reloads = 0;
    // Port of line 585: `if (change.source === "local") return;`
    function subscriber(change: Change): void {
      if (change.source === "local") return;
      reloads++;
    }
    reloads++; // the action's single direct reload()
    subscriber({ source: "local", repoRoot: "/repo" }); // echo ignored
    expect(reloads).toBe(1);

    // A genuine external (watcher) change still triggers a reload.
    subscriber({ source: "watcher", repoRoot: "/repo" });
    expect(reloads).toBe(2);
  });
});

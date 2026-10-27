/**
 * Git-graph view state stores: per-repo history filters (#342, #381, #515,
 * #529), global layout preferences (#372, #402, #458, #514, #527), the
 * single inline expansion (#221, #459) and the PR confirmation dialog
 * (#1082). Persistence is observed through an in-memory storage double.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("$lib/state/persisted", () => ({
  loadPersisted: <T>(key: string, fallback: T): T => {
    const raw = storage.get(key);
    if (raw === undefined) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  },
  savePersisted: (key: string, value: unknown) => { storage.set(key, JSON.stringify(value)); },
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: toast }));

import { createGitGraphHistoryFilter } from "$lib/state/git-graph-history-filter.svelte";
import { createGitGraphViewPrefs } from "$lib/state/git-graph-view-prefs.svelte";
import { createGitGraphExpansion } from "$lib/state/git-graph-expansion.svelte";
import { createGitGraphPrDialog } from "$lib/state/git-graph-pr-dialog.svelte";
import type { PrAction } from "$lib/api/git-log";
import type { PrSnapshot } from "$lib/state/git-pr-session.svelte";

beforeEach(() => {
  storage.clear();
  toast.error.mockClear();
});

describe("history filter", () => {
  it("starts unfiltered and restores persisted per-repo values", () => {
    expect(createGitGraphHistoryFilter("/r").active).toBe(false);
    storage.set("git-graph-branch-filter:/r", JSON.stringify(["dev"]));
    storage.set("git-graph-local-only:/r", "true");
    const filter = createGitGraphHistoryFilter("/r");
    expect(filter.branchFilter).toEqual(["dev"]);
    expect(filter.localOnly).toBe(true);
    expect(filter.hideRemoteOnly).toBe(false);
    expect(createGitGraphHistoryFilter("/other").branchFilter).toBeNull();
  });

  it("treats a malformed persisted branch filter as 'all branches'", () => {
    storage.set("git-graph-branch-filter:/r", JSON.stringify(["ok", 7]));
    expect(createGitGraphHistoryFilter("/r").branchFilter).toBeNull();
    storage.set("git-graph-branch-filter:/r", "{not json");
    expect(createGitGraphHistoryFilter("/r").branchFilter).toBeNull();
  });

  it("keeps an empty selection (none) distinct from all", () => {
    const filter = createGitGraphHistoryFilter("/r");
    filter.setBranchFilter([]);
    expect(createGitGraphHistoryFilter("/r").branchFilter).toEqual([]);
    expect(filter.active).toBe(true);
  });

  it("never persists the file-path filter", () => {
    const filter = createGitGraphHistoryFilter("/r");
    filter.setFilePath("src/a.ts");
    expect(filter.active).toBe(true);
    expect(createGitGraphHistoryFilter("/r").filePath).toBe("");
    filter.setFilePath("   ");
    expect(filter.active).toBe(false);
  });

  it("clearAll resets and persists every filter", () => {
    const filter = createGitGraphHistoryFilter("/r");
    filter.setBranchFilter(["dev"]);
    filter.toggleLocalOnly();
    filter.toggleHideRemoteOnly();
    filter.setFilePath("x");
    filter.clearAll();
    expect([filter.branchFilter, filter.localOnly, filter.hideRemoteOnly, filter.filePath]).toEqual([null, false, false, ""]);
    const reopened = createGitGraphHistoryFilter("/r");
    expect([reopened.branchFilter, reopened.localOnly, reopened.hideRemoteOnly]).toEqual([null, false, false]);
  });
});

describe("view preferences", () => {
  it("uses documented defaults", () => {
    const prefs = createGitGraphViewPrefs();
    expect(prefs.columns).toEqual({ author: true, date: true, commit: true, parent: false });
    expect(prefs.avatars).toEqual({ visible: true, gravatarEnabled: false });
    expect([prefs.showDetailMeta, prefs.muteMerges, prefs.muteBaseUpdateMerges, prefs.branchTracing])
      .toEqual([false, true, true, true]);
  });

  it("persists every toggle globally", () => {
    const prefs = createGitGraphViewPrefs();
    prefs.toggleColumn("parent");
    prefs.toggleGravatar();
    prefs.toggleMuteMerges();
    prefs.toggleBranchTracing();
    const reopened = createGitGraphViewPrefs();
    expect(reopened.columns.parent).toBe(true);
    expect(reopened.avatars.gravatarEnabled).toBe(true);
    expect(reopened.muteMerges).toBe(false);
    expect(reopened.branchTracing).toBe(false);
  });

  it("merges partial or non-object persisted values over the defaults", () => {
    storage.set("git-graph-columns", JSON.stringify({ author: false }));
    storage.set("git-graph-avatar-preferences", JSON.stringify("garbage"));
    const prefs = createGitGraphViewPrefs();
    expect(prefs.columns).toEqual({ author: false, date: true, commit: true, parent: false });
    expect(prefs.avatars).toEqual({ visible: true, gravatarEnabled: false });
  });
});

describe("inline expansion", () => {
  function fixture() {
    let selected: { oid: string } | null = null;
    let prDetail: { oid: string; pr: { number: number } } | null = null;
    const resetIfIdle = vi.fn();
    const cancelNavigation = vi.fn();
    const expansion = createGitGraphExpansion({
      detail: {
        get selected() { return selected as never; },
        select: vi.fn(async (commit: { oid: string }) => { selected = commit; }) as never,
        close: vi.fn(() => { selected = null; }),
      },
      pr: {
        get prDetail() { return prDetail as never; },
        openDetail: vi.fn(async (oid: string, pr: { number: number }) => { prDetail = { oid, pr }; }) as never,
        closeDetail: vi.fn(() => { prDetail = null; }),
      },
      commitPanel: () => ({ resetIfIdle }),
      cancelNavigation,
    });
    return { expansion, resetIfIdle, cancelNavigation, get prDetail() { return prDetail; } };
  }
  const pr = (number: number) => ({ number }) as PrSnapshot;
  const commit = (oid: string) => ({ oid }) as never;

  it("opening a PR dropdown closes commit details, and vice versa", async () => {
    const f = fixture();
    await f.expansion.selectCommit(commit("a"));
    f.expansion.detailsHeight = 120;
    expect(f.expansion.expandedOid).toBe("a");
    expect(f.expansion.expandHeight).toBe(120);

    f.expansion.togglePrDetail("b", pr(7));
    expect(f.expansion.expandedOid).toBe("b");
    expect(f.expansion.detailsHeight).toBe(0);
    expect(f.expansion.isPrDetailOpen("b", 7)).toBe(true);

    await f.expansion.selectCommit(commit("c"));
    expect(f.prDetail).toBeNull();
    expect(f.expansion.expandedOid).toBe("c");
  });

  it("toggling the open badge again closes it; another badge resets the height", () => {
    const f = fixture();
    f.expansion.togglePrDetail("b", pr(7));
    f.expansion.prDetailHeight = 90;
    f.expansion.togglePrDetail("b", pr(8));
    expect(f.expansion.isPrDetailOpen("b", 8)).toBe(true);
    expect(f.expansion.prDetailHeight).toBe(0);
    f.expansion.togglePrDetail("b", pr(8));
    expect(f.expansion.expandedOid).toBeNull();
    expect(f.expansion.expandHeight).toBe(0);
  });

  it("resetDetails does not retire navigation; closeDetails does", () => {
    const f = fixture();
    f.expansion.resetDetails();
    expect(f.cancelNavigation).not.toHaveBeenCalled();
    expect(f.resetIfIdle).toHaveBeenCalledTimes(1);
    f.expansion.closeDetails();
    expect(f.cancelNavigation).toHaveBeenCalledTimes(1);
  });

  it("selectCommit(…, false) keeps an active fork-point lookup", async () => {
    const f = fixture();
    await f.expansion.selectCommit(commit("a"), false);
    expect(f.cancelNavigation).not.toHaveBeenCalled();
  });
});

describe("PR confirmation dialog", () => {
  function session(overrides: Partial<{ busy: boolean; error: string | null; uncertain: boolean }> = {}) {
    const state = { busy: false, error: null as string | null, uncertain: false, ...overrides };
    const performAction = vi.fn(async (_request: PrAction, _checked?: boolean) => {});
    return {
      state,
      performAction,
      dialogSession: {
        get actionBusy() { return state.busy; },
        get actionError() { return state.error; },
        get actionUncertain() { return state.uncertain; },
        prepareCreate: vi.fn(async (head: string): Promise<PrAction | null> => (
          { action: "create", repoSlug: "o/r", headBranch: head, title: "", body: "", base: "" }
        )),
        performAction,
        clearActionStatus: vi.fn(),
      },
    };
  }
  const openPr = { number: 4, htmlUrl: "https://github.com/o/r/pull/4" } as PrSnapshot;

  it("opens a merge confirmation with the displayed repository identity", () => {
    const s = session();
    const dialog = createGitGraphPrDialog(s.dialogSession);
    dialog.openAction("merge", openPr);
    expect(dialog.dialog).toEqual({ action: "merge", repoSlug: "o/r", prNumber: 4, method: "squash" });
  });

  it("refuses a PR whose repository cannot be determined", () => {
    const s = session();
    const dialog = createGitGraphPrDialog(s.dialogSession);
    dialog.openAction("approve", { number: 4, htmlUrl: "https://example.com/x" } as PrSnapshot);
    expect(dialog.dialog).toBeNull();
    expect(toast.error).toHaveBeenCalled();
  });

  it("requires an explicit acknowledgement before retrying an uncertain action", async () => {
    const s = session({ uncertain: true });
    const dialog = createGitGraphPrDialog(s.dialogSession);
    dialog.openAction("approve", openPr);
    expect(dialog.blocked).toBe(true);
    await dialog.submit();
    expect(s.performAction).not.toHaveBeenCalled();

    dialog.retryAcknowledged = true;
    expect(dialog.blocked).toBe(false);
    await dialog.submit();
    expect(s.performAction).toHaveBeenCalledWith({ action: "approve", repoSlug: "o/r", prNumber: 4 }, true);
    expect(dialog.retryAcknowledged).toBe(false);
    expect(dialog.dialog).toBeNull();
  });

  it("keeps the dialog open when the action reports an error", async () => {
    const s = session();
    s.performAction.mockImplementation(async () => { s.state.error = "denied"; });
    const dialog = createGitGraphPrDialog(s.dialogSession);
    dialog.openAction("approve", openPr);
    await dialog.submit();
    expect(dialog.dialog).not.toBeNull();
  });

  it("does not open create without a checked-out branch or while busy", async () => {
    const idle = session();
    const dialog = createGitGraphPrDialog(idle.dialogSession);
    await dialog.openCreate(null);
    expect(dialog.dialog).toBeNull();
    await dialog.openCreate("feat");
    expect(dialog.dialog).toMatchObject({ action: "create", headBranch: "feat" });

    const busy = session({ busy: true });
    const blocked = createGitGraphPrDialog(busy.dialogSession);
    await blocked.openCreate("feat");
    expect(blocked.dialog).toBeNull();
  });
});

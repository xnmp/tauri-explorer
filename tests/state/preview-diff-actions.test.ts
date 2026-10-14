import { describe, expect, it, vi } from "vitest";
import { createModalOwnership } from "$lib/state/modal-ownership.svelte";
import { createPreviewDiffActions } from "$lib/state/preview-diff-actions";

function fixture(owner = "a") {
  const ownership = createModalOwnership();
  const staged: string[][] = [];
  const discarded: string[][] = [];
  const patches: string[] = [];
  const onError = vi.fn();
  const scm = {
    activeDiff: { path: "f.txt", staged: false },
    summary: { staged: [], changes: [{ path: "f.txt" }], untracked: [] },
    stage: vi.fn(async (p: string[]) => { staged.push(p); }),
    unstage: vi.fn(async () => {}),
    discard: vi.fn(async (p: string[]) => { discarded.push(p); return { ok: true }; }),
    applyPatch: vi.fn(async (p: string) => { patches.push(p); return { ok: true }; }),
    openDiff: vi.fn(),
    closeDiff: vi.fn(),
  };
  const actions = createPreviewDiffActions({
    scm: () => scm as never,
    ownerPaneId: () => owner,
    isPaneBlocked: (id) => ownership.hasPaneOpen(id),
    onError,
    confirm: () => true,
  });
  const cover = (paneId: string) =>
    ownership.register(() => {}, () => true, { scope: { paneId, token: Symbol() } });
  return { actions, scm, staged, discarded, patches, onError, cover };
}

describe("preview diff actions admission", () => {
  it("does nothing while the owning pane has a dialog open", async () => {
    const f = fixture("a");
    const release = f.cover("a");
    await f.actions.stage();
    await f.actions.unstage();
    await f.actions.discard();
    await f.actions.applyHunk("p", "stage");
    await f.actions.applyHunk("p", "discard");
    expect(f.scm.stage).not.toHaveBeenCalled();
    expect(f.scm.unstage).not.toHaveBeenCalled();
    expect(f.scm.discard).not.toHaveBeenCalled();
    expect(f.scm.applyPatch).not.toHaveBeenCalled();
    expect(f.scm.openDiff).not.toHaveBeenCalled();
    expect(f.scm.closeDiff).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    release();
    await f.actions.stage();
    expect(f.staged).toEqual([["f.txt"]]);
  });

  it("is not blocked by a dialog over a different pane", async () => {
    const f = fixture("a");
    f.cover("b");
    await f.actions.stage();
    await f.actions.discard();
    expect(f.staged).toEqual([["f.txt"]]);
    expect(f.discarded).toEqual([["f.txt"]]);
  });
});

import { describe, expect, it } from "vitest";
import {
  IDLE_RECOVERY_OPERATION,
  NO_RECOVERY_INSPECTION,
  abandonRecoveryInspection,
  beginRecoveryInspection,
  beginRecoveryOperation,
  failRecoveryInspection,
  reconcileRecoveryInspection,
  recoveryBusyId,
  recoveryInspectingId,
  recoveryInspectionError,
  recoveryInspectionGeneration,
  recoveryInspectionId,
  recoveryInspectionItem,
  settleRecoveryInspection,
  settleRecoveryOperation,
  unavailableRecoveryInspection,
} from "$lib/domain/file-recovery";
import type { FileRecoveryItem, RecoveryInspection } from "$lib/domain/file-recovery";

const item = (id: string, generation = "1"): FileRecoveryItem => ({
  id, generation, originalPath: `/a/${id}`, retainedPath: null, retainedBytes: null,
  status: "ready", message: "", actions: ["restore"],
});

describe("recovery inspection lifecycle", () => {
  it("begins loading with no previous result", () => {
    const s = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
    expect(s).toMatchObject({ kind: "loading", id: "a", generation: "1", token: 1, previous: null });
    expect(recoveryInspectingId(s)).toBe("a");
    expect(recoveryInspectionItem(s)).toBeNull();
  });

  it("settles to a ready copy of the current item at its current generation", () => {
    const loading = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
    const live = item("a", "2");
    const s = settleRecoveryInspection(loading, 1, [live]);
    expect(s).toMatchObject({ kind: "ready", id: "a", generation: "2" });
    expect(recoveryInspectionItem(s)).toEqual(live);
    expect(recoveryInspectionItem(s)).not.toBe(live);
    expect(recoveryInspectingId(s)).toBeNull();
  });

  it("clears when the item vanished from the result", () => {
    const loading = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
    expect(settleRecoveryInspection(loading, 1, [item("b")])).toBe(NO_RECOVERY_INSPECTION);
  });

  it("keeps the previous result visible while a newer probe loads, across repeated begins", () => {
    const ready = settleRecoveryInspection(beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1), 1, [item("a")]);
    const second = beginRecoveryInspection(ready, "b", "1", 2);
    expect(recoveryInspectionItem(second)?.id).toBe("a");
    expect(recoveryInspectionId(second)).toBe("b");
    const third = beginRecoveryInspection(second, "c", "1", 3);
    expect(recoveryInspectionItem(third)?.id).toBe("a");
  });

  it("drops the previous result when the last state was an error", () => {
    const failed = unavailableRecoveryInspection("gone");
    expect(recoveryInspectionItem(beginRecoveryInspection(failed, "a", "1", 1))).toBeNull();
  });

  describe("stale results return the same state", () => {
    const loadingA = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
    const items = [item("a")];

    it("late result after a newer inspect", () => {
      const newer = beginRecoveryInspection(loadingA, "a", "1", 2);
      expect(settleRecoveryInspection(newer, 1, items)).toBe(newer);
      expect(failRecoveryInspection(newer, 1, items, "x")).toBe(newer);
      expect(abandonRecoveryInspection(newer, 1)).toBe(newer);
    });

    it("late result after close/clear", () => {
      expect(settleRecoveryInspection(NO_RECOVERY_INSPECTION, 1, items)).toBe(NO_RECOVERY_INSPECTION);
      expect(failRecoveryInspection(NO_RECOVERY_INSPECTION, 1, items, "x")).toBe(NO_RECOVERY_INSPECTION);
      expect(abandonRecoveryInspection(NO_RECOVERY_INSPECTION, 1)).toBe(NO_RECOVERY_INSPECTION);
    });

    it("late result once already settled", () => {
      const ready = settleRecoveryInspection(loadingA, 1, items);
      expect(settleRecoveryInspection(ready, 1, items)).toBe(ready);
      expect(failRecoveryInspection(ready, 1, items, "x")).toBe(ready);
    });
  });

  describe("failure", () => {
    const loading = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);

    it("shows the error while the item is still at the requested generation", () => {
      const s = failRecoveryInspection(loading, 1, [item("a", "1")], "boom");
      expect(s).toEqual({ kind: "failed", id: "a", generation: "1", message: "boom" });
      expect(recoveryInspectionError(s)).toBe("boom");
      expect(recoveryInspectionItem(s)).toBeNull();
    });

    it("clears when the generation changed meanwhile", () => {
      expect(failRecoveryInspection(loading, 1, [item("a", "2")], "boom")).toBe(NO_RECOVERY_INSPECTION);
    });

    it("clears when the item vanished meanwhile", () => {
      expect(failRecoveryInspection(loading, 1, [], "boom")).toBe(NO_RECOVERY_INSPECTION);
    });

    it("abandon clears the current request", () => {
      expect(abandonRecoveryInspection(loading, 1)).toBe(NO_RECOVERY_INSPECTION);
    });
  });

  describe("unavailable request", () => {
    it("exposes only the error, with no id", () => {
      const s = unavailableRecoveryInspection("gone");
      expect(recoveryInspectionError(s)).toBe("gone");
      expect(recoveryInspectionId(s)).toBeNull();
      expect(recoveryInspectionGeneration(s)).toBeNull();
    });

    it("survives snapshots (nothing to reconcile against)", () => {
      const s = unavailableRecoveryInspection("gone");
      expect(reconcileRecoveryInspection(s, [])).toBe(s);
    });

    it("a late result of an earlier probe cannot overwrite it", () => {
      const s = unavailableRecoveryInspection("gone");
      expect(settleRecoveryInspection(s, 1, [item("a")])).toBe(s);
    });
  });

  describe("reconcile on snapshot", () => {
    const ready: RecoveryInspection = settleRecoveryInspection(
      beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1), 1, [item("a", "1")]);
    const failed: RecoveryInspection = failRecoveryInspection(
      beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1), 1, [item("a", "1")], "boom");

    it.each([["ready", ready], ["failed", failed]] as const)("%s survives the same generation", (_n, s) => {
      expect(reconcileRecoveryInspection(s, [item("a", "1"), item("b")])).toBe(s);
    });

    it.each([["ready", ready], ["failed", failed]] as const)("%s clears on generation change", (_n, s) => {
      expect(reconcileRecoveryInspection(s, [item("a", "2")])).toBe(NO_RECOVERY_INSPECTION);
    });

    it.each([["ready", ready], ["failed", failed]] as const)("%s clears when the item vanished", (_n, s) => {
      expect(reconcileRecoveryInspection(s, [])).toBe(NO_RECOVERY_INSPECTION);
    });

    it("an in-flight probe is left to settle itself", () => {
      const loading = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
      expect(reconcileRecoveryInspection(loading, [])).toBe(loading);
      expect(reconcileRecoveryInspection(NO_RECOVERY_INSPECTION, [])).toBe(NO_RECOVERY_INSPECTION);
    });
  });
});

describe("recovery resolve operation", () => {
  it("is busy for the item while resolving and idle after settling", () => {
    const op = beginRecoveryOperation("a", 1);
    expect(recoveryBusyId(op)).toBe("a");
    expect(settleRecoveryOperation(op, 1)).toBe(IDLE_RECOVERY_OPERATION);
    expect(recoveryBusyId(IDLE_RECOVERY_OPERATION)).toBeNull();
  });

  it("a stale token (superseded or already cleared) changes nothing", () => {
    const op = beginRecoveryOperation("a", 2);
    expect(settleRecoveryOperation(op, 1)).toBe(op);
    expect(settleRecoveryOperation(IDLE_RECOVERY_OPERATION, 2)).toBe(IDLE_RECOVERY_OPERATION);
  });

  it("is independent of inspection (resolve while inspecting)", () => {
    const loading = beginRecoveryInspection(NO_RECOVERY_INSPECTION, "a", "1", 1);
    const op = beginRecoveryOperation("a", 1);
    expect(recoveryInspectingId(loading)).toBe("a");
    expect(recoveryBusyId(settleRecoveryOperation(op, 1))).toBeNull();
    expect(recoveryInspectingId(loading)).toBe("a");
  });
});

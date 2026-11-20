import { describe, expect, it } from "vitest";
import { claimLaunchCrash, createCrashReportStore } from "$lib/state/crash-report.svelte";

describe("claimLaunchCrash (#1686)", () => {
  const unclean = { fileName: "crash-1700000500.txt", contents: "panic: x", kind: "unclean-exit" as const };

  it("a parked warm window never takes (and so never consumes) the report", async () => {
    const store = createCrashReportStore();
    let taken = 0;
    await claimLaunchCrash(store, async () => (taken++, unclean), false);
    expect(taken).toBe(0);
    expect(store.offered).toBeNull();
  });

  it("a foreground window takes the report and offers it", async () => {
    const store = createCrashReportStore();
    await claimLaunchCrash(store, async () => unclean, true);
    expect(store.offered).toEqual(unclean);
  });

  it("a foreground window with nothing to report offers nothing", async () => {
    const store = createCrashReportStore();
    await claimLaunchCrash(store, async () => null, true);
    expect(store.offered).toBeNull();
  });
});

const report = { fileName: "crash-1700000000.txt", contents: "panic: boom" };

describe("crash report store (#1684)", () => {
  it("moves an offered crash into the report and keeps it until detached", () => {
    const store = createCrashReportStore();
    expect(store.attachToReport()).toBeNull();
    store.offer(report);
    expect(store.offered).toEqual(report);
    expect(store.attachToReport()).toEqual(report);
    expect(store.offered).toBeNull();
    expect(store.attached).toEqual(report);
    // Reopening the dialog still finds it; a second attach is a no-op.
    expect(store.attachToReport()).toBeNull();
    expect(store.attached).toEqual(report);
    store.detach();
    expect(store.attached).toBeNull();
  });

  it("dismissing forgets the offer without attaching it", () => {
    const store = createCrashReportStore();
    store.offer(report);
    store.dismiss();
    expect(store.offered).toBeNull();
    expect(store.attached).toBeNull();
  });
});

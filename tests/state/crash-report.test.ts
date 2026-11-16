import { describe, expect, it } from "vitest";
import { createCrashReportStore } from "$lib/state/crash-report.svelte";

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

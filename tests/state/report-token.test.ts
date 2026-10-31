import { describe, expect, it, vi } from "vitest";
import { createReportTokenStore, type ReportTokenApi } from "$lib/state/report-token.svelte";
import type { ReportTokenState } from "$lib/domain/user-report-route";

function fakeApi(initial: ReportTokenState = "absent") {
  let saved: string | null = initial === "configured" ? "ghp_old" : null;
  let locked = initial === "unavailable";
  const api = {
    state: vi.fn(async (): Promise<ReportTokenState> => {
      if (locked) throw { kind: "credential_unavailable", message: "locked" };
      return saved ? "configured" : "absent";
    }),
    save: vi.fn(async (token: string) => {
      if (locked) throw { kind: "credential_unavailable", message: "OS credential storage is locked" };
      saved = token;
    }),
    clear: vi.fn(async () => { saved = null; }),
  } satisfies ReportTokenApi;
  return { api, saved: () => saved, lock: () => { locked = true; } };
}

describe("report token store (#1455)", () => {
  it("reports only whether a token is saved", async () => {
    const { api } = fakeApi("configured");
    const store = createReportTokenStore(api);
    expect(await store.refresh()).toBe("configured");
    expect(store.state).toBe("configured");
    expect(Object.values(store)).not.toContain("ghp_old");
  });

  it("saves the trimmed token and refreshes the state", async () => {
    const fake = fakeApi();
    const store = createReportTokenStore(fake.api);
    expect(await store.save("  ghp_new\n")).toBe(true);
    expect(fake.api.save).toHaveBeenCalledWith("ghp_new");
    expect(fake.saved()).toBe("ghp_new");
    expect(store.state).toBe("configured");
    expect(store.busy).toBe(false);
  });

  it("refuses an invalid token without calling the native side", async () => {
    const fake = fakeApi("configured");
    const store = createReportTokenStore(fake.api);
    expect(await store.save("not a token")).toBe(false);
    expect(fake.api.save).not.toHaveBeenCalled();
    expect(store.error).toMatch(/no spaces/);
    expect(fake.saved()).toBe("ghp_old");
  });

  it("clears the token", async () => {
    const fake = fakeApi("configured");
    const store = createReportTokenStore(fake.api);
    expect(await store.clear()).toBe(true);
    expect(store.state).toBe("absent");
  });

  it("treats a locked credential store as unavailable and surfaces save failures", async () => {
    const fake = fakeApi();
    const store = createReportTokenStore(fake.api);
    fake.lock();
    expect(await store.refresh()).toBe("unavailable");
    expect(await store.save("ghp_abc")).toBe(false);
    expect(store.error).toBe("OS credential storage is locked");
    expect(store.state).toBe("unavailable");
  });

  it("lets a later save own the state over an earlier slow refresh", async () => {
    const fake = fakeApi();
    let release!: (state: ReportTokenState) => void;
    fake.api.state.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const store = createReportTokenStore(fake.api);
    const stale = store.refresh();
    await store.save("ghp_abc");
    release("absent");
    await stale;
    expect(store.state).toBe("configured");
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutationMock } = vi.hoisted(() => ({ mutationMock: vi.fn() }));
vi.mock("$lib/api/common", () => ({
  invoke: vi.fn(),
  extractError: (error: unknown) => String(error),
  virtualPathGuard: () => null,
  dataUriToBlobUrl: () => "blob:test",
  isTauri: () => false,
}));
vi.mock("$lib/api/file-mutations", () => ({ invokeFileMutation: mutationMock }));
vi.mock("$lib/plugins/fs-providers", () => ({ providerFor: () => undefined }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: vi.fn() }));

vi.stubEnv("VITE_E2E_HOOKS", "1");
const dataset: Record<string, string> = {};
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", { documentElement: { dataset } });

const { createDirectory, renameEntry } = await import("$lib/api/files");
const { startFileMutationProbe } = await import("../../src/test-support/file-mutation-probe");

const probe = () => JSON.parse(dataset.e2eFileMutationProbe ?? "null");
const arm = (token: string, command: string, targetPath: string) =>
  window.dispatchEvent(new CustomEvent("e2e-file-mutation-probe", { detail: { token, command, targetPath } }));
const releaseToken = (token: string) =>
  window.dispatchEvent(new CustomEvent("e2e-file-mutation-release", { detail: { token } }));

describe("file mutation native E2E probe", () => {
  let session: AbortController;
  beforeEach(() => {
    for (const key of Object.keys(dataset)) delete dataset[key];
    mutationMock.mockReset().mockResolvedValue({ ok: true, data: { path: "/dir/new" } });
    session = new AbortController();
    startFileMutationProbe(session.signal);
  });
  afterEach(() => session.abort());
  afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("holds the matching successful mutation until its token is released", async () => {
    expect(dataset.e2eFileMutationProbeReady).toBe("true");
    arm("hold-1", "create_directory", "/dir");
    expect(probe()).toMatchObject({ token: "hold-1", status: "armed" });

    let settled = false;
    const creating = createDirectory("/dir", "new").then((result) => { settled = true; return result; });
    await vi.waitFor(() => expect(probe()).toMatchObject({ status: "held", resultPath: "/dir/new" }));
    releaseToken("other-token");
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseToken("hold-1");
    await expect(creating).resolves.toMatchObject({ ok: true });
    expect(probe()).toMatchObject({ token: "hold-1", status: "released", releaseReason: "test" });
  });

  it("passes through mutations that do not match the armed command and path", async () => {
    arm("hold-2", "create_directory", "/dir");
    await expect(renameEntry("/dir", "renamed")).resolves.toMatchObject({ ok: true });
    await expect(createDirectory("/other", "new")).resolves.toMatchObject({ ok: true });
    expect(probe()).toMatchObject({ token: "hold-2", status: "armed" });
  });

  it("releases a held mutation when the page session ends", async () => {
    arm("hold-3", "rename_entry", "/dir/a");
    const renaming = renameEntry("/dir/a", "b");
    await vi.waitFor(() => expect(probe()).toMatchObject({ status: "held" }));
    session.abort();
    await expect(renaming).resolves.toMatchObject({ ok: true });
    expect(dataset.e2eFileMutationProbe).toBeUndefined();
    expect(dataset.e2eFileMutationProbeReady).toBeUndefined();
    // Retired: a later arm request is ignored and mutations are not held.
    arm("hold-4", "rename_entry", "/dir/a");
    await expect(renameEntry("/dir/a", "c")).resolves.toMatchObject({ ok: true });
    expect(dataset.e2eFileMutationProbe).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { createTextSettingsController, type TextConnectionsApi } from "$lib/state/text-connections";
import type { TextConfiguration, TextResult } from "$lib/domain/text-connections";
const config = (revision = 1): TextConfiguration => ({ schemaVersion: 1, revision, enabled: true, defaultProfileId: "codex", profiles: [{ id: "codex", name: "Codex", transport: "codex-cli", model: "fixture", timeoutMs: 45000, executablePath: "" }] });
function fixture() {
  let current = config(), notify: (revision: number) => void = () => {};
  const stop = vi.fn();
  const backend: TextConnectionsApi = {
    readTextConnections: vi.fn(async () => structuredClone(current)),
    watchTextConnections: vi.fn(async receive => { notify = receive; return stop; }),
    saveTextConnections: vi.fn(async draft => { current = { ...draft, revision: current.revision + 1 }; return current; }),
    setTextCredential: vi.fn(async () => current), clearTextCredential: vi.fn(async () => current),
    checkTextConnection: vi.fn(async () => ({ available: true })),
    testTextConnection: vi.fn(async () => ({ text: "OK", context: { profileId: "codex", configurationRevision: current.revision, fingerprint: "fixture", transport: "codex-cli" as const, requestedModel: "fixture" } })),
    cancelTextConnectionTest: vi.fn(async () => {}),
  };
  const controller = createTextSettingsController(backend);
  return { controller, backend, stop, notify: (revision: number) => notify(revision), change: async (next: TextConfiguration) => { current = next; notify(next.revision); await vi.waitFor(() => expect(backend.readTextConnections).toHaveBeenCalledTimes(2)); await Promise.resolve(); } };
}
describe("language model settings coordination", () => {
  it("loads and saves with the observed CAS revision; editing never generates", async () => {
    const { controller, backend } = fixture(); await controller.start();
    controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "Renamed" })) }));
    await controller.save(); expect(backend.saveTextConnections).toHaveBeenCalledWith(expect.objectContaining({ profiles: [expect.objectContaining({ name: "Renamed" })] }), 1);
    expect(get(controller).dirty).toBe(false); expect(backend.testTextConnection).not.toHaveBeenCalled(); controller.dispose();
  });
  it("ignores its own delayed event read without clearing save feedback", async () => {
    const { controller, backend, notify } = fixture(); await controller.start();
    controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "Mine" })) }));
    let resolveRead!: (configuration: TextConfiguration) => void, resolveSave!: (configuration: TextConfiguration) => void;
    backend.readTextConnections = vi.fn(() => new Promise<TextConfiguration>(done => { resolveRead = done; }));
    backend.saveTextConnections = vi.fn(() => new Promise<TextConfiguration>(done => { resolveSave = done; }));
    const saving = controller.save(); notify(2);
    const committed = { ...config(2), profiles: config(2).profiles.map(p => ({ ...p, name: "Mine" })) };
    resolveSave(committed); await saving;
    resolveRead(committed); await Promise.resolve(); await Promise.resolve();
    expect(get(controller).status).toContain("saved"); expect(get(controller).draft?.profiles[0].name).toBe("Mine"); controller.dispose();
  });
  it("preserves dirty edits on an external committed change and blocks stale save until reload", async () => {
    const { controller, backend, change } = fixture(); await controller.start();
    controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "My draft" })) }));
    await change(config(2)); expect(get(controller).conflict).toBe(true); expect(get(controller).draft?.profiles[0].name).toBe("My draft");
    await controller.save(); expect(backend.saveTextConnections).not.toHaveBeenCalled(); await controller.reload(); expect(get(controller).draft?.revision).toBe(2); controller.dispose();
  });
  it("refreshes a newer committed event arriving before its own save response", async () => {
    const { controller, backend, change } = fixture(); await controller.start();
    controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "Mine" })) }));
    let resolve!: (configuration: TextConfiguration) => void;
    backend.saveTextConnections = vi.fn(() => new Promise<TextConfiguration>(done => { resolve = done; }));
    const saving = controller.save();
    await change({ ...config(3), profiles: config(3).profiles.map(p => ({ ...p, name: "Other window" })) });
    resolve({ ...config(2), profiles: config(2).profiles.map(p => ({ ...p, name: "Mine" })) }); await saving;
    expect(get(controller).configuration?.revision).toBe(3);
    expect(get(controller).draft?.profiles[0].name).toBe("Other window"); controller.dispose();
  });
  it("prevents deleting the enabled default and leaves disable/reselection explicit", async () => {
    const { controller } = fixture(); await controller.start(); controller.deleteProfile("codex"); expect(get(controller).draft?.profiles).toHaveLength(1);
    controller.edit(draft => ({ ...draft, enabled: false })); controller.deleteProfile("codex"); expect(get(controller).draft).toMatchObject({ enabled: false, defaultProfileId: null, profiles: [] }); controller.dispose();
  });
  it("keeps failed saves editable and preserves their error", async () => {
    const { controller, backend } = fixture(); await controller.start(); controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "Retained" })) }));
    backend.saveTextConnections = vi.fn(async () => { throw { code: "storage_unavailable", message: "Store locked" }; });
    await controller.save(); expect(get(controller)).toMatchObject({ dirty: true, saving: false, error: "Store locked" }); expect(get(controller).draft?.profiles[0].name).toBe("Retained"); controller.dispose();
  });
  it("checks locally and does not call the paid generation command", async () => {
    const { controller, backend } = fixture(); await controller.start(); await controller.run("check"); expect(get(controller).status).toContain("not been tested"); expect(backend.testTextConnection).not.toHaveBeenCalled(); controller.dispose();
  });
  it("cancels owned generation and suppresses a late reply after edits", async () => {
    const { controller, backend } = fixture(); await controller.start(); let resolve!: (result: TextResult) => void;
    backend.testTextConnection = vi.fn(() => new Promise<TextResult>(done => { resolve = done; }));
    const test = controller.run("test"); controller.edit(draft => ({ ...draft, profiles: draft.profiles.map(p => ({ ...p, name: "New name" })) }));
    resolve({ text: "Old result", context: { profileId: "codex", configurationRevision: 1, fingerprint: "f", transport: "codex-cli" as const, requestedModel: "fixture" } }); await test;
    expect(backend.cancelTextConnectionTest).toHaveBeenCalledOnce(); expect(get(controller).status).toBeNull(); expect(get(controller).pending).toBeNull(); controller.dispose();
  });
  it("rejects generation responses from another revision", async () => {
    const { controller, backend } = fixture(); await controller.start(); backend.testTextConnection = vi.fn(async () => ({ text: "Stale", context: { profileId: "codex", configurationRevision: 9, fingerprint: "f", transport: "codex-cli" as const, requestedModel: "fixture" } }));
    await controller.run("test"); expect(get(controller).error).toContain("Settings changed"); expect(get(controller).status).toBeNull(); controller.dispose();
  });
  it("does not publish a late loading error after disposal", async () => {
    const { controller, backend } = fixture(); let reject!: (reason: Error) => void;
    backend.readTextConnections = vi.fn(() => new Promise<TextConfiguration>((_, fail) => { reject = fail; }));
    const starting = controller.start(); await Promise.resolve(); await Promise.resolve();
    controller.dispose(); const stopped = get(controller);
    reject(new Error("Late storage failure")); await starting;
    expect(get(controller)).toEqual(stopped); expect(get(controller).error).toBeNull();
  });
  it("retires listener acquisition arriving after disposal", async () => {
    const { controller, backend, stop } = fixture(); let resolve!: (stop: () => void) => void;
    backend.watchTextConnections = vi.fn(() => new Promise<() => void>(done => { resolve = done; })); const start = controller.start(); controller.dispose(); resolve(stop); await start; expect(stop).toHaveBeenCalledOnce(); expect(backend.readTextConnections).not.toHaveBeenCalled();
  });
});

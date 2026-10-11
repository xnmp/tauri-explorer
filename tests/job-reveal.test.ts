import { describe, expect, it, vi } from "vitest";
import { createJobRevealController, routeJobReveal, selectWorkspaceFile, type RevealDependencies, type RevealPane } from "$lib/domain/job-reveal";
const file = { kind: "file" as const, path: "/images/out.png" };
const view = { kind: "view" as const, viewId: "trace.view", directory: "/images", targetId: "42" };
function fixture(panes: RevealPane[] = []) {
  const deps: RevealDependencies = { panes: () => panes, open: vi.fn(async () => {}), file: vi.fn(async () => "selected" as const), view: vi.fn(async () => true), fallback: vi.fn(), notify: vi.fn() };
  return deps;
}
describe("job reveal routing", () => {
  it("activates an existing folder pane across tabs", async () => {
    const pane = { tabId: "other", paneId: "right", directory: "/images" }; const deps = fixture([pane]);
    const signal = new AbortController().signal; await routeJobReveal(file, deps, signal);
    expect(deps.open).toHaveBeenCalledWith("/images", pane, signal); expect(deps.file).toHaveBeenCalledWith(file.path, signal);
  });
  it("navigates the active pane when no folder pane exists", async () => {
    const deps = fixture(); const signal = new AbortController().signal; await routeJobReveal(file, deps, signal);
    expect(deps.open).toHaveBeenCalledWith("/images", undefined, signal);
  });
  it("reports a missing file", async () => {
    const deps = fixture(); deps.file = async () => "missing"; await routeJobReveal(file, deps, new AbortController().signal);
    expect(deps.notify).toHaveBeenCalledWith("The image was moved or deleted");
  });
  it("reveals in the matching mounted plugin view", async () => {
    const wrong = { tabId: "one", paneId: "a", directory: "/images", viewId: "different" };
    const pane = { ...wrong, paneId: "b", viewId: view.viewId }; const deps = fixture([wrong, pane]); const signal = new AbortController().signal;
    await routeJobReveal(view, deps, signal);
    expect(deps.open).toHaveBeenCalledWith("/images", pane, signal); expect(deps.view).toHaveBeenCalledWith(view.viewId, "42", signal); expect(deps.fallback).not.toHaveBeenCalled();
  });
  it.each([false, "reject"])("falls back to the directory when view reveal is %s", async result => {
    const deps = fixture(); deps.view = async () => { if (result === "reject") throw new Error("Deleted"); return false; };
    await routeJobReveal(view, deps, new AbortController().signal); expect(deps.fallback).toHaveBeenCalledOnce(); expect(deps.notify).toHaveBeenCalledOnce();
  });
  it("does not fall back or notify after an aborted reveal", async () => {
    const deps = fixture(); const request = new AbortController(); deps.view = async () => { request.abort(); throw new Error("aborted"); };
    await routeJobReveal(view, deps, request.signal); expect(deps.fallback).not.toHaveBeenCalled(); expect(deps.notify).not.toHaveBeenCalled();
  });
  it("does not select after navigation was aborted", async () => {
    const deps = fixture(); const request = new AbortController(); deps.open = async () => { request.abort(); };
    await routeJobReveal(file, deps, request.signal); expect(deps.file).not.toHaveBeenCalled();
  });
});
describe("workspace file selection", () => {
  it("refreshes newly saved files and selects them", async () => {
    let available = false; const select = vi.fn(() => available);
    const result = await selectWorkspaceFile(file.path, { currentDirectory: () => "/images", current: () => true, navigate: async () => {}, refresh: async () => { available = true; }, select, capture: () => () => true });
    expect(result).toBe("selected"); expect(select).toHaveBeenLastCalledWith(file.path);
  });
  it("does not replace a selection changed during refresh", async () => {
    const select = vi.fn(() => false);
    expect(await selectWorkspaceFile(file.path, { currentDirectory: () => "/images", current: () => true, navigate: async () => {}, refresh: async () => {}, select, capture: () => () => false })).toBe("aborted");
    expect(select).toHaveBeenCalledOnce();
  });
});
describe("reveal ownership and status refresh", () => {
  it("uses a saved file returned by status instead of the stored view", async () => {
    const route = vi.fn(); const controller = createJobRevealController({ latest: async () => file, route, error: vi.fn() });
    await controller.show({ reveal: view }); expect(route.mock.calls[0][0]).toEqual(file);
  });
  it.each([undefined, { kind: "file", path: "" }, "failure"])("falls back to the stored reveal on unavailable or invalid status", async result => {
    const route = vi.fn(); const controller = createJobRevealController({ latest: async () => { if (result === "failure") throw new Error("Offline"); return result; }, route, error: vi.fn() });
    await controller.show({ reveal: view }); expect(route.mock.calls[0][0]).toEqual(view);
  });
  it("aborts delayed status on the next click and on window disposal", async () => {
    const requests: { resolve(value: unknown): void; signal: AbortSignal }[] = []; const route = vi.fn();
    const controller = createJobRevealController({ latest: (_job, signal) => new Promise(resolve => { requests.push({ resolve, signal }); }), route, error: vi.fn() });
    const first = controller.show({ reveal: view }); const second = controller.show({ reveal: file });
    expect(requests[0].signal.aborted).toBe(true); requests[0].resolve(view); requests[1].resolve(file); await Promise.all([first, second]); expect(route).toHaveBeenCalledOnce();
    const third = controller.show({ reveal: view }); controller.abort(); expect(requests[2].signal.aborted).toBe(true); requests[2].resolve(view); await third; expect(route).toHaveBeenCalledOnce();
  });
});

it("reports a missing parent folder without selecting in the previous directory", async () => {
  const deps = fixture(); deps.open = async () => false;
  await routeJobReveal(file, deps, new AbortController().signal);
  expect(deps.file).not.toHaveBeenCalled(); expect(deps.notify).toHaveBeenCalledWith("The image was moved or deleted");
});
it("workspace selection reports failed parent navigation as missing", async () => {
  expect(await selectWorkspaceFile(file.path, { currentDirectory: () => "/old", current: () => true, navigate: async () => false, refresh: async () => {}, select: () => false, capture: () => () => true })).toBe("missing");
});
it("does not report a deleted file when newer navigation is pending", async () => {
  expect(await selectWorkspaceFile(file.path, { currentDirectory: () => "/old", current: () => true, navigate: async () => false, refresh: async () => {}, select: () => false, capture: () => () => false })).toBe("aborted");
});

import { afterEach, describe, expect, it, vi } from "vitest";

const loaders = () => import("$lib/components/view-loaders.svelte");

afterEach(() => {
  vi.doUnmock("$lib/components/ListView.svelte");
  vi.resetModules();
});

describe("view loaders", () => {
  it("shares one in-flight import per view so early preloading is joined, not repeated", async () => {
    const { loadView } = await loaders();
    const first = loadView("tiles");
    expect(loadView("tiles")).toBe(first);
    expect(loadView("list")).not.toBe(first);
    expect((await first).default).toBeTypeOf("function");
  });

  it("publishes each settled renderer, Details included, for later mounts to render directly", async () => {
    const { loadView, loadedView, viewLoadFailed } = await loaders();
    expect(loadedView("details")).toBeUndefined();
    const details = loadView("details");
    expect(loadedView("details")).toBeUndefined();
    const module = await details;
    expect(loadedView("details")).toBe(module.default);
    expect(viewLoadFailed("details")).toBe(false);
    expect(loadedView("list-columns")).toBeUndefined();
  });

  it("publishes a failed import and retries it on the next request", async () => {
    let attempts = 0;
    const Recovered = () => {};
    vi.doMock("$lib/components/ListView.svelte", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk unavailable");
      return { default: Recovered };
    });
    const { loadView, loadedView, viewLoadFailed } = await loaders();
    await expect(loadView("list")).rejects.toThrow();
    expect(viewLoadFailed("list")).toBe(true);
    expect(loadedView("list")).toBeUndefined();

    const retry = loadView("list");
    expect(viewLoadFailed("list")).toBe(false);
    expect((await retry).default).toBe(Recovered);
    expect(loadedView("list")).toBe(Recovered);
    expect(attempts).toBe(2);
  });

  it("picks the renderer for a pane configuration; Folder Peek selects List column flow and Tiles panels", async () => {
    const { viewRendererFor } = await loaders();
    expect(viewRendererFor("details", true)).toBe("details");
    expect(viewRendererFor("details", false)).toBe("details");
    expect(viewRendererFor("list", true)).toBe("list-columns");
    expect(viewRendererFor("list", false)).toBe("list");
    expect(viewRendererFor("tiles", true)).toBe("tiles-panels");
    expect(viewRendererFor("tiles", false)).toBe("tiles");
  });
});

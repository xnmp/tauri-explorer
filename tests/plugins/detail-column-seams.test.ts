/**
 * Details-column SDK seams added for AI columns (#1884): the disposer returned
 * by `registerDetailColumns`, plugin items in the column-header menu, and the
 * disposer returned by `registerCommand` (per-column palette entries).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "$lib/plugins/api";
import { detailColumnRegistry } from "$lib/plugins/detail-column-registry.svelte";
import { detailColumnMenuItems } from "$lib/plugins/detail-column-menu-registry.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { getCommand } from "$lib/state/commands.svelte";
import type { FileEntry } from "$lib/domain/file";

const file = (name: string): FileEntry => ({ name, path: `/r/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeAll(async () => { await import("$lib/plugins/register-contributions"); });

const disposers: (() => void)[] = [];
function plugin(id: string) {
  const handle = createPluginContext(id, id, disposers.length);
  disposers.push(handle.dispose);
  return handle;
}
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe("registerDetailColumns disposer", () => {
  type Load = (entries: readonly FileEntry[], signal: AbortSignal) => Promise<readonly { columns: Record<string, string> }[]>;
  const provider = (id: string, load: Load = async (entries) => entries.map(() => ({ columns: { v: "value" } }))) =>
    ({ id, columns: [{ key: "v", label: id }], applies: () => true, load });

  it("removes just that provider's column and values, leaving the plugin's others", async () => {
    const { ctx } = plugin("ai");
    const removeA = ctx.registerDetailColumns!(provider("ai.a"));
    ctx.registerDetailColumns!(provider("ai.b"));
    await settle();
    const [columnA] = detailColumnRegistry.columnsFor([file("x")]);
    detailColumnRegistry.request(file("x"), [columnA], false);
    await settle();
    expect(detailColumnRegistry.text(file("x"), columnA)).toBe("value");

    removeA();
    expect(detailColumnRegistry.columnsFor([file("x")]).map((column) => column.id)).toEqual(["ai.b:v"]);
    expect(detailColumnRegistry.text(file("x"), columnA)).toBeUndefined();
  });

  it("aborts that provider's in-flight load", async () => {
    let signal: AbortSignal | undefined;
    const { ctx } = plugin("ai");
    const remove = ctx.registerDetailColumns!(provider("ai.a", (_entries, s) => { signal = s; return new Promise<never>(() => {}); }));
    await settle();
    const [column] = detailColumnRegistry.columnsFor([file("x")]);
    detailColumnRegistry.request(file("x"), [column], false);
    await settle();
    remove();
    expect(signal?.aborted).toBe(true);
  });

  it("never registers a provider disposed before validation loaded, and frees its id", async () => {
    const { ctx } = plugin("ai");
    ctx.registerDetailColumns!(provider("ai.a"))();
    await settle();
    expect(detailColumnRegistry.columnsFor([file("x")])).toEqual([]);
    ctx.registerDetailColumns!(provider("ai.a"));
    await settle();
    expect(detailColumnRegistry.columnsFor([file("x")]).map((column) => column.id)).toEqual(["ai.a:v"]);
  });

  it("is safe to call after the plugin deactivated", async () => {
    const { ctx, dispose } = plugin("ai");
    const remove = ctx.registerDetailColumns!(provider("ai.a"));
    await settle();
    dispose();
    expect(() => remove()).not.toThrow();
  });
});

describe("suppliesLength: false (#1884)", () => {
  it("loads only while its own column is shown, and never for the Length sort", async () => {
    const load = vi.fn(async (entries: readonly FileEntry[]) => entries.map(() => ({ columns: { v: "value" } })));
    const { ctx } = plugin("ai");
    ctx.registerDetailColumns!({ id: "ai.costly", columns: [{ key: "v", label: "Costly" }], applies: () => true, load, suppliesLength: false });
    await settle();
    const [column] = detailColumnRegistry.columnsFor([file("x")]);
    detailColumnRegistry.request(file("x"), [], true);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(detailColumnRegistry.resolvers()).toHaveLength(0);
    detailColumnRegistry.request(file("x"), [column], true);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("leaves providers that may supply Length loading for it", async () => {
    const load = vi.fn(async (entries: readonly FileEntry[]) => entries.map(() => ({ lengthSeconds: 5 })));
    const { ctx } = plugin("media");
    ctx.registerDetailColumns!({ id: "media.len", columns: [{ key: "v", label: "V" }], applies: () => true, load });
    await settle();
    detailColumnRegistry.request(file("x"), [], true);
    await settle();
    expect(detailColumnRegistry.lengthSeconds(file("x"))).toBe(5);
    expect(detailColumnRegistry.resolvers()).toHaveLength(1);
  });
});

describe("registerDetailColumnMenuItem", () => {
  const labels = () => detailColumnMenuItems.items.map((item) => item.label);

  it("lists items in plugin order and removes one through its disposer", () => {
    const first = plugin("alpha");
    const second = plugin("beta");
    second.ctx.registerDetailColumnMenuItem!({ id: "beta.one", label: "Beta", run: () => {} });
    const removeAlpha = first.ctx.registerDetailColumnMenuItem!({ id: "alpha.one", label: "Alpha", run: () => {} });
    first.ctx.registerDetailColumnMenuItem!({ id: "alpha.two", label: "Alpha 2", run: () => {} });
    expect(labels()).toEqual(["Alpha", "Alpha 2", "Beta"]);
    removeAlpha();
    expect(labels()).toEqual(["Alpha 2", "Beta"]);
  });

  it("removes every item when the plugin deactivates", () => {
    const { ctx, dispose } = plugin("alpha");
    ctx.registerDetailColumnMenuItem!({ id: "alpha.one", label: "Alpha", run: () => {} });
    dispose();
    expect(labels()).toEqual([]);
  });

  it("runs the plugin's action, reporting a throw or rejection instead of propagating it", async () => {
    const toast = vi.spyOn(toastStore, "error").mockImplementation(() => 0 as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn();
    const { ctx } = plugin("alpha");
    ctx.registerDetailColumnMenuItem!({ id: "alpha.ok", label: "OK", run });
    ctx.registerDetailColumnMenuItem!({ id: "alpha.bad", label: "Bad", run: () => { throw new Error("nope"); } });
    ctx.registerDetailColumnMenuItem!({ id: "alpha.async", label: "Async", run: (() => Promise.reject(new Error("later"))) as () => void });
    const [ok, bad, rejecting] = detailColumnMenuItems.items;
    ok.run();
    expect(() => bad.run()).not.toThrow();
    expect(() => rejecting.run()).not.toThrow();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("nope"));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("later"));
    toast.mockRestore();
    error.mockRestore();
  });

  it("treats a throwing enabled() as disabled", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = plugin("alpha");
    ctx.registerDetailColumnMenuItem!({ id: "alpha.x", label: "X", run: () => {}, enabled: () => { throw new Error("boom"); } });
    ctx.registerDetailColumnMenuItem!({ id: "alpha.y", label: "Y", run: () => {}, enabled: () => true });
    const [x, y] = detailColumnMenuItems.items;
    expect(x.enabled?.()).toBe(false);
    expect(y.enabled?.()).toBe(true);
    error.mockRestore();
  });

  it("strips control characters and caps labels at 80 characters without splitting emoji", () => {
    const { ctx } = plugin("alpha");
    ctx.registerDetailColumnMenuItem!({ id: "alpha.long", label: `a\u0007b ${"😀".repeat(100)}`, run: () => {} });
    const [item] = detailColumnMenuItems.items;
    expect(item.label.startsWith("a b ")).toBe(true);
    expect([...item.label]).toHaveLength(80);
    expect(item.label).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("refuses another plugin's id and items without a label or action", () => {
    const { ctx } = plugin("alpha");
    expect(() => ctx.registerDetailColumnMenuItem!({ id: "beta.x", label: "X", run: () => {} })).toThrow(/must be named alpha\.<name>/);
    expect(() => ctx.registerDetailColumnMenuItem!({ id: "alpha.x", label: "  ", run: () => {} })).toThrow(/label/);
    expect(() => ctx.registerDetailColumnMenuItem!({ id: "alpha.x", label: "X" } as never)).toThrow(/run/);
    expect(labels()).toEqual([]);
  });
});

describe("registerCommand disposer", () => {
  it("removes just that command, leaving the plugin's others until it deactivates", () => {
    const { ctx, dispose } = plugin("alpha");
    const command = (id: string) => ({ scope: "window" as const, id, label: id, category: "plugins" as const, handler: () => {} });
    const removeOne = ctx.registerCommand(command("plugin.alpha.one"));
    ctx.registerCommand(command("plugin.alpha.two"));
    removeOne();
    expect(getCommand("plugin.alpha.one")).toBeUndefined();
    expect(getCommand("plugin.alpha.two")).toBeDefined();
    removeOne();
    expect(getCommand("plugin.alpha.two")).toBeDefined();
    dispose();
    expect(getCommand("plugin.alpha.two")).toBeUndefined();
  });
});

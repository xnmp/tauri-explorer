import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import { resolveFileView, FILE_VIEW_ELIGIBILITY_WAIT_MS, type FileViewEligibility } from "$lib/domain/file-view-resolution";
import { isFileViewId } from "$lib/domain/file-view-id";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { createOrderedRegistry } from "$lib/state/ordered-registry";
import type { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";
import type { createFileViewPresentation } from "$lib/state/file-view-presentation.svelte";

// Run the production client modules: the ordinary Vitest SSR transform drops
// effects and would miss first-render and navigation deadline regressions.
function compileClient(path: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import\s+[^;]+;/g, "")
    .replace(/export\s+\{[^}]*\}[^;]*;/g, "")
    .replaceAll("export ", "");
}

function setup(initialAnswer: FileViewEligibility = "pending", initialPreference: string | null = "trace.view") {
  vi.useFakeTimers();
  const registry = new Function("$", "createOrderedRegistry", "isFileViewId", "isVirtualPath", "resolveFileView",
    `${compileClient("../../src/lib/plugins/file-view-registry.svelte.ts")}\nreturn fileViewRegistry;`)
    (client, createOrderedRegistry, isFileViewId, isVirtualPath, resolveFileView) as typeof fileViewRegistry;
  const create = new Function("$", "fileViewRegistry", "FILE_VIEW_ELIGIBILITY_WAIT_MS",
    `${compileClient("../../src/lib/state/file-view-presentation.svelte.ts")}\nreturn createFileViewPresentation;`)
    (client, registry, FILE_VIEW_ELIGIBILITY_WAIT_MS) as typeof createFileViewPresentation;
  const directory = client.state("/pictures");
  const preference = client.state(initialPreference);
  const answer = client.state(initialAnswer);
  const register = () => registry.register("trace", {
    id: "trace.view", title: "Trace", component: (() => {}) as never,
    available: () => client.get(answer),
  });
  let presentation!: ReturnType<typeof createFileViewPresentation>;
  const dispose = client.effect_root(() => {
    presentation = create(() => client.get(directory), () => client.get(preference));
    // Mimic the renderer's initial read before the first effect flush.
    client.render_effect(() => { presentation.resolution; });
  });
  const change = (work: () => void) => client.flush(work);
  const advance = (ms: number) => change(() => vi.advanceTimersByTime(ms));
  return { registry, presentation, create, directory, preference, answer, register, dispose: () => { dispose(); presentation.dispose(); }, change, advance };
}

async function createClientExplorer(f: ReturnType<typeof setup>) {
  // Compile the production Explorer too: retain exactly the resource the pane uses.
  const source = readFileSync(new URL("../../src/lib/state/explorer.svelte.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const imports: Record<string, unknown> = {};
  for (const [, specifier] of js.matchAll(/import[^;]+from ["']([^"']+)["'];/g)) {
    if (specifier.endsWith("file-view-presentation.svelte")) { imports[specifier] = { createFileViewPresentation: f.create }; continue; }
    if (specifier.endsWith("file-view-registry.svelte")) { imports[specifier] = { fileViewRegistry: f.registry }; continue; }
    const target = specifier.startsWith("$lib/") ? new URL("../../src/lib/" + specifier.slice(5), import.meta.url).pathname
      : specifier.startsWith(".") ? new URL("../../src/lib/state/" + specifier, import.meta.url).pathname : specifier;
    imports[specifier] = await import(/* @vite-ignore */ target);
  }
  const compiled = compileModule(js, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import (\{[^}]+\}|\* as \w+) from ["']([^"']+)["'];/g, (_, names, specifier) =>
      names.startsWith("{") ? `const ${names.replaceAll(" as ", ": ")} = imports[${JSON.stringify(specifier)}];`
        : `const ${names.slice(5)} = imports[${JSON.stringify(specifier)}];`)
    .replace(/export\s+\{[^}]*\}[^;]*;/g, "").replaceAll("export ", "");
  const createExplorer = new Function("$", "imports", compiled + "\nreturn createExplorerState;")(client, imports) as typeof import("$lib/state/explorer.svelte").createExplorerState;
  const explorer = createExplorer();
  explorer.setFileView("trace.view");
  return explorer;

}

afterEach(() => vi.useRealTimers());

let listingDelay = 0;
let listingFailure = false;
vi.mock("$lib/state/directory-listing", () => ({ createDirectoryListing: () => ({
  load: async (path: string) => {
    if (listingDelay) await new Promise(resolve => setTimeout(resolve, listingDelay));
    return listingFailure ? { ok: false, error: "fixture failure" } : { ok: true, path, entries: [] };
  }, cleanup: async () => {},
}) }));

describe("pane file view paint lifetime", () => {
  it("known failed and initially disabled built-ins release while manifest discovery stalls", async () => {
    const f = setup();
    const { settingsStore } = await import("$lib/state/settings.svelte");
    const { createPluginContext } = await import("$lib/plugins/api");
    settingsStore.reset();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const builtins = [
      { id: "failure", name: "Failure", description: "", activate: () => { throw new Error("fixture failure"); } },
      { id: "disabled", name: "Disabled", description: "", enabledByDefault: false, activate: () => gate },
      { id: "hanging", name: "Hanging", description: "", activate: () => gate },
    ];
    const factory = new Function("$", "isTauri", "createPluginContext", "settingsStore", "fileViewRegistry", "BUILT_IN_PLUGINS", "pluginJobsController", "refreshInstalledPackages", "watchInstalledPackages",
      compileClient("../../src/lib/plugins/registry.svelte.ts").replace(/const BUILT_IN_PLUGINS = [^;]+;/, "") + "\nreturn createPluginRegistry;")
      (client, () => false, createPluginContext, settingsStore, f.registry, builtins, { dispose: async () => {} },
        async (_: unknown, discovered: () => void) => { await gate; discovered(); }, async () => {}) as typeof import("$lib/plugins/registry.svelte").createPluginRegistry;
    const plugins = factory(); // Production default-catalog discovery branch.
    const finishDiscovery = f.registry.beginLoading();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const initialization = plugins.initPlugins(finishDiscovery);
    try {
      f.change(() => {});
      for (const directory of ["/pictures", "/documents"]) {
        expect(f.registry.presentation("failure.view", directory, 0)).toEqual({ kind: "builtin" });
        expect(f.registry.presentation("disabled.view", directory, 0)).toEqual({ kind: "builtin" });
        expect(f.registry.presentation("hanging.view", directory, 0)).toEqual({ kind: "hold" });
        expect(f.registry.presentation("undiscovered.view", directory, 0)).toEqual({ kind: "hold" });
      }
    } finally {
      release(); await initialization; await plugins.dispose(); finishDiscovery();
      errors.mockRestore(); settingsStore.reset(); f.dispose();
    }
  });
  it("owner settlement wins over overlapping unrestricted discovery", () => {
    const f = setup();
    const finishDiscovery = f.registry.beginLoading();
    const finishTrace = f.registry.beginLoading(["trace"]);
    const finishOther = f.registry.beginLoading(["other"]);
    try {
      f.change(() => {});
      expect(f.registry.presentation("trace.view", "/pictures", 0)).toEqual({ kind: "hold" });
      finishTrace();
      for (const directory of ["/pictures", "/documents"]) {
        expect(f.registry.presentation("trace.view", directory, 0)).toEqual({ kind: "builtin" });
        expect(f.registry.presentation("other.view", directory, 0)).toEqual({ kind: "hold" });
        expect(f.registry.presentation("unknown.view", directory, 0)).toEqual({ kind: "hold" });
      }
    } finally { finishTrace(); finishOther(); finishDiscovery(); f.dispose(); }
  });

  it("failed navigation resolves eligibility for the retained directory", async () => {
    listingDelay = 0;
    const f = setup();
    f.registry.register("trace", { id: "trace.view", title: "Trace", component: (() => {}) as never,
      available: directory => directory === "/rejected",
    });
    const explorer = await createClientExplorer(f);
    try {
      await explorer.initialLoad("/pictures");
      listingFailure = true;
      await explorer.navigateTo("/rejected", { autoEnterSingleSubdir: false });
      expect(explorer.currentPath).toBe("/pictures");
      expect(explorer.error).toBe("fixture failure");
      expect(explorer.fileViewPresentation.resolution).toEqual({ kind: "builtin" });
    } finally { listingFailure = false; await explorer.destroy(); f.dispose(); }
  });
  it("hands startup discovery to owners so failure and disable release beside a hanging activation", async () => {
    const f = setup();
    const { settingsStore } = await import("$lib/state/settings.svelte");
    const { createPluginContext } = await import("$lib/plugins/api");
    settingsStore.reset();
    const factory = new Function("$", "isTauri", "createPluginContext", "settingsStore", "fileViewRegistry", "BUILT_IN_PLUGINS", "pluginJobsController",
      compileClient("../../src/lib/plugins/registry.svelte.ts").replace(/const BUILT_IN_PLUGINS = [^;]+;/, "") + "\nreturn createPluginRegistry;")
      (client, () => false, createPluginContext, settingsStore, f.registry, [], { dispose: async () => {} }) as typeof import("$lib/plugins/registry.svelte").createPluginRegistry;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const plugins = factory([
      { id: "failure", name: "Failure", description: "", activate: () => { throw new Error("fixture failure"); } },
      { id: "disabled", name: "Disabled", description: "", activate: () => gate },
      { id: "hanging", name: "Hanging", description: "", activate: () => gate },
    ]);
    const finishDiscovery = f.registry.beginLoading();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const initialization = plugins.initPlugins(finishDiscovery);
    try {
      await plugins.setEnabled("disabled", false);
      f.change(() => {});
      for (const directory of ["/pictures", "/documents"]) {
        expect(f.registry.presentation("failure.view", directory, 0)).toEqual({ kind: "builtin" });
        expect(f.registry.presentation("disabled.view", directory, 0)).toEqual({ kind: "builtin" });
        expect(f.registry.presentation("hanging.view", directory, 0)).toEqual({ kind: "hold" });
      }
    } finally {
      release(); await initialization; await plugins.dispose();
      finishDiscovery(); errors.mockRestore(); settingsStore.reset(); f.dispose();
    }
  });
  it("retains an expired scope across pane remounts with the same Explorer", async () => {
    listingDelay = 0;
    const f = setup();
    f.register();
    const explorer = await createClientExplorer(f);
    await explorer.initialLoad("/home/user");
    const mount = () => {
      let view!: ReturnType<typeof createFileViewPresentation>;
      const stop = client.effect_root(() => {
        view = explorer.fileViewPresentation ?? createForOldHost();
        client.render_effect(() => { view.resolution; });
      });
      function createForOldHost() { return f.create(() => explorer.currentPath, () => explorer.fileView); }
      return { view, stop };
    };
    let pane = mount();
    try {
      f.change(() => {}); f.advance(400);
      expect(pane.view.resolution).toEqual({ kind: "builtin" });
      for (let i = 0; i < 3; i++) {
        pane.stop(); pane = mount();
        expect(pane.view.resolution).toEqual({ kind: "builtin" });
      }
    } finally { pane.stop(); await explorer.destroy(); f.dispose(); }
  });

  it("starts the deadline before an initial listing completes", async () => {
    const f = setup();
    const finishDiscovery = f.registry.beginLoading();
    const explorer = await createClientExplorer(f);
    listingDelay = 250;
    const listing = explorer.initialLoad("/home/user");
    let view!: ReturnType<typeof createFileViewPresentation>;
    const stop = client.effect_root(() => {
      view = explorer.fileViewPresentation ?? f.create(() => explorer.currentPath, () => explorer.fileView);
      client.render_effect(() => { view.resolution; });
    });
    try {
      expect(explorer.currentPath).toBe("");
      expect(view.resolution).toEqual({ kind: "hold" });
      f.change(() => {}); f.advance(250); await listing;
      expect(view.resolution).toEqual({ kind: "hold" });
      f.advance(150);
      expect(view.resolution).toEqual({ kind: "builtin" });
    } finally { finishDiscovery(); stop(); await vi.advanceTimersByTimeAsync(250); await listing; await explorer.destroy(); f.dispose(); }
  });
  it("holds the first render, releases on an answer, and never blanks an already painted directory", () => {
    const f = setup();
    try {
      f.register();
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.change(() => {});
      f.advance(200);
      f.change(() => client.set(f.answer, true));
      expect(f.presentation.resolution).toEqual({ kind: "plugin", id: "trace.view" });
      f.change(() => client.set(f.answer, "pending"));
      expect(f.presentation.resolution).toEqual({ kind: "builtin" });
    } finally { f.dispose(); }
  });

  it("falls back at 400ms without an answer and still accepts a late answer", async () => {
    const f = setup();
    try {
      f.register(); f.change(() => {});
      f.advance(399);
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.advance(1);
      expect(f.presentation.resolution).toEqual({ kind: "builtin" });
      f.change(() => client.set(f.answer, true));
      expect(f.presentation.resolution).toEqual({ kind: "plugin", id: "trace.view" });
    } finally { f.dispose(); }
  });

  it("starts a new directory's hold synchronously and cancels the old deadline", async () => {
    const f = setup();
    try {
      f.register(); f.change(() => {}); f.advance(399);
      client.set(f.directory, "/documents");
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.change(() => {}); f.advance(1);
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.advance(399);
      expect(f.presentation.resolution).toEqual({ kind: "builtin" });
    } finally { f.dispose(); }
  });

  it("activation and eligibility share one deadline", async () => {
    const f = setup();
    const finish = f.registry.beginLoading(["trace"]);
    try {
      f.change(() => {});
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.advance(300);
      f.change(() => { f.register(); finish(); });
      f.advance(99);
      expect(f.presentation.resolution).toEqual({ kind: "hold" });
      f.advance(1);
      expect(f.presentation.resolution).toEqual({ kind: "builtin" });
    } finally { finish(); f.dispose(); }
  });

  it("explicit built-in choice bypasses a pending plugin and disposal cancels timers", async () => {
    const f = setup("pending", null);
    f.register(); f.change(() => {});
    expect(f.presentation.resolution).toEqual({ kind: "builtin" });
    f.change(() => client.set(f.preference, "trace.view"));
    expect(f.presentation.resolution).toEqual({ kind: "hold" });
    f.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
// Exercise client effects without requiring a browser/server.
import * as client from "svelte/internal/client";
import type { createModalOwnership } from "$lib/state/modal-ownership.svelte";

// Vitest's normal SSR transform omits reactive effect lifetimes. Compile the
// actual ownership module for the client so these regressions exercise Svelte's
// historical reads during cleanup, rather than a copy of the registry logic.
function ownership() {
  const source = readFileSync(new URL("../../src/lib/state/modal-ownership.svelte.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const compiled = compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replaceAll("export ", "");
  const create = new Function("$", `${compiled}\nreturn createModalOwnership;`)(client) as typeof createModalOwnership;
  return create();
}

it("closing a contributed window dialog cannot resurrect its released reservation", () => {
  const owner = ownership();
  const open = client.state(false);
  const release = owner.register(() => {});
  const dispose = client.effect_root(() => {
    client.user_effect(() => {
      if (!client.get(open)) return;
      const surface = client.untrack(() => owner.registerSurface(() => {}));
      return surface.release;
    });
  });
  try {
    client.flush(() => client.set(open, true));
    expect(owner.hasOpen).toBe(true);
    client.flush(() => { release(); client.set(open, false); });
    expect(owner.hasOpen).toBe(false);
    expect(owner.inputScope(new Event("keydown"), "a")).toBeUndefined();
  } finally { dispose(); }
});

it("Settings cleanup preserves an already mounted Plugins surface and its input ownership", () => {
  const owner = ownership();
  const opening = client.state("settings");
  let plugins: ReturnType<typeof owner.registerSurface> | undefined;
  const dispose = client.effect_root(() => {
    // WindowDialogs renders the retained Plugins component before Settings.
    client.user_effect(() => {
      if (client.get(opening) !== "plugins") return;
      const surface = client.untrack(() => owner.registerSurface(() => {}));
      plugins = surface;
      return surface.release;
    });
    client.user_effect(() => {
      if (client.get(opening) !== "settings") return;
      const settings = client.untrack(() => owner.registerSurface(() => {}));
      return settings.release;
    });
  });
  try {
    client.flush();
    client.flush(() => client.set(opening, "plugins"));
    expect(plugins?.isTop()).toBe(true);
    expect(owner.hasOpen).toBe(true);
    expect(owner.inputScope(new Event("keydown"), "a")).toBeNull();
    client.flush(() => client.set(opening, "closed"));
    expect(owner.hasOpen).toBe(false);
  } finally { dispose(); }
});

it("subscribed UI ownership follows window suspension and pane surface retirement", () => {
  const owner = ownership();
  const pane = owner.registerSurface(() => {}, undefined, undefined, { scope: { paneId: "a", token: Symbol() } });
  const rendered: boolean[][] = [];
  const dispose = client.effect_root(() => {
    client.user_effect(() => { rendered.push([owner.hasOpen, pane.isTop()]); });
  });
  try {
    client.flush();
    expect(rendered.at(-1)).toEqual([false, true]);
    const window = owner.registerSurface(() => {});
    client.flush();
    expect(rendered.at(-1)).toEqual([true, false]);
    window.release(); client.flush();
    expect(rendered.at(-1)).toEqual([false, true]);
    pane.release(); client.flush();
    expect(rendered.at(-1)).toEqual([false, false]);
  } finally { dispose(); pane.release(); }
});

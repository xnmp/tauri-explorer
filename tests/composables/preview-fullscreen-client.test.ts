import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import * as math from "$lib/domain/image-viewer-zoom";
import type { usePreviewFullscreen, PreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";
import type { modalOwnership } from "$lib/state/modal-ownership.svelte";
import type { dialogStore } from "$lib/state/dialogs.svelte";

// Run production client effects and stores; Vitest's ordinary SSR transform
// drops effects and therefore cannot establish dialog/fullscreen visibility.
function compileClient(path: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import\s+[^;]+;/g, "")
    .replaceAll("export ", "");
}

function setup() {
  const ownership = new Function("$", `${compileClient("../../src/lib/state/modal-ownership.svelte.ts")}\nreturn modalOwnership;`)
    (client) as typeof modalOwnership;
  const store = new Function("$", "modalOwnership", "openWithStore", `${compileClient("../../src/lib/state/dialogs.svelte.ts")}\nreturn dialogStore;`)
    (client, ownership, { isOpen: false }) as typeof dialogStore;
  const attrs = new Set<string>();
  const window = new EventTarget();
  const document = { documentElement: {
    setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name),
  } };
  const create = new Function("$", "math", "dialogStore", "modalOwnership", "windowTabsManager", "window", "document",
    `const { ${Object.keys(math).join(", ")} } = math;\n${compileClient("../../src/lib/composables/use-preview-fullscreen.svelte.ts")}\nreturn usePreviewFullscreen;`)
    (client, math, store, ownership, { activePaneId: "a" }, window, document) as typeof usePreviewFullscreen;
  let fullscreen!: PreviewFullscreen;
  const dispose = client.effect_root(() => { fullscreen = create(); });
  const press = (key: string) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key });
    client.flush(() => window.dispatchEvent(event));
    return event;
  };
  client.flush(() => fullscreen.toggle());
  expect(fullscreen.active).toBe(true);
  expect(attrs.has("data-preview-fullscreen")).toBe(true);
  return { ownership, store, attrs, window, fullscreen, dispose, press };
}

it("opening a dialog over the preview's pane exits fullscreen before painting and preserves dialog Escape ownership", () => {
  const f = setup();
  try {
    client.flush(() => f.ownership.register(() => {}, () => true, { scope: { paneId: "a", token: Symbol() } }));
    expect(f.fullscreen.active).toBe(false);
    expect(f.attrs.has("data-preview-fullscreen")).toBe(false);
    client.flush(() => f.fullscreen.click({ stopPropagation() {} }, true));
    expect(f.fullscreen.active).toBe(false);
    expect(f.press("Escape").defaultPrevented).toBe(false);
  } finally { f.dispose(); }
});

it("a dialog in another pane leaves fullscreen and its keyboard ownership intact", () => {
  const f = setup();
  try {
    client.flush(() => f.ownership.register(() => {}, () => true, { scope: { paneId: "b", token: Symbol() } }));
    expect(f.fullscreen.active).toBe(true);
    expect(f.attrs.has("data-preview-fullscreen")).toBe(true);
    expect(f.press("Escape").defaultPrevented).toBe(true);
    expect(f.fullscreen.active).toBe(false);
  } finally { f.dispose(); }
});

it("window Settings owns keys while fullscreen survives underneath and resumes Escape after closure", () => {
  const f = setup();
  try {
    client.flush(() => f.store.openSettings());
    expect(f.fullscreen.active).toBe(true);
    expect(f.attrs.has("data-preview-fullscreen")).toBe(true);
    for (const key of ["+", "ArrowRight", "Escape"]) {
      expect(f.press(key).defaultPrevented).toBe(false);
      expect(f.fullscreen.active).toBe(true);
      expect(f.fullscreen.zoom).toBe(1);
    }
    client.flush(() => f.store.closeSettings());
    expect(f.fullscreen.active).toBe(true);
    expect(f.attrs.has("data-preview-fullscreen")).toBe(true);
    expect(f.press("Escape").defaultPrevented).toBe(true);
    expect(f.fullscreen.active).toBe(false);
    expect(f.attrs.has("data-preview-fullscreen")).toBe(false);
  } finally { f.dispose(); }
});

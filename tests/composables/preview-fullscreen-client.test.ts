import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import * as math from "$lib/domain/image-viewer-zoom";
import type { usePreviewFullscreen, PreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";

// Run the production wrapper's client effects; Vitest's ordinary SSR transform
// drops effects and therefore cannot establish dialog/fullscreen visibility.
it("opening a pane dialog exits fullscreen before painting and preserves dialog Escape ownership", () => {
  const source = readFileSync(new URL("../../src/lib/composables/use-preview-fullscreen.svelte.ts", import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const compiled = compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import\s+\{([^}]+)\}\s+from\s+["']\$lib\/domain\/image-viewer-zoom["'];/, "const {$1} = math;")
    .replace(/import\s+\{[^}]+\}\s+from\s+["']\$lib\/state\/dialogs.svelte["'];/, "")
    .replace(/import\s+\{[^}]+\}\s+from\s+["']\$lib\/state\/window-tabs.svelte["'];/, "")
    .replaceAll("export ", "");
  const covered = client.state(false);
  const attrs = new Set<string>();
  const window = new EventTarget();
  const document = { documentElement: {
    setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name),
  } };
  const store = { isPaneBlocked: () => client.get(covered), isInputBlocked: () => client.get(covered) };
  const create = new Function("$", "math", "dialogStore", "windowTabsManager", "window", "document", `${compiled}\nreturn usePreviewFullscreen;`)
    (client, math, store, { activePaneId: "a" }, window, document) as typeof usePreviewFullscreen;
  let fullscreen!: PreviewFullscreen;
  const dispose = client.effect_root(() => { fullscreen = create(); });
  try {
    client.flush(() => fullscreen.toggle());
    expect(fullscreen.active).toBe(true);
    expect(attrs.has("data-preview-fullscreen")).toBe(true);
    client.flush(() => client.set(covered, true));
    expect(fullscreen.active).toBe(false);
    expect(attrs.has("data-preview-fullscreen")).toBe(false);
    client.flush(() => fullscreen.click({ stopPropagation() {} }));
    expect(fullscreen.active).toBe(false);
    const escape = new Event("keydown", { cancelable: true });
    Object.assign(escape, { key: "Escape" });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  } finally { dispose(); }
});

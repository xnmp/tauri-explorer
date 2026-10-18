/** Compiles rune-based state modules for Vitest's node environment, with
 * per-specifier import overrides, so Explorer peek contracts run through the
 * real explorer/session/facade sources. Shared by the folder-peek state tests. */
import * as client from "svelte/internal/client";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { readFileSync } from "node:fs";
import type { createExplorerState as CreateExplorerState } from "$lib/state/explorer.svelte";

const exportsFor: Record<string, string> = {
  "folder-peek-session.svelte": "createFolderPeekSession",
  "folder-peek.svelte": "createFolderPeekState",
  "explorer.svelte": "createExplorerState",
  "settings.svelte": "settingsStore",
  "reactive-registry.svelte": "createReactiveRegistry",
};

export async function compileClient(modulePath: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const filename = new URL("../../src/lib/state/" + modulePath + ".ts", import.meta.url);
  const javascript = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const imports: Record<string, unknown> = {};
  for (const [, specifier] of javascript.matchAll(/import[^;]+from ["']([^"']+)["'];/g)) {
    const target = specifier.startsWith("$lib/") ? new URL("../../src/lib/" + specifier.slice(5), import.meta.url).pathname
      : specifier.startsWith(".") ? new URL(specifier, filename).pathname : specifier;
    imports[specifier] = overrides[specifier] ?? (specifier === "svelte" ? { untrack: client.untrack } : await import(/* @vite-ignore */ target));
  }
  for (const [, specifier] of javascript.matchAll(/import\(["']([^"']+)["']\)/g)) {
    const target = specifier.startsWith(".") ? new URL(specifier, filename).pathname : specifier;
    imports[specifier] = overrides[specifier] ?? await import(/* @vite-ignore */ target);
  }
  const compiled = compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import (\{[^}]+\}|\* as \w+) from ["']([^"']+)["'];/g, (_, names, specifier) => names.startsWith("{") ? `const ${names.replaceAll(" as ", ": ")} = imports[${JSON.stringify(specifier)}];` : `const ${names.slice(5)} = imports[${JSON.stringify(specifier)}];`)
    .replace(/export\s+\{[^}]*\}[^;]*;/g, "").replaceAll("export ", "").replace(/import\(["']([^"']+)["']\)/g, (_, specifier) => `Promise.resolve(imports[${JSON.stringify(specifier)}])`);
  return new Function("$", "imports", compiled + `\nreturn { ${exportsFor[modulePath]} };`)(client, imports);
}

/** Vitest compiles `$lib` rune modules for SSR, where `$state` is inert. A
 * client-compiled settings store makes Explorer react to live setting changes. */
export async function compileSettings(): Promise<typeof import("$lib/state/settings.svelte").settingsStore> {
  return (await compileClient("settings.svelte")).settingsStore as typeof import("$lib/state/settings.svelte").settingsStore;
}

/** The real explorer → facade → session chain, with shared overrides (for
 * example a counting `./git-status.svelte`) applied to every layer. */
export async function compileExplorer(overrides: Record<string, unknown> = {}): Promise<typeof CreateExplorerState> {
  const session = await compileClient("folder-peek-session.svelte", overrides);
  const peek = await compileClient("folder-peek.svelte", { ...overrides, "./folder-peek-session.svelte": session });
  return (await compileClient("explorer.svelte", { ...overrides, "./folder-peek.svelte": peek })).createExplorerState as typeof CreateExplorerState;
}

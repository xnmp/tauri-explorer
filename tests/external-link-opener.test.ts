import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "$lib/domain/markdown";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/**
 * Nothing invokes `plugin:opener|…` by name, so the plugin looks unused. It is
 * not: its injected click listener is the only thing that opens
 * `target="_blank"` links in the system browser (Wry drops new-window requests).
 */
describe("external links rendered into the webview", () => {
  it("Markdown links ask for a new window, which only the opener plugin serves", () => {
    expect(renderMarkdown("[site](https://example.com)")).toContain('target="_blank"');
  });

  it("keeps the opener plugin registered and permitted", () => {
    expect(read("src-tauri/src/lib.rs")).toContain(".plugin(tauri_plugin_opener::init())");
    expect(read("src-tauri/Cargo.toml")).toMatch(/^tauri-plugin-opener\s*=/m);
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json")) as { permissions: unknown[] };
    expect(capabilities.permissions).toContain("opener:default");
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const installed = () => read("src/lib/components/InstalledPluginSettings.svelte");
const pluginSettings = () => read("src/lib/components/PluginSettings.svelte");
const buttonCss = () => read("src/lib/components/settings/settings-button.css");

/**
 * Variables the themes and the page's shared design tokens define (#1529):
 * the old package list read undefined aliases and fell back to browser chrome.
 */
function definedThemeVariables(): Set<string> {
  const themes = readdirSync(resolve(process.cwd(), "src/lib/themes")).filter(name => name.endsWith(".css"));
  const source = themes.map(name => read(`src/lib/themes/${name}`)).join("\n") + read("src/routes/+page.svelte");
  return new Set([...source.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
}

describe("Plugins menu native control chrome (#1529)", () => {
  it("renders installed packages with the shared Settings switch and row layout", () => {
    const source = installed();
    expect(source).toContain('import SettingToggle from "./settings/SettingToggle.svelte"');
    expect(source).toMatch(/<SettingToggle[\s\S]*?aria-label=\{`Enable \$\{entry\.manifest\.name\}`\}/);
    expect(source).not.toMatch(/<input[^>]*type="checkbox"/);
    expect(source).toContain('import SettingRow from "./settings/SettingRow.svelte"');
    expect(source).toMatch(/<SettingRow[^>]*class="package-row"/);
  });

  it("uses the shared settings buttons, with a danger-styled Remove", () => {
    const source = installed();
    expect(source).toContain('import "./settings/settings-button.css"');
    expect(source).toMatch(/class="settings-button"[^\n]*>Install plugin…<\/button>/);
    expect(source).toMatch(/class="settings-button danger"[\s\S]*?>Remove<\/button>/);
    expect(pluginSettings()).toMatch(/class="settings-button" onclick=\{\(\) => action\.run\(\)\}/);
  });

  it("reads only theme variables the themes define", () => {
    const defined = definedThemeVariables();
    for (const source of [installed(), buttonCss()]) {
      const used = [...source.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]);
      expect(used.filter(name => !defined.has(name))).toEqual([]);
    }
  });

  it("keeps button hover feedback immediate", () => {
    expect(buttonCss()).not.toMatch(/transition(?:-[\w-]+)?\s*:/);
  });

  it("shares one switch implementation across plugin toggles", () => {
    const source = pluginSettings();
    expect(source).toContain('import SettingToggle from "./settings/SettingToggle.svelte"');
    expect(source).not.toContain("toggle-slider");
  });
});

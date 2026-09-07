import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentRoot = resolve(process.cwd(), "src/lib/components");

function component(name: string): string {
  return readFileSync(resolve(componentRoot, name), "utf8");
}

describe("interaction styling contracts", () => {
  it("does not animate every changed property on interactive controls", () => {
    const sources = [
      "BulkRenameDialog.svelte",
      "ContentSearchDialog.svelte",
      "DetailsView.svelte",
      "FilesSidebarView.svelte",
      "JobsPanel.svelte",
      "KeybindingsSettings.svelte",
      "ProgressDialog.svelte",
      "SettingsDialog.svelte",
      "TitleBar.svelte",
      "WindowTabBar.svelte",
      "WorkspaceDialog.svelte",
      "modal.css",
    ].map(component);

    expect(sources.join("\n")).not.toMatch(/transition(?:-property)?:\s*all\b/);
  });

  it("uses active-theme semantics for move and copy drop feedback", () => {
    for (const name of ["ListView.svelte", "TilesView.svelte"]) {
      const source = component(name);
      expect(source).toContain("color-mix(in srgb, var(--accent) 15%, transparent)");
      expect(source).toContain("color-mix(in srgb, var(--system-success) 15%, transparent)");
      expect(source).toContain("box-shadow: inset 0 0 0 1px var(--system-success)");
    }
  });

  it("uses the shared semantic status variables instead of inactive aliases", () => {
    const names = [
      "GitGraphView.svelte",
      "PickerQuickOpen.svelte",
      "ProgressDialog.svelte",
      "QuickOpen.svelte",
      "ScmSidebarView.svelte",
      "UserReportDialog.svelte",
    ];
    const source = names.map(component).join("\n");

    expect(source).not.toMatch(/var\(--(?:accent-color|danger|error|success)\b/);
  });

  it("keeps selected picker details legible on theme-defined accent colors", () => {
    const source = component("PickerQuickOpen.svelte");
    expect(source).toMatch(/\.pqo-result\.active \.pqo-path\s*{[^}]*color:\s*inherit/s);
    expect(source).not.toMatch(/\.pqo-result\.active \.pqo-path\s*{[^}]*rgba\(255,\s*255,\s*255/s);
  });
});

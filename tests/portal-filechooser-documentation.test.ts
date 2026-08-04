import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const portalSelectionConfig =
  "[preferred]\norg.freedesktop.impl.portal.FileChooser=tauri-explorer";

describe("FileChooser portal enablement documentation", () => {
  it("publishes the configuration that selects Tauri Explorer as the system file picker", () => {
    const readme = readRepositoryFile("README.md");

    expect(readme).toContain("## Use as system file picker");
    expect(readme).toContain("~/.config/xdg-desktop-portal/portals.conf");
    expect(readme).toContain(portalSelectionConfig);
  });

  it("shows Arch package users the same setup after installation", () => {
    const pkgbuild = readRepositoryFile("packaging/aur/PKGBUILD");
    const postInstall = readRepositoryFile(
      "packaging/aur/tauri-explorer-bin.install",
    );

    expect(pkgbuild).toContain("install=tauri-explorer-bin.install");
    expect(postInstall).toContain("portals.conf");
    expect(postInstall).toContain(portalSelectionConfig);
    expect(postInstall).toContain("README.md");
  });
});

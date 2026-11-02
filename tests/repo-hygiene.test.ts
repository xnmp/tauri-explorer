import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readRepositoryFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("public repository hygiene", () => {
  it("groups routine Dependabot updates once per configured ecosystem", () => {
    const dependabot = readRepositoryFile(".github/dependabot.yml");
    const updates = dependabot.split(/^  - package-ecosystem: /m).slice(1);

    for (const ecosystem of ["bun", "cargo", "github-actions"]) {
      const update = updates.find((entry) => entry.startsWith(`"${ecosystem}"`));

      expect(update).toMatch(
        /groups:\n      routine-dependencies:\n        patterns:\n          - "\*"/,
      );
    }
  });

  it("uses Dependabot's bun ecosystem, which reads bun.lock (#1479)", () => {
    const dependabot = readRepositoryFile(".github/dependabot.yml");

    expect(dependabot).toMatch(/^  - package-ecosystem: "bun"\n    directory: "\/"$/m);
    expect(dependabot).not.toMatch(/package-ecosystem: "npm"/);
  });

  it("keeps zip major bumps out of the cargo Dependabot job, which renames its bzip2 feature (#1497)", () => {
    const dependabot = readRepositoryFile(".github/dependabot.yml");
    const cargo = dependabot
      .split(/^  - package-ecosystem: /m)
      .find((entry) => entry.startsWith('"cargo"'));

    expect(cargo).toMatch(
      /ignore:\n(?:\s*#.*\n)*\s*- dependency-name: "zip"\n\s*update-types: \["version-update:semver-major"\]/,
    );
    expect(readRepositoryFile("src-tauri/Cargo.toml")).toMatch(/^zip = \{ version = "2",.*"bzip2"/m);
  });

  it("declares build scripts for vendored crates with links, so manifest-only Dependabot can parse them (#1479)", () => {
    const vendorRoot = new URL("../src-tauri/vendor/", import.meta.url);
    const manifests = readdirSync(vendorRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src-tauri/vendor/${entry.name}/Cargo.toml`)
      .filter((path) => existsSync(new URL(`../${path}`, import.meta.url)));
    const linking = manifests.filter((path) =>
      /^links\s*=/m.test(readRepositoryFile(path)),
    );

    expect(linking).toContain("src-tauri/vendor/explorer-avif/Cargo.toml");
    for (const path of linking) {
      expect(readRepositoryFile(path), path).toMatch(/^build\s*=\s*"build\.rs"$/m);
    }
  });

  it("keeps committed visual proof eligible for review", () => {
    const projectRoot = new URL("../", import.meta.url);
    const result = spawnSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", "evidence/ac-proof.png"],
      { cwd: projectRoot, stdio: "ignore" },
    );

    expect(result.status).toBe(1);
  });
});

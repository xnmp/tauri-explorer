import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  hasDatedChangelogSection,
  isSemver,
  readVersions,
  type VersionSources,
} from "../scripts/bump-version.mjs";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("checked-in version sources (#1800)", () => {
  const sources: VersionSources = {
    packageJson: read("package.json"),
    cargoToml: read("src-tauri/Cargo.toml"),
    cargoLock: read("src-tauri/Cargo.lock"),
    pkgbuild: read("PKGBUILD"),
  };

  it("agree on one version: package.json, Cargo.toml, the app's Cargo.lock entry and PKGBUILD's pkgver", () => {
    const versions = readVersions(sources);
    expect(JSON.parse(sources.packageJson).version).toBe(versions.packageJson);
    expect(versions).toEqual({
      packageJson: versions.packageJson,
      cargoToml: versions.packageJson,
      cargoLock: versions.packageJson,
      pkgbuild: versions.packageJson,
    });
    expect(isSemver(versions.packageJson)).toBe(true);
  });

  it("let tauri.conf.json read its version from package.json", () => {
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBe("../package.json");
  });

  it("have a dated CHANGELOG.md section for the current version", () => {
    expect(hasDatedChangelogSection(read("CHANGELOG.md"), readVersions(sources).packageJson)).toBe(true);
  });
});

const packageJson = (version: string) =>
  `{\n  "name": "tauri-explorer",\n  "version": "${version}",\n  "devDependencies": {\n    "x": {\n    "version": "9.9.9"\n    }\n  },\n  "engines": { "node": ">=20" }\n}\n`;
const cargoToml = (version: string) =>
  `[package]\nname = "tauri-explorer"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2", features = [] }\n\n[dev-dependencies.serde]\nversion = "1"\n`;
const cargoLock = (version: string) => [
  "version = 4",
  "",
  "[[package]]",
  'name = "tauri-build"',
  'version = "2.7.1"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  "",
  "[[package]]",
  'name = "tauri-explorer"',
  `version = "${version}"`,
  "dependencies = [",
  ' "tauri-build",',
  "]",
  "",
  "[[package]]",
  'name = "tauri-explorer-plugin"',
  'version = "1.0.0"',
  "",
].join("\n");
const pkgbuild = (version: string) =>
  `pkgname=tauri-explorer\n# pkgver=0.0.1 in a comment is not the version\npkgver=${version}\npkgrel=1\npkgver() {\n  printf '%s' "\${v:-0.4.0}"\n}\n`;
const sourcesAt = (version: string): VersionSources => ({
  packageJson: packageJson(version),
  cargoToml: cargoToml(version),
  cargoLock: cargoLock(version),
  pkgbuild: pkgbuild(version),
});
const changelog = (heading: string) => `# Changelog\n\n${heading}\n\n- Notes.\n\n## v1.0.0 — 2026-01-01\n\n- Older.\n`;

describe("bumpVersion", () => {
  it("edits only each file's version token, byte for byte", () => {
    expect(bumpVersion(sourcesAt("1.0.0"), changelog("## v1.1.0 — 2026-02-03"), "1.1.0")).toEqual(sourcesAt("1.1.0"));
  });

  it("round-trips: bumping back restores the original text", () => {
    const up = bumpVersion(sourcesAt("1.0.0"), changelog("## v2.0.0-rc.1 — 2026-02-03"), "2.0.0-rc.1");
    expect(readVersions(up)).toEqual({ packageJson: "2.0.0-rc.1", cargoToml: "2.0.0-rc.1", cargoLock: "2.0.0-rc.1", pkgbuild: "2.0.0-rc.1" });
    expect(bumpVersion(up, changelog("## v1.0.0 — 2026-01-01"), "1.0.0")).toEqual(sourcesAt("1.0.0"));
  });

  it("realigns sources that drifted apart", () => {
    const drifted = { ...sourcesAt("1.0.0"), pkgbuild: pkgbuild("0.9.0") };
    expect(bumpVersion(drifted, changelog("## v1.0.1 — 2026-02-03"), "1.0.1")).toEqual(sourcesAt("1.0.1"));
  });

  it("keeps CRLF line endings in Cargo.lock", () => {
    const crlf = { ...sourcesAt("1.0.0"), cargoLock: cargoLock("1.0.0").replaceAll("\n", "\r\n") };
    expect(bumpVersion(crlf, changelog("## v1.0.1 — 2026-02-03"), "1.0.1").cargoLock)
      .toBe(cargoLock("1.0.1").replaceAll("\n", "\r\n"));
  });

  it.each([
    "v1.1.0",
    "1.1",
    "01.1.0",
    "1.1.0.0",
    "1.1.0-",
    " 1.1.0",
    "1.1.0\n",
    "",
    "latest",
    "1.1.0-rc..1",
  ])("refuses the non-SemVer version %j", (version) => {
    expect(() => bumpVersion(sourcesAt("1.0.0"), changelog(`## v${version} — 2026-02-03`), version)).toThrow(/Not a SemVer version/);
  });

  it.each([
    ["no section", "## v1.0.9 — 2026-02-03"],
    ["an undated section", "## v1.1.0"],
    ["an unparsable date", "## v1.1.0 — soon"],
    ["a section without the v prefix", "## 1.1.0 — 2026-02-03"],
    ["a prefix match of a longer version", "## v1.1.0-rc.1 — 2026-02-03"],
    ["a lower-level heading", "### v1.1.0 — 2026-02-03"],
  ])("refuses a CHANGELOG with %s", (_label, heading) => {
    expect(() => bumpVersion(sourcesAt("1.0.0"), changelog(heading), "1.1.0")).toThrow(/CHANGELOG\.md has no/);
  });

  it("refuses the version it is already at", () => {
    expect(() => bumpVersion(sourcesAt("1.0.0"), changelog("## v1.0.0 — 2026-01-01"), "1.0.0")).toThrow(/Already at version/);
  });

  it.each([
    ["package.json", { packageJson: "{}\n" }, /package\.json: expected one version, found 0/],
    ["Cargo.toml without [package]", { cargoToml: "[dependencies]\n" }, /no \[package\] section/],
    ["Cargo.toml with two package versions", { cargoToml: cargoToml("1.0.0").replace("edition", 'version = "2"\nedition') }, /Cargo\.toml: expected one version, found 2/],
    ["Cargo.lock without the app's entry", { cargoLock: cargoLock("1.0.0").replace('"tauri-explorer"', '"other"') }, /Cargo\.lock: expected one version, found 0/],
    ["PKGBUILD with two pkgver lines", { pkgbuild: `${pkgbuild("1.0.0")}pkgver=1.0.0\n` }, /PKGBUILD: expected one version, found 2/],
  ])("refuses a malformed %s", (_label, override, error) => {
    expect(() => bumpVersion({ ...sourcesAt("1.0.0"), ...override }, changelog("## v1.1.0 — 2026-02-03"), "1.1.0")).toThrow(error);
  });

  it("refuses when the first two-space version key is not package.json's own", () => {
    const nested = `{\n  "name": "x",\n  "nested": {\n  "version": "1.0.0"\n  },\n  "version": "1.0.0"\n}\n`;
    expect(() => bumpVersion({ ...sourcesAt("1.0.0"), packageJson: nested }, changelog("## v1.1.0 — 2026-02-03"), "1.1.0"))
      .toThrow(/package\.json: expected one version, found 2/);
  });

  it("handles a very long pre-release and build identifier", () => {
    const version = `1.0.0-${"a".repeat(5000)}+build.${"9".repeat(500)}`;
    expect(readVersions(bumpVersion(sourcesAt("1.0.0"), changelog(`## v${version} — 2026-02-03`), version)).cargoLock).toBe(version);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFEST_VERSION_PLACEHOLDER, VERSION_BLIND_TASKS, versionBlindManifest } from "../scripts/test-cache.mjs";

// Turborepo always hashes the root package.json, so a release bump would
// invalidate every browser shard's cached result (#1367). The browser jobs
// hash it with the version replaced by a placeholder; nothing else may change.
const manifest = (version: string) =>
  `{\n  "name": "tauri-explorer",\n  "version": "${version}",\n  "dependencies": {\n    "a": "1.0.0"\n  }\n}\n`;

describe("versionBlindManifest", () => {
  it("gives two versions of the manifest identical bytes", () => {
    expect(versionBlindManifest(manifest("1.13.2"))).toBe(versionBlindManifest(manifest("1.13.3")));
    expect(versionBlindManifest(manifest("1.13.2"))).toBe(manifest(MANIFEST_VERSION_PLACEHOLDER));
  });

  it("still distinguishes any other change", () => {
    expect(versionBlindManifest(manifest("1.0.0").replace('"1.0.0"\n  }', '"2.0.0"\n  }')))
      .not.toBe(versionBlindManifest(manifest("1.0.0")));
  });

  it("refuses to rewrite a nested version that precedes the top-level one", () => {
    const nested = '{\n  "engines": {\n    "version": "x"\n  },\n  "version": "1.0.0"\n}\n';
    expect(() => versionBlindManifest(nested)).toThrow(/top-level/);
  });

  it("leaves a manifest without a string version unchanged and rejects malformed JSON", () => {
    expect(versionBlindManifest('{ "name": "x" }')).toBe('{ "name": "x" }');
    expect(() => versionBlindManifest("{ not json")).toThrow();
  });

  it("handles the repository's own manifest", () => {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const blind = JSON.parse(versionBlindManifest(text));
    expect(blind).toEqual({ ...JSON.parse(text), version: MANIFEST_VERSION_PLACEHOLDER });
  });

  it("applies only to the browser target, whose suite reads no manifest version", () => {
    expect([...VERSION_BLIND_TASKS]).toEqual(["ci:e2e"]);
    // The mock backend reports its own version to the About dialog.
    expect(readFileSync(new URL("../src/lib/api/mock-invoke.ts", import.meta.url), "utf8"))
      .toContain('get_app_info: () => ({ version: "0.0.0-mock"');
  });
});

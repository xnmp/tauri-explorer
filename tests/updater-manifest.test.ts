/**
 * Signed self-update manifest (#1679): release.yml publishes `latest.json`
 * built from the release assets. The updater plugin rejects the whole file
 * if any entry is invalid, so the builder must fail closed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildUpdaterManifest, UPDATER_PLATFORMS, updaterSignatureProblem } from "../scripts/updater-manifest.mjs";

const TAG = "v1.26.0";
const ASSETS = [
  "tauri-explorer_1.26.0_amd64.AppImage",
  "tauri-explorer_1.26.0_amd64.deb",
  "tauri-explorer-1.26.0-1.x86_64.rpm",
  "tauri-explorer_1.26.0_x64-setup.exe",
  "tauri-explorer_1.26.0_x64_en-US.msi",
  "tauri-explorer_1.26.0_aarch64.app.tar.gz",
  "tauri-explorer_1.26.0_aarch64.dmg",
];
const SIGNED = ASSETS.filter((a) => !a.endsWith(".dmg"));
const signaturesFor = (names: string[]) => Object.fromEntries(names.map((n) => [n, `sig-of-${n}\n`]));

const build = (overrides: Partial<Parameters<typeof buildUpdaterManifest>[0]> = {}) =>
  buildUpdaterManifest({
    tag: TAG,
    repo: "xnmp/tauri-explorer",
    notes: "  Fixes things.\n",
    pubDate: "2026-11-16T10:00:00Z",
    assets: ASSETS,
    signatures: signaturesFor(SIGNED),
    ...overrides,
  });

describe("updater manifest", () => {
  it("maps every bundle-specific platform to its signed release asset", () => {
    const manifest = build();
    expect(manifest.version).toBe("1.26.0");
    expect(manifest.notes).toBe("Fixes things.");
    expect(manifest.pub_date).toBe("2026-11-16T10:00:00.000Z");
    expect(Object.keys(manifest.platforms).sort()).toEqual(UPDATER_PLATFORMS.map((p) => p.key).sort());
    expect(manifest.platforms["linux-x86_64-rpm"]).toEqual({
      signature: "sig-of-tauri-explorer-1.26.0-1.x86_64.rpm",
      url: "https://github.com/xnmp/tauri-explorer/releases/download/v1.26.0/tauri-explorer-1.26.0-1.x86_64.rpm",
    });
    expect(manifest.platforms["darwin-aarch64-app"].url).toMatch(/tauri-explorer_1\.26\.0_aarch64\.app\.tar\.gz$/);
  });

  it("never publishes generic os-arch keys that unbundled builds would match", () => {
    const keys = Object.keys(build().platforms);
    expect(keys.every((k) => k.split("-").length === 3)).toBe(true);
  });

  it("fails when a platform's signature is missing", () => {
    const signatures = signaturesFor(SIGNED.filter((a) => !a.endsWith(".msi")));
    expect(() => build({ signatures })).toThrow(/windows-x86_64-msi: missing signature/);
  });

  it("treats a blank signature file as missing", () => {
    const signatures = { ...signaturesFor(SIGNED), "tauri-explorer_1.26.0_amd64.deb": "  \n" };
    expect(() => build({ signatures })).toThrow(/linux-x86_64-deb: missing signature/);
  });

  it("fails when an asset is missing or belongs to another version", () => {
    const assets = ASSETS.map((a) => a.replace("1.26.0_amd64.AppImage", "1.25.0_amd64.AppImage"));
    expect(() => build({ assets })).toThrow(/linux-x86_64-appimage: expected exactly one asset, found none/);
  });

  it("fails on duplicate candidates rather than guessing", () => {
    const assets = [...ASSETS, "tauri-explorer-1.26.0-2.x86_64.rpm"];
    expect(() => build({ assets })).toThrow(/linux-x86_64-rpm: expected exactly one asset/);
  });

  it("reports every problem at once", () => {
    expect(() => build({ assets: [], signatures: {} })).toThrow(
      new RegExp(UPDATER_PLATFORMS.map((p) => p.key).join("[\\s\\S]*")),
    );
  });

  it("does not treat version dots as wildcards in the rpm name", () => {
    const assets = ASSETS.map((a) => (a.endsWith(".rpm") ? "tauri-explorer-1x26x0-1.x86_64.rpm" : a));
    expect(() => build({ assets })).toThrow(/linux-x86_64-rpm/);
  });

  it("rejects malformed release metadata", () => {
    expect(() => build({ tag: "latest" })).toThrow(/SemVer/);
    expect(() => build({ repo: "not a repo" })).toThrow(/repository/);
    expect(() => build({ pubDate: "yesterday" })).toThrow(/date/);
  });

  it("accepts a prerelease tag", () => {
    const assets = ASSETS.map((a) => a.replace("1.26.0", "1.26.0-rc.1"));
    const manifest = build({ tag: "v1.26.0-rc.1", assets, signatures: signaturesFor(assets) });
    expect(manifest.version).toBe("1.26.0-rc.1");
  });
});

/**
 * Fixture produced by the real tauri-cli (`cargo tauri signer generate` with a
 * throwaway key, then `cargo tauri signer sign payload.txt`); only the public
 * key is kept.
 */
describe("updater signature verification", () => {
  const fixture = (name: string) => new URL(`./fixtures/updater-signature/${name}`, import.meta.url);
  const data = readFileSync(fixture("payload.txt"));
  const signature = readFileSync(fixture("payload.txt.sig"), "utf8");
  const pubkey = readFileSync(fixture("test.key.pub"), "utf8");
  const appPubkey = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
    .plugins.updater.pubkey as string;

  /** Re-encode the signature file after editing its decoded lines. */
  const editSignature = (edit: (lines: string[]) => void) => {
    const lines = Buffer.from(signature.trim(), "base64").toString("utf8").split("\n");
    edit(lines);
    return Buffer.from(lines.join("\n")).toString("base64");
  };

  it("accepts a tauri-cli signature made with the configured key", () => {
    expect(updaterSignatureProblem({ data, signature, pubkey })).toBeNull();
  });

  it("rejects a file changed after signing", () => {
    const tampered = Buffer.concat([data, Buffer.from("x")]);
    expect(updaterSignatureProblem({ data: tampered, signature, pubkey })).toMatch(/does not match the file/);
  });

  it("rejects a signature from a key other than the one installed apps embed", () => {
    expect(updaterSignatureProblem({ data, signature, pubkey: appPubkey })).toMatch(/different key/);
  });

  it("rejects an edited trusted comment", () => {
    const edited = editSignature((lines) => {
      lines[2] = lines[2].replace("file:payload.txt", "file:other.txt");
    });
    expect(updaterSignatureProblem({ data, signature: edited, pubkey })).toMatch(/trusted comment/);
  });

  it("reports malformed signatures and keys instead of throwing", () => {
    expect(updaterSignatureProblem({ data, signature: "", pubkey })).toMatch(/minisign format/);
    expect(updaterSignatureProblem({ data, signature: "not base64 !!", pubkey })).toBeTypeOf("string");
    expect(updaterSignatureProblem({ data, signature, pubkey: "" })).toMatch(/public key/);
    const truncated = editSignature((lines) => lines.splice(2));
    expect(updaterSignatureProblem({ data, signature: truncated, pubkey })).toMatch(/minisign format/);
  });
});

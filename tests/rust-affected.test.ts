import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { crateGraph, loadRustSources, selectRust } from "../scripts/rust-affected.mjs";

// The shape `cargo metadata --format-version 1` prints, reduced to the fields
// the selector reads. `helper` is a second workspace member nothing depends on,
// so a subset is observable; `drag` -> `wry` -> app shows transitive dependents.
const ROOT = "/repo";
const id = (name: string) => `path+file://${ROOT}/${name}`;
const APP = id("src-tauri#tauri-explorer@1.0.0");
const HELPER = id("src-tauri/crates/helper#helper@0.1.0");
const WRY = id("src-tauri/vendor/wry#wry@0.1.0");
const DRAG = id("src-tauri/vendor/drag#drag@0.1.0");
const SERDE = "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0";
const metadata = {
  workspace_members: [APP, HELPER],
  packages: [
    { id: APP, name: "tauri-explorer", source: null, manifest_path: `${ROOT}/src-tauri/Cargo.toml` },
    { id: HELPER, name: "helper", source: null, manifest_path: `${ROOT}/src-tauri/crates/helper/Cargo.toml` },
    { id: WRY, name: "wry", source: null, manifest_path: `${ROOT}/src-tauri/vendor/wry/Cargo.toml` },
    { id: DRAG, name: "drag", source: null, manifest_path: `${ROOT}/src-tauri/vendor/drag/Cargo.toml` },
    { id: SERDE, name: "serde", source: "registry+https://github.com/rust-lang/crates.io-index", manifest_path: "/cargo/serde/Cargo.toml" },
  ],
  resolve: {
    nodes: [
      { id: APP, deps: [{ pkg: WRY }, { pkg: SERDE }] },
      { id: HELPER, deps: [{ pkg: SERDE }] },
      { id: WRY, deps: [{ pkg: DRAG }] },
      { id: DRAG, deps: [] },
      { id: SERDE, deps: [] },
    ],
  },
};
const sources = [
  { rel: "src-tauri/src/process_ext.rs", content: 'let png = include_bytes!("../../static/favicon.png");' },
  { rel: "src-tauri/crates/helper/src/lib.rs", content: 'include_str!("../../../../tests/contract/fixtures/git_status.json")' },
  { rel: "src-tauri/src/notes.rs", content: "// See CLAUDE.md for the policy." },
];

const select = (changed: string[], maxFiles = 50) => {
  const load = vi.fn(() => metadata);
  return { result: selectRust(changed, sources, { maxFiles, metadata: load, root: ROOT }), load };
};

describe("crateGraph", () => {
  it("keeps local packages with repo-relative directories and reverse edges", () => {
    const graph = crateGraph(metadata, ROOT);
    expect(graph.members).toEqual([APP, HELPER]);
    expect(graph.packages.map((p) => [p.name, p.dir])).toEqual([
      ["tauri-explorer", "src-tauri"],
      ["helper", "src-tauri/crates/helper"],
      ["wry", "src-tauri/vendor/wry"],
      ["drag", "src-tauri/vendor/drag"],
    ]);
    expect([...(graph.dependents.get(DRAG) ?? [])]).toEqual([WRY]);
    expect(graph.dependents.has(SERDE)).toBe(false);
  });
});

describe("selectRust", () => {
  it("tests only the touched workspace member", () => {
    expect(select(["src-tauri/crates/helper/src/lib.rs"]).result).toEqual({
      mode: "selected",
      reason: "changed crate(s) helper and their dependents",
      items: ["helper"],
    });
  });

  it("tests the workspace members that depend on a touched crate, transitively", () => {
    expect(select(["src-tauri/vendor/drag/src/lib.rs"]).result).toEqual({
      mode: "selected",
      reason: "changed crate(s) drag and their dependents",
      items: ["tauri-explorer"],
    });
  });

  it("maps an external file a Rust string literal names to the crate naming it", () => {
    expect(select(["static/favicon.png"]).result.items).toEqual(["tauri-explorer"]);
    expect(select(["tests/contract/fixtures/git_status.json"]).result.items).toEqual(["helper"]);
  });

  it("runs every member when all of them are affected", () => {
    expect(select(["src-tauri/src/lib.rs", "src-tauri/crates/helper/src/lib.rs"]).result).toEqual({
      mode: "all",
      reason: "changed crate(s) helper, tauri-explorer affect every workspace member",
      items: [],
    });
  });

  it("selects nothing, without running cargo metadata, for changes that never reach Rust", () => {
    const { result, load } = select(["src/lib/domain/zoom.ts", "CLAUDE.md", "tests/domain/zoom.test.ts"]);
    expect(result).toEqual({ mode: "none", reason: "none of 3 changed file(s) feeds a Rust crate", items: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ["src-tauri/Cargo.lock", "workspace-wide Cargo change: src-tauri/Cargo.lock"],
    ["src-tauri/Cargo.toml", "workspace-wide Cargo change: src-tauri/Cargo.toml"],
    ["rust-toolchain.toml", "workspace-wide Cargo change: rust-toolchain.toml"],
    ["src-tauri/.cargo/config.toml", "workspace-wide Cargo change: src-tauri/.cargo/config.toml"],
    ["tools/stray.rs", "Rust file outside src-tauri/: tools/stray.rs"],
    [".github/workflows/ci.yml", "CI test-selection change: .github/workflows/ci.yml"],
    ["scripts/rust-affected.mjs", "CI test-selection change: scripts/rust-affected.mjs"],
    ["src-tauri/icons/icon.unknownext", "unknown file type: src-tauri/icons/icon.unknownext"],
  ])("runs the full workspace for %s", (file, reason) => {
    const { result, load } = select(["src-tauri/crates/helper/src/lib.rs", file]);
    expect(result).toEqual({ mode: "all", reason, items: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it("runs the full workspace when more files changed than the limit", () => {
    expect(select(["src-tauri/crates/helper/src/a.rs", "src-tauri/crates/helper/src/b.rs"], 1).result).toEqual({
      mode: "all",
      reason: "2 changed files exceed the selection limit of 1",
      items: [],
    });
  });

  it("propagates a cargo metadata failure so the CLI runs everything", () => {
    expect(() =>
      selectRust(["src-tauri/src/lib.rs"], sources, { maxFiles: 50, metadata: () => { throw new Error("offline"); } }),
    ).toThrow("offline");
  });
});

describe("rust-affected against the repository", () => {
  it("finds the include_bytes! inputs outside src-tauri", () => {
    const real = loadRustSources(process.cwd());
    expect(real.some((s) => s.rel === "src-tauri/src/process_ext.rs" && s.content.includes('/favicon.png"'))).toBe(true);
    expect(real.some((s) => s.rel.startsWith("src-tauri/target/"))).toBe(false);
  });

  it("runs the full workspace when the diff cannot be computed", () => {
    const out = execFileSync("node", ["scripts/rust-affected.mjs", "--json", "no-such-ref-1175", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(JSON.parse(out)).toEqual({ mode: "all", reason: "selection failed", items: [] });
  });
});

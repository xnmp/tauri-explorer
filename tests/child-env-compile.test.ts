import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("compiles the production child environment test module without warnings", () => {
  const directory = mkdtempSync(join(tmpdir(), "child-env-compile-"));
  try {
    const source = join(directory, "probe.rs");
    // Only replace the PTY dependency: this module uses its env_remove method,
    // which std::process::Command also provides. Import the production file
    // unchanged so Rust checks the real test module's platform gates/imports.
    writeFileSync(source, `
extern crate self as portable_pty;
pub type CommandBuilder = std::process::Command;
#[path = ${JSON.stringify(resolve("src-tauri/src/child_env.rs"))}]
mod child_env;
fn main() {
    #[cfg(target_os = "linux")]
    child_env::record_app_set(vec![]);
    let mut command = CommandBuilder::new("unused");
    child_env::scrub_command(&mut command);
    child_env::scrub_pty(&mut command);
}
`);
    // Metadata needs no target linker, allowing a Linux checkout with Windows
    // rust-std installed to reproduce Windows-only lint failures too.
    const target = process.env.CHILD_ENV_TEST_TARGET;
    const result = spawnSync("rustc", [
      "--edition=2021", "--test", "--emit=metadata", "-Dwarnings",
      ...(target ? ["--target", target] : []),
      source, "-o", join(directory, "probe.rmeta"),
    ], { encoding: "utf8", timeout: 30_000 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);

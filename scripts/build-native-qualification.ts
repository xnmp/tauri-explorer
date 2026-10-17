import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  writeQualificationArtifact,
  type NativeBuildManifest,
} from "../e2e-tauri/native-qualification";

const status = Bun.spawnSync(["git", "status", "--porcelain"], {
  stdout: "pipe",
  stderr: "inherit",
});
if (status.exitCode !== 0 || status.stdout.toString().trim()) {
  throw new Error(
    "native qualification builds require a clean source worktree",
  );
}

const e2eHooks = process.env.NATIVE_QUALIFICATION_E2E_HOOKS !== "0";
const profile = process.env.NATIVE_QUALIFICATION_PROFILE ?? "debug";
if (profile !== "debug" && profile !== "release") {
  throw new Error("NATIVE_QUALIFICATION_PROFILE must be debug or release");
}
const buildCommand = ["bun", "run", "tauri", "build", "--no-bundle"];
// Explicitly select the host, so inherited Cargo build.target configuration
// cannot build a different architecture while we hash an old host binary.
const compiler = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "inherit" });
const host = compiler.stdout.toString().match(/^host: (\S+)$/m)?.[1];
if (compiler.exitCode !== 0 || !host) throw new Error("Native compiler host is unavailable");
const metadata = Bun.spawnSync(["cargo", "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--no-deps", "--format-version=1"], {
  stdout: "pipe", stderr: "inherit",
});
if (metadata.exitCode !== 0) throw new Error("Native Cargo target directory is unavailable");
const targetDirectory = (JSON.parse(metadata.stdout.toString()) as { target_directory?: string }).target_directory;
if (!targetDirectory) throw new Error("Cargo metadata omitted its target directory");
buildCommand.push("--target", host);
if (profile === "debug") buildCommand.push("--debug");
// The Rust hook gate follows the frontend one (#884): a hook build enables both.
const features = [
  ...(e2eHooks ? ["e2e-hooks"] : []),
  ...(process.platform === "win32" ? ["e2e-webview2-attach"] : []),
];
if (features.length > 0) buildCommand.push("--features", features.join(","));
const sourceCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
const startedAt = new Date().toISOString();
const child = Bun.spawn(buildCommand, {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    // Tauri invokes Cargo from src-tauri; a relative inherited target-dir can
    // otherwise differ from metadata's root-cwd resolution and hash a stale app.
    CARGO_TARGET_DIR: path.resolve(targetDirectory),
    // Explicitly override inherited hooks so provenance matches the build.
    VITE_E2E_HOOKS: e2eHooks ? "1" : "0",
    ...(process.platform === "win32" ? { VITE_E2E_NO_WARM_PRIME: "1" } : {}),
  },
});
const exitCode = await child.exited;
if (exitCode !== 0)
  throw new Error(`native qualification build exited ${exitCode}`);

const binaryName =
  process.platform === "win32" ? "tauri-explorer.exe" : "tauri-explorer";
const binary = path.resolve(targetDirectory, host, profile, binaryName);
const stat = fs.statSync(binary);
const manifest: NativeBuildManifest = {
  schemaVersion: 1,
  sourceCommit,
  profile: [
    `${profile}-custom-protocol`,
    e2eHooks ? "e2e-hooks" : "production-hooks",
    process.platform === "win32" ? "webview2-attach" : "",
  ]
    .filter(Boolean)
    .join("-"),
  buildCommand,
  startedAt,
  completedAt: new Date().toISOString(),
  binary,
  binarySha256: createHash("sha256")
    .update(fs.readFileSync(binary))
    .digest("hex"),
  binaryBytes: stat.size,
  binaryModifiedAt: stat.mtime.toISOString(),
};

writeQualificationArtifact(
  path.resolve(
    process.env.NATIVE_BUILD_MANIFEST ??
      "qualification-results/native-build.json",
  ),
  manifest,
);

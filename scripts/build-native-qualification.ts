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
if (profile === "debug") buildCommand.push("--debug");
if (process.platform === "win32") {
  buildCommand.push("--features", "e2e-webview2-attach");
}
const sourceCommit = Bun.spawnSync(["git", "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
const startedAt = new Date().toISOString();
const child = Bun.spawn(buildCommand, {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
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
const binary = path.resolve("src-tauri", "target", profile, binaryName);
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

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exactApplicationPid } from "../../e2e-tauri/native-process";

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform !== "linux")("identifies the manifest binary within its isolated profile, ignoring an identical executable elsewhere", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-process-manifest-"));
  const binary = path.join(directory, "qualified-app");
  const otherBinary = path.join(directory, "other", "qualified-app");
  const manifest = path.join(directory, "build.json");
  const profile = path.join(directory, "profile");
  fs.mkdirSync(path.dirname(otherBinary));
  for (const target of [binary, otherBinary]) fs.copyFileSync("/usr/bin/sleep", target);
  const bytes = fs.readFileSync(binary);
  fs.writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1, sourceCommit: "candidate", profile: "debug-custom-protocol-e2e-hooks",
    buildCommand: ["test-fixture"], startedAt: "2026-10-17T00:00:00Z", completedAt: "2026-10-17T00:00:01Z",
    binary, binarySha256: createHash("sha256").update(bytes).digest("hex"), binaryBytes: bytes.length,
  }));
  const children = [[binary, profile], [otherBinary, profile], [binary, `${profile}-other`]].map(([executable, config]) => {
    const child = spawn(executable, ["60"], {
      env: { ...process.env, XDG_CONFIG_HOME: config }, stdio: "ignore",
    });
    return { child, exited: once(child, "exit") };
  });
  try {
    await Promise.all(children.map(({ child }) => once(child, "spawn")));
    vi.stubEnv("NATIVE_BUILD_MANIFEST", manifest);
    expect(exactApplicationPid(profile)).toBe(children[0].child.pid);
  } finally {
    for (const { child } of children) child.kill("SIGTERM");
    await Promise.all(children.map(({ exited }) => exited));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

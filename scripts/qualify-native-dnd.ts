import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { assessDndAcceptance, assessDndNegativeControl } from "../e2e-tauri/dnd-acceptance";
import { readVerifiedNativeBuildManifest } from "../e2e-tauri/native-qualification/artifacts";

if (process.platform !== "linux") throw new Error("Native GTK DnD qualification requires Linux; other platforms are unqualified");
const usage = "Usage: bun scripts/qualify-native-dnd.ts [--full|--negative-control] [--scale=<GTK integer scale>]";
const scaleArgs = process.argv.slice(2).filter(arg => arg.startsWith("--scale="));
const args = process.argv.slice(2).filter(arg => !arg.startsWith("--scale="));
if (args.length > 1 || (args.length === 1 && !["--full", "--negative-control"].includes(args[0])) || scaleArgs.length > 1) {
  throw new Error(usage);
}
// Every other run is at scale 1, where a coordinate-space mix-up between
// logical and physical pixels is the identity (#1704). GTK3 accepts only
// integer scales; fractional desktop scales reach it rounded up.
const displayScale = scaleArgs.length ? Number(scaleArgs[0].slice("--scale=".length)) : 1;
if (!Number.isInteger(displayScale) || displayScale < 1 || displayScale > 4) throw new Error(usage);
if (!process.env.NATIVE_BUILD_MANIFEST) throw new Error("Build first with bun run build:native:qualification; NATIVE_BUILD_MANIFEST is required");
const build = readVerifiedNativeBuildManifest(process.env.NATIVE_BUILD_MANIFEST);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) {
  throw new Error("GITHUB_SHA does not match the checked-out source");
}
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
  throw new Error("Native DnD qualification requires a clean source worktree");
}
if (build.commit !== sourceCommit) throw new Error(`Native binary is from ${build.commit}, expected ${sourceCommit}`);
const runId = randomUUID();
const root = path.resolve("e2e-tauri/logs");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(path.join(root, "dnd-acceptance-"));
const negativeControl = args[0] === "--negative-control";
const suppressionReceipt = path.join(directory, "suppressed-acknowledgement.txt");
const environment = {
  ...process.env, TAURI_DND_QUALIFICATION_RUN_ID: runId, TAURI_NATIVE_CASE_OUTCOMES_DIRECTORY: directory,
  // The spec fails unless the app's devicePixelRatio matches, so a scale the
  // display stack ignored cannot report acceptance it never exercised.
  GDK_SCALE: String(displayScale), TAURI_DND_EXPECTED_SCALE: String(displayScale),
};
if (negativeControl) {
  const library = path.join(directory, "suppress-drag-status.so");
  execFileSync("cc", ["-shared", "-fPIC", "-Wall", "-Wextra", "-Werror",
    "e2e-tauri/helpers/suppress-drag-status.c", "-o", library, "-ldl"], { stdio: "inherit" });
  Object.assign(environment, {
    LD_PRELOAD: [library, process.env.LD_PRELOAD].filter(Boolean).join(":"),
    TAURI_DND_SUPPRESSED_ACK_RECEIPT: suppressionReceipt,
  });
}
const child = spawn("bunx", ["wdio", "run", "e2e-tauri/wdio.conf.ts",
  ...(args[0] === "--full" ? [] : ["--spec", "e2e-tauri/specs/file-drag.spec.ts"]),
  ...(negativeControl ? ["--mochaOpts.grep", "dnd:listing-move-details"] : []),
], {
  stdio: "inherit",
  env: environment,
});
const stop = (signal: NodeJS.Signals) => child.kill(signal);
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const status = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
process.off("SIGINT", interrupt);
process.off("SIGTERM", terminate);
let outcomes: unknown[] = [];
let evidenceError: string | null = null;
try {
  outcomes = readdirSync(directory).filter(name => /^case-outcomes-\d+\.jsonl$/.test(name))
    .flatMap(name => readFileSync(path.join(directory, name), "utf8").split("\n")
      .filter(line => line.trim()).map(line => JSON.parse(line) as unknown));
} catch (error) {
  evidenceError = `Invalid outcome evidence: ${String(error)}`;
}
const result = negativeControl
  ? assessDndNegativeControl(outcomes, runId, status, existsSync(suppressionReceipt)
    && readFileSync(suppressionReceipt, "utf8").includes("suppressed GTK destination acknowledgement"))
  : assessDndAcceptance(outcomes, runId, status);
if (evidenceError) { result.passed = false; result.errors.push(evidenceError); }
writeFileSync(path.join(directory, "acceptance.json"), JSON.stringify({
  schemaVersion: 1, runId, sourceCommit, build,
  mode: negativeControl ? "negative-control" : "acceptance",
  platform: "linux-gtk-x11", displayScale, ...result,
}, null, 2) + "\n");
console.log(`Native DnD ${negativeControl ? "negative control" : "qualification"} at GTK scale ${displayScale}: ${result.passed ? "PASS" : "FAIL"}; ${result.completed.length} required outcomes; ${directory}`);
for (const error of result.errors) console.error(error);
process.exitCode = result.passed ? 0 : 1;

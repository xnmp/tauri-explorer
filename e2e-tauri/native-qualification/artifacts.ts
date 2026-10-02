import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NativeBuildManifest, NativeQualificationReport } from "./types";

export function resolveQualificationArtifactPath(
  root: string,
  ...components: readonly string[]
): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...components);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `artifact path resolves outside qualification root: ${resolved}`,
    );
  }
  return resolved;
}

export function writeNativeQualificationReport(
  outputPath: string,
  report: NativeQualificationReport,
): void {
  writeQualificationArtifact(outputPath, report);
}

// `qualification-results/` is gitignored: CI (see windows-soak.yml) uploads
// the full report as a run artifact instead of committing it. If a report
// must be preserved in the repo as a checkpoint, commit only a small summary
// (config, timings, outcome counts, no per-sample/per-scenario arrays) plus
// the full report's SHA-256 with `git add -f`, never the full report itself
// (#894, #895).
export function writeQualificationArtifact(
  outputPath: string,
  report: unknown,
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporaryPath, outputPath);
}

export function readVerifiedNativeBuildManifest(
  manifestPath: string,
): NativeQualificationReport["build"] {
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, "utf8"),
  ) as NativeBuildManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.sourceCommit ||
    !manifest.profile ||
    !Array.isArray(manifest.buildCommand) ||
    !manifest.startedAt ||
    !manifest.completedAt
  ) {
    throw new Error(`native build manifest is incomplete: ${manifestPath}`);
  }
  const binary = path.resolve(manifest.binary);
  const stat = fs.statSync(binary);
  const actualSha256 = createHash("sha256")
    .update(fs.readFileSync(binary))
    .digest("hex");
  if (
    actualSha256 !== manifest.binarySha256 ||
    stat.size !== manifest.binaryBytes
  ) {
    throw new Error(
      `native binary does not match its build manifest: ${binary}`,
    );
  }
  return {
    commit: manifest.sourceCommit,
    profile: manifest.profile,
    binary,
    binarySha256: actualSha256,
    binaryBytes: stat.size,
    binaryModifiedAt: manifest.binaryModifiedAt,
  };
}

export function resolveNativeApplication(
  defaultApplication: string,
  env: Record<string, string | undefined>,
): string {
  return env.NATIVE_BUILD_MANIFEST
    ? readVerifiedNativeBuildManifest(env.NATIVE_BUILD_MANIFEST).binary
    : defaultApplication;
}

export function addQualificationFailureArtifact<
  T extends { failureArtifacts?: readonly string[] },
>(report: T, artifact: string): T & { failureArtifacts: string[] } {
  return {
    ...report,
    failureArtifacts: [
      ...new Set([...(report.failureArtifacts ?? []), artifact]),
    ],
  };
}

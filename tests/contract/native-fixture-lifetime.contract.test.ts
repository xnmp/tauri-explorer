/**
 * Guards the fixture-lifetime contract from #761: a native E2E spec must not
 * hand-roll `mkdtempSync` + a synchronous recursive removal of its own fixture
 * root. On Windows that root can still be open (e.g. a native directory-watch
 * handle) when the spec's `after` hook runs, so removing it while the app
 * process is alive races an EBUSY. The fix is `createNativeFixtureDirectory`
 * (e2e-tauri/native-qualification.ts), which places fixtures under a root that
 * is only removed by `onComplete`, after every worker has awaited native
 * process termination (see its doc comment).
 *
 * This is a static, text-based contract test (mirroring the existing workflow
 * contract tests in this directory) rather than a Node/WebdriverIO run: it
 * must fail fast on a spec regression without booting the native binary.
 *
 * A small number of fixtures have a real technical reason they cannot route
 * through the shared cleanup root (e.g. they must live on a specific
 * filesystem, or they are a mid-test artifact rather than the fixture root
 * itself) and are exempted with an explicit
 * `native-fixture-lifetime-allow: <reason>` comment near the removal. Search
 * for that marker to see every exemption and why it exists.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const specsDir = fileURLToPath(new URL("../../e2e-tauri/specs/", import.meta.url));
const ALLOW_MARKER = "native-fixture-lifetime-allow";
// How far back (in characters) from a flagged removal to look for the
// allowlist marker. Generous enough to cover a multi-line justification
// comment placed directly above the statement.
const ALLOW_WINDOW = 500;

interface Violation {
  file: string;
  identifier: string;
  line: number;
}

/** Identifiers bound to a directory created by a hand-rolled `mkdtempSync`,
 * i.e. NOT through `createNativeFixtureDirectory`. Matches both
 * `const x = fs.mkdtempSync(...)` and a later plain reassignment
 * `x = fs.mkdtempSync(...)`. */
function handRolledFixtureRoots(source: string): Set<string> {
  const roots = new Set<string>();
  const pattern = /\b(?:(?:const|let)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:fs\.)?mkdtempSync\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) roots.add(match[1]);
  return roots;
}

/** Recursive removals of a bare identifier: `fs.rmSync(ident, { ...,
 * recursive: true, ... })` or the `fs.rm(` promise form, across lines. */
function recursiveRemovals(source: string): { identifier: string; index: number }[] {
  const removals: { identifier: string; index: number }[] = [];
  const pattern = /fs\.rm(?:Sync)?\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}/gs;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const [, identifier, options] = match;
    if (/recursive\s*:\s*true/.test(options)) {
      removals.push({ identifier, index: match.index });
    }
  }
  return removals;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function isAllowlisted(source: string, index: number): boolean {
  const before = source.slice(Math.max(0, index - ALLOW_WINDOW), index);
  return before.includes(ALLOW_MARKER);
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const files = readdirSync(specsDir).filter((name) => name.endsWith(".spec.ts"));
  for (const file of files) {
    const source = readFileSync(path.join(specsDir, file), "utf8");
    const roots = handRolledFixtureRoots(source);
    if (roots.size === 0) continue;
    for (const { identifier, index } of recursiveRemovals(source)) {
      if (!roots.has(identifier)) continue;
      if (isAllowlisted(source, index)) continue;
      violations.push({ file, identifier, line: lineOf(source, index) });
    }
  }
  return violations;
}

describe("native fixture lifetime contract (#761)", () => {
  it("never removes a hand-rolled fixture root directly in a spec", () => {
    const violations = findViolations();
    expect(
      violations,
      violations.length > 0
        ? `Found ${violations.length} spec(s) removing a hand-rolled mkdtempSync ` +
            `fixture root directly instead of routing through ` +
            `createNativeFixtureDirectory (e2e-tauri/native-qualification.ts), or ` +
            `annotating a real exception with a "${ALLOW_MARKER}: <reason>" ` +
            `comment:\n${JSON.stringify(violations, null, 2)}`
        : undefined,
    ).toEqual([]);
  });

  it("the allowlist marker itself only appears with a reason", () => {
    const files = readdirSync(specsDir).filter((name) => name.endsWith(".spec.ts"));
    const unexplained: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(specsDir, file), "utf8");
      const markerPattern = new RegExp(`${ALLOW_MARKER}:\\s*\\S`, "g");
      const bareMarkerPattern = new RegExp(ALLOW_MARKER, "g");
      const total = source.match(bareMarkerPattern)?.length ?? 0;
      const explained = source.match(markerPattern)?.length ?? 0;
      if (explained < total) unexplained.push(file);
    }
    expect(unexplained).toEqual([]);
  });
});

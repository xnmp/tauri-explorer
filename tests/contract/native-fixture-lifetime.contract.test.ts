/** Native fixtures belong to run cleanup (or an explicitly documented external
 * harness). Guard allocation itself so wrapper-based deletion and leaked roots
 * cannot bypass the lifetime contract. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const specsDir = fileURLToPath(new URL("../../e2e-tauri/specs/", import.meta.url));
const ALLOW_MARKER = "native-fixture-lifetime-allow";
// How far back (in characters) from a fixture allocation to look for the
// allowlist marker. Generous enough to cover a multi-line justification
// comment placed directly above the statement.
const ALLOW_WINDOW = 500;

interface Violation { file: string; line: number; }

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
    for (const match of source.matchAll(/\bmkdtempSync\s*\(/g)) {
      const index = match.index!;
      if (isAllowlisted(source, index)) continue;
      violations.push({ file, line: lineOf(source, index) });
    }
  }
  return violations;
}

describe("native fixture lifetime contract (#761)", () => {
  it("requires run-owned allocation or documented external harness ownership", () => {
    const violations = findViolations();
    expect(
      violations,
      violations.length > 0
        ? `Found ${violations.length} spec(s) allocating a hand-rolled mkdtempSync ` +
            `fixture root instead of routing through ` +
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

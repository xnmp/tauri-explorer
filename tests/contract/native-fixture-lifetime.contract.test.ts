/** Native fixtures belong to run cleanup (or an explicitly documented external
 * harness). Guard allocation itself so wrapper-based deletion and leaked roots
 * cannot bypass the lifetime contract. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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

function fixtureRootDeletions(source: string, file: string): Violation[] {
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const roots = new Set<string>();
  const containsFixtureAllocation = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) &&
      /^(createNativeFixtureDirectory|createNativeSharedMemoryFixtureDirectory)$/.test(node.expression.getText(syntax))) {
      return true;
    }
    return ts.forEachChild(node, containsFixtureAllocation) ?? false;
  };
  const visit = (node: ts.Node, examine: (node: ts.Node) => void): void => {
    examine(node);
    ts.forEachChild(node, child => visit(child, examine));
  };
  visit(syntax, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      containsFixtureAllocation(node.initializer)) {
      roots.add(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) && containsFixtureAllocation(node.right)) {
      roots.add(node.left.text);
    }
  });

  const violations: Violation[] = [];
  visit(syntax, node => {
    if (!ts.isCallExpression(node) || node.arguments.length === 0 ||
      !/^(rmSync|rmdirSync)$/.test(node.expression.getText(syntax).split(".").at(-1) ?? "")) return;
    const target = node.arguments[0];
    if ((ts.isIdentifier(target) && roots.has(target.text)) || containsFixtureAllocation(target)) {
      violations.push({ file, line: lineOf(source, node.getStart(syntax)) });
    }
  });
  return violations;
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
    violations.push(...fixtureRootDeletions(source, file));
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
            `fixture root or deleting a run-owned fixture root before app teardown instead of routing through ` +
            `createNativeFixtureDirectory (e2e-tauri/native-qualification.ts), or ` +
            `annotating a real exception with a "${ALLOW_MARKER}: <reason>" ` +
            `comment:\n${JSON.stringify(violations, null, 2)}`
        : undefined,
    ).toEqual([]);
  });

  it("rejects direct deletion of an owned root while allowing deletion of a test subject inside it", () => {
    expect(fixtureRootDeletions(
      'const root = fs.realpathSync(createNativeFixtureDirectory("fixture-"));\nfs.rmSync(root);',
      "example.spec.ts",
    )).toEqual([{ file: "example.spec.ts", line: 2 }]);
    expect(fixtureRootDeletions(
      'const root = createNativeFixtureDirectory("fixture-");\nfs.rmSync(path.join(root, "subject"));',
      "example.spec.ts",
    )).toEqual([]);
    expect(fixtureRootDeletions(
      'fs.rmSync(createNativeFixtureDirectory("fixture-"), { recursive: true });',
      "example.spec.ts",
    )).toEqual([{ file: "example.spec.ts", line: 1 }]);
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

/** The shared native diagnostic writer must never mask the failure it documents. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hashedArtifactName, writeDiagnosticArtifact } from "../../e2e-tauri/diagnostics/artifact";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-artifact-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("native diagnostic artifacts", () => {
  it("writes the record as JSON, creating its directory", () => {
    const directory = path.join(scratch, "nested", "investigation");
    const written = writeDiagnosticArtifact(directory, "record.json", { label: "explorer-a" });

    expect(written).toBe(path.join(directory, "record.json"));
    expect(JSON.parse(fs.readFileSync(written!, "utf8"))).toEqual({ label: "explorer-a" });
  });

  it("returns null instead of throwing when the destination cannot be written", () => {
    const blocker = path.join(scratch, "a-file");
    fs.writeFileSync(blocker, "not a directory");

    expect(writeDiagnosticArtifact(path.join(blocker, "child"), "record.json", {})).toBeNull();
  });

  it("never turns an untrusted key into a path component (ADR 0021)", () => {
    const hostile = "../../escape/\u0000label";
    const name = hashedArtifactName(1_700, hostile, "selection-failed");

    expect(name).toMatch(/^1700-[0-9a-f]{12}-selection-failed\.json$/);
    expect(hashedArtifactName(1_700, "other", "selection-failed")).not.toBe(name);
  });
});

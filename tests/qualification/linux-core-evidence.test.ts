import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectLinuxCoreEvidence } from "../../e2e-tauri/diagnostics/linux-core-evidence";

const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linux-core-evidence-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("native core evidence", () => {
  it("retains the debugger's actual stack transcript for the matching native executable", async () => {
    const directory = fixture();
    const name = "core-WebKitWebProces-1234-1791777389";
    fs.writeFileSync(path.join(directory, name), "kernel core fixture");
    fs.writeFileSync(path.join(directory, "tauri-driver.log"), "ordinary log");
    const stack = "Program terminated with signal SIGSEGV\n#0 JSC::Heap::collect()\n";
    const debug = vi.fn().mockResolvedValue(stack);
    const records = await collectLinuxCoreEvidence({
      directory, executables: { WebKitWebProces: "/usr/lib/WebKitWebProcess" }, debug,
    });
    expect(debug).toHaveBeenCalledExactlyOnceWith("/usr/lib/WebKitWebProcess", path.join(directory, name));
    expect(records).toEqual([{
      core: name, executable: "/usr/lib/WebKitWebProcess", transcript: `${name}.txt`, error: null,
    }]);
    expect(fs.readFileSync(path.join(directory, records[0].transcript!), "utf8")).toBe(stack);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "core-index.json"), "utf8"))).toEqual(records);
    expect(fs.existsSync(path.join(directory, name))).toBe(true);
  });

  it("records debugger failure and still collects the next core without deleting native evidence", async () => {
    const directory = fixture();
    for (const name of ["core-WebKitWebProces-1234-1", "core-tauri-explorer-5678-2"])
      fs.writeFileSync(path.join(directory, name), "core");
    const debug = vi.fn().mockRejectedValueOnce(new Error("debugger failed: permission denied"))
      .mockResolvedValueOnce("native app stack");
    const records = await collectLinuxCoreEvidence({ directory,
      executables: { WebKitWebProces: "/usr/lib/WebKitWebProcess", "tauri-explorer": "/app/tauri-explorer" }, debug });
    expect(debug).toHaveBeenCalledTimes(2);
    expect(records[0].error).toContain("permission denied");
    expect(fs.readFileSync(path.join(directory, records[0].transcript!), "utf8")).toContain("permission denied");
    expect(records[1].error).toBeNull();
    expect(fs.readFileSync(path.join(directory, records[1].transcript!), "utf8")).toBe("native app stack");
    expect(fs.existsSync(path.join(directory, records[0].core))).toBe(true);
  });

  it("does not debug unrelated, unsupported or symlinked files, and handles a run with no cores", async () => {
    const directory = fixture();
    fs.writeFileSync(path.join(directory, "core-other-1234-1"), "unrelated core");
    fs.writeFileSync(path.join(directory, "core-index.json"), "old index");
    fs.symlinkSync("core-other-1234-1", path.join(directory, "core-WebKitWebProces-5678-2"));
    const debug = vi.fn();
    const records = await collectLinuxCoreEvidence({ directory, executables: {}, debug });
    expect(debug).not.toHaveBeenCalled();
    expect(records).toEqual([{
      core: "core-other-1234-1", executable: null, transcript: null, error: "No executable mapping for other",
    }]);
    expect(await collectLinuxCoreEvidence({ directory: fixture(), executables: {}, debug })).toEqual([]);
  });
});

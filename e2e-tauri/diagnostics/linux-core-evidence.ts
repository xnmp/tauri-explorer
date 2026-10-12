/** Retire-when: #1102 has a diagnosed native renderer-loss cause. */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { LinuxCoreCollectorOptions, LinuxCoreRecord } from "./linux-core-types";

/** Keep raw cores and emit a stack/index even when one debugger invocation fails. */
export async function collectLinuxCoreEvidence(options: LinuxCoreCollectorOptions): Promise<LinuxCoreRecord[]> {
  const records: LinuxCoreRecord[] = [];
  for (const file of fs.readdirSync(options.directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // %e is the kernel's (15-character) task name; %p/%t pin the crash identity.
    const match = /^core-([\w.-]+)-(\d+)-(\d+)$/.exec(file.name);
    if (!file.isFile() || !match) continue;
    const executable = options.executables[match[1]] ?? null;
    const record: LinuxCoreRecord = { core: file.name, executable, transcript: null, error: null };
    if (!executable) {
      record.error = `No executable mapping for ${match[1]}`;
    } else {
      record.transcript = `${file.name}.txt`;
      let transcript: string;
      try {
        transcript = await options.debug(executable, path.join(options.directory, file.name));
      } catch (error) {
        record.error = String(error);
        transcript = record.error;
      }
      const capturePath = path.join(options.directory, `${file.name}.capture.json`);
      if (fs.existsSync(capturePath) && JSON.parse(fs.readFileSync(capturePath, "utf8")).truncated) {
        record.error = [record.error, "Core exceeded the capture byte limit"].filter(Boolean).join("; ");
      }
      fs.writeFileSync(path.join(options.directory, record.transcript), transcript);
    }
    records.push(record);
  }
  fs.writeFileSync(path.join(options.directory, "core-index.json"), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}

const run = promisify(execFile);
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Expected a core directory followed by task-name=executable mappings");
  const executables: Record<string, string> = {};
  for (const mapping of process.argv.slice(3)) {
    const separator = mapping.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid executable mapping: ${mapping}`);
    executables[mapping.slice(0, separator)] = mapping.slice(separator + 1);
  }
  const records = await collectLinuxCoreEvidence({ directory, executables, debug: async (executable, core) => {
    try {
      const { stdout, stderr } = await run("gdb", ["-nx", "--batch", "-ex", "set debuginfod enabled off",
        "-ex", "info threads", "-ex", "thread apply all bt 40", executable, core], {
        timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      });
      return `${stdout}\n${stderr}`;
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
    }
  } });
  console.log(JSON.stringify(records));
  if (records.some(record => record.error)) process.exitCode = 1;
}

/** Linux process identity for native crash acceptance; never target unrelated apps. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function processIds(): number[] {
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number);
}

function processEnvironment(pid: number): string[] {
  try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); }
  catch { return []; }
}

export function processExecutable(pid: number): string | null {
  try { return fs.realpathSync(`/proc/${pid}/exe`); }
  catch { return null; }
}

function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
  } catch { return null; }
}

/** Linux start time distinguishes a live test process from a recycled PID. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
  } catch { return null; }
}

export function descendants(root: number): number[] {
  const parents = new Map(processIds().map(pid => [pid, parentPid(pid)]));
  const result: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [pid, ppid] of parents) {
      if (ppid !== parent || result.includes(pid)) continue;
      result.push(pid);
      queue.push(pid);
    }
  }
  return result;
}

export function exactApplicationPid(
  config = process.env.XDG_CONFIG_HOME,
  applicationPath = path.resolve("src-tauri/target/debug/tauri-explorer"),
): number {
  const application = fs.realpathSync(applicationPath);
  if (!config) throw new Error("renderer crash test requires an isolated XDG_CONFIG_HOME");
  const matches = processIds().filter(pid =>
    processExecutable(pid) === application
    && processEnvironment(pid).includes(`XDG_CONFIG_HOME=${config}`));
  if (matches.length !== 1) {
    throw new Error(`expected one exact test application, found ${matches.length}: ${matches.join(",")}`);
  }
  return matches[0];
}

export function terminateRendererDescendants(
  applicationPid: number,
  environment: Record<string, string>,
  expected?: { start: string; executable: string },
): number[] {
  const applicationStart = expected?.start ?? processStartTime(applicationPid);
  const applicationExecutable = expected?.executable
    ?? fs.realpathSync(path.resolve("src-tauri/target/debug/tauri-explorer"));
  if (!applicationStart || !applicationExecutable) throw new Error("Test application is not alive");
  const renderers = descendants(applicationPid)
    .filter(pid => path.basename(processExecutable(pid) ?? "") === "WebKitWebProcess")
    .map(pid => ({ pid, start: processStartTime(pid) }));
  if (renderers.length === 0) throw new Error("Exact test app has no WebKit renderer descendants");
  const helper = fileURLToPath(new URL("./kill-renderers.py", import.meta.url));
  return JSON.parse(execFileSync("python3", [helper, JSON.stringify({
    applicationPid, applicationStart, applicationExecutable, environment, renderers,
  })], { encoding: "utf8", timeout: 10_000 }));
}

export function isolatedProcessEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TAURI_E2E_RECOVERY_DIR"];
  if (!source.XDG_CONFIG_HOME) throw new Error("Native crash tests require an isolated XDG_CONFIG_HOME");
  return Object.fromEntries(keys.flatMap(key => source[key] ? [[key, source[key]!]] : []));
}

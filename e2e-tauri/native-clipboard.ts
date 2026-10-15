/** Independent platform clipboard probes for native smoke assertions. */
import { execFile, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function powershellClipboard(
  operation: string,
  script: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command",
      `$ErrorActionPreference = "Stop"; [Console]::Error.WriteLine("clipboard probe: PowerShell ready"); ${script}`], {
      env: environment,
      encoding: "utf8",
      // Includes cold PowerShell/module startup, not just the clipboard call.
      // Keep this below the native spec's 60-second deadline; never retry a probe.
      timeout: 30_000,
      killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (error) {
        // spawnSync errors can self-reference through `error`; WDIO stringifies
        // own properties and otherwise replaces the useful failure with a cycle.
        // Retain scalar diagnostics only, without attaching the original cause.
        reject(new Error(`${operation}: ${error.message}; code=${error.code}; signal=${error.signal}; stdout=${stdout.slice(-4096)}; stderr=${stderr.slice(-4096)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function readNativeClipboardPaths(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === "win32") {
    const output = await powershellClipboard("read Windows file clipboard",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName })');
    const paths: unknown = JSON.parse(output);
    if (!Array.isArray(paths) || !paths.every(value => typeof value === "string")) {
      throw new Error("Windows file clipboard probe did not return an array of paths");
    }
    return paths;
  }
  const text = execFileSync("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"], { encoding: "utf8", timeout: 10_000 });
  return text.trim().split(/\r?\n/).filter(line => !line.startsWith("#"))
    .map(uri => decodeURIComponent(new URL(uri).pathname));
}

export async function writeExternalClipboardCopy(file: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    await powershellClipboard("write external Windows file Copy",
      'Set-Clipboard -LiteralPath $env:CLIP_PATH',
      { ...process.env, CLIP_PATH: file });
  } else {
    // xclip forks a selection owner. Ignore its inherited pipes so completion
    // does not wait for that owner to lose the clipboard.
    execFileSync("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-i"],
      { input: `${pathToFileURL(file).href}\n`, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
  }
}

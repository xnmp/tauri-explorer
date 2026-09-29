import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "./native-qualification";

/** Put a deterministic long-running `gemini` ahead of the host PATH. */
export function installExternalJobFixture(environment: NodeJS.ProcessEnv): void {
  if (process.platform !== "linux") return;
  const directory = createNativeFixtureDirectory("external-job-", environment);
  const pidFile = path.join(directory, "gemini.pid");
  const executable = path.join(directory, "gemini");
  fs.writeFileSync(executable, `#!/usr/bin/env python3
import os
import pathlib
import time

pathlib.Path(os.environ["TAURI_E2E_EXTERNAL_JOB_PID"]).write_text(str(os.getpid()))
pathlib.Path("nanobanana-output").mkdir(exist_ok=True)
time.sleep(30)
pathlib.Path("nanobanana-output/late.png").write_text("late")
`);
  fs.chmodSync(executable, 0o755);
  environment.PATH = `${directory}${path.delimiter}${environment.PATH ?? ""}`;
  environment.TAURI_E2E_EXTERNAL_JOB_PID = pidFile;
  environment.TAURI_EXPLORER_E2E_PLUGIN_JOB_TIMEOUT_MS = "100";
}

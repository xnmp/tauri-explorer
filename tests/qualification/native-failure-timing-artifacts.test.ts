import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const workflowPath = new URL(
  "../../.github/workflows/e2e-tauri.yml",
  import.meta.url,
);

type WorkflowStep = {
  name?: string;
  run?: string;
};

type CaptureCase = {
  name: string;
  logName: string;
  timingName: string;
  command: string;
  platform: "Linux" | "Windows";
};

const captureCases: CaptureCase[] = [
  {
    name: "Run native contracts",
    logName: "native-contracts.log",
    timingName: "native-contracts-timing.txt",
    command: "bun run check:e2e:tauri",
    platform: "Linux",
  },
  {
    name: "Build Tauri binary (debug, embedded frontend, no bundle)",
    logName: "tauri-build.log",
    timingName: "tauri-build-timing.txt",
    command: "bun run tauri build --debug --no-bundle",
    platform: "Linux",
  },
  {
    name: "Build Tauri binary (debug, embedded frontend, no bundle)",
    logName: "tauri-build.log",
    timingName: "tauri-build-timing.txt",
    command: "bun run tauri build --debug --no-bundle",
    platform: "Windows",
  },
];

async function captureStep(name: string): Promise<string> {
  const workflow = parse(await readFile(workflowPath, "utf8")) as {
    jobs: { smoke: { steps: WorkflowStep[] } };
  };
  const step = workflow.jobs.smoke.steps.find(
    (candidate) => candidate.name === name,
  );

  expect(step?.run, `workflow capture step ${name}`).toBeDefined();
  return step!.run!;
}

async function runCapture(step: string, exitStatus: number, platform: string): Promise<{ code: number; directory: string; stderr?: string }> {
  const directory = await mkdtemp(join(tmpdir(), "native-failure-timing-"));
  // Execute the production shell unchanged. Replacing its command with a regex
  // bypassed new platform branches; a PATH stub retains both real pipelines.
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "bun"), '#!/bin/sh\nprintf "capture-marker-%s\\n" "$NATIVE_CAPTURE_STATUS"\nexit "$NATIVE_CAPTURE_STATUS"\n', { mode: 0o755 });

  try {
    const result = await execFileAsync("bash", ["-e", "-o", "pipefail", "-c", `mkdir -p native-contract-diagnostics\n${step}`], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_OS: platform, NATIVE_CAPTURE_STATUS: String(exitStatus) },
    });
    return { code: 0, directory, stderr: result.stderr };
  } catch (error) {
    const code = (error as { code?: number }).code;
    return { code: typeof code === "number" ? code : 1, directory };
  }
}

describe("native capture timing artifacts under Bash errexit (#697)", () => {
  for (const captureCase of captureCases) {
    it(`${captureCase.name} (${captureCase.platform}) records a successful command`, async () => {
      const result = await runCapture(await captureStep(captureCase.name), 0, captureCase.platform);
      const directory = result.directory;

      try {
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(
          await readFile(
            join(directory, "native-contract-diagnostics", captureCase.logName),
            "utf8",
          ),
        ).toContain("capture-marker-0");
        const timing = await readFile(
          join(directory, "native-contract-diagnostics", captureCase.timingName),
          "utf8",
        );
        expect(timing).toContain(`command=${captureCase.command}`);
        expect(timing).toMatch(
          /started_at=.+\nfinished_at=.+\nexit_status=0\n/,
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });

    it(`${captureCase.name} (${captureCase.platform}) records a failed command before returning its status`, async () => {
      const exitStatus = 37;
      const result = await runCapture(
        await captureStep(captureCase.name), exitStatus, captureCase.platform,
      );

      try {
        expect(result.code).toBe(exitStatus);
        expect(
          await readFile(
            join(result.directory, "native-contract-diagnostics", captureCase.logName),
            "utf8",
          ),
        ).toContain(`capture-marker-${exitStatus}`);
        const timing = await readFile(
          join(
            result.directory,
            "native-contract-diagnostics",
            captureCase.timingName,
          ),
          "utf8",
        );
        expect(timing).toContain(`command=${captureCase.command}`);
        expect(timing).toMatch(
          new RegExp(`started_at=.+\\nfinished_at=.+\\nexit_status=${exitStatus}\\n`),
        );
      } finally {
        await rm(result.directory, { force: true, recursive: true });
      }
    });
  }
});
